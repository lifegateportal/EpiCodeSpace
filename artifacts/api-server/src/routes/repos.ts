import { Router, type Request, type Response } from 'express';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type _Object,
} from '@aws-sdk/client-s3';

const router = Router();

const PREFIX = 'epicodespace/repos/';

type RepoVisibility = 'private' | 'unlisted' | 'public';

type RepoRevisionMeta = {
  id: string;
  parentId: string | null;
  createdAt: string;
  message: string;
  fileCount: number;
  payloadKey: string;
};

type RepoMeta = {
  owner: string;
  slug: string;
  projectName: string;
  visibility: RepoVisibility;
  createdAt: string;
  updatedAt: string;
  latestRevisionId: string | null;
  revisions: RepoRevisionMeta[];
  repoUrl: string;
};

type RepoPayload = {
  projectName: string;
  owner: string;
  slug: string;
  repoUrl: string;
  savedAt: string;
  files: Record<string, unknown>;
};

function makeClient(): S3Client | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function bucket(): string {
  return process.env.R2_BUCKET_NAME ?? '';
}

function configured(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME
  );
}

function sanitizeSegment(raw: string, fallback: string): string {
  const value = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return value || fallback;
}

function repoMetaKey(owner: string, slug: string): string {
  return `${PREFIX}${owner}/${slug}/meta.json`;
}

function revisionPayloadKey(owner: string, slug: string, revisionId: string): string {
  return `${PREFIX}${owner}/${slug}/revisions/${revisionId}.json`;
}

function makeRevisionId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function publicBase(req: Request): string {
  const explicit = process.env.EPICODESPACE_PUBLIC_URL || process.env.APP_PUBLIC_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host') || 'localhost'}`;
}

function repoPublicUrl(req: Request, owner: string, slug: string): string {
  return `${publicBase(req)}/r/${owner}/${slug}`;
}

function repoRevisionUrl(req: Request, owner: string, slug: string, revisionId: string): string {
  return `${publicBase(req)}/r/${owner}/${slug}/rev/${revisionId}`;
}

async function objectExists(client: S3Client, key: string): Promise<boolean> {
  try {
    await client.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey') return false;
    throw err;
  }
}

async function readJson<T>(client: S3Client, key: string): Promise<T | null> {
  try {
    const data = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    const raw = await (data.Body as { transformToString(): Promise<string> }).transformToString();
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey') return null;
    throw err;
  }
}

async function writeJson(client: S3Client, key: string, payload: unknown): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: JSON.stringify(payload),
      ContentType: 'application/json',
    }),
  );
}

function normalizeVisibility(value: string): RepoVisibility {
  if (value === 'public' || value === 'unlisted') return value;
  return 'private';
}

router.get('/repos/status', (_req: Request, res: Response) => {
  if (!configured()) {
    res.status(503).json({
      ok: false,
      error: 'R2 not configured. Add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME.',
    });
    return;
  }
  res.json({ ok: true, bucket: bucket() });
});

router.get('/repos', async (req: Request, res: Response) => {
  const client = makeClient();
  if (!client || !bucket()) {
    res.status(503).json({ ok: false, error: 'R2 not configured.' });
    return;
  }

  const owner = sanitizeSegment(String(req.query.owner || ''), 'owner');
  const prefix = `${PREFIX}${owner}/`;

  try {
    const data = await client.send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix }));
    const metaKeys = (data.Contents || [])
      .map((entry: _Object) => entry.Key || '')
      .filter((key: string) => key.endsWith('/meta.json'));

    const repos: RepoMeta[] = [];
    for (const key of metaKeys) {
      const meta = await readJson<RepoMeta>(client, key);
      if (meta) repos.push(meta);
    }

    repos.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    res.json({ ok: true, repos });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message || 'Failed to list repos.' });
  }
});

router.post('/repos', async (req: Request, res: Response) => {
  const client = makeClient();
  if (!client || !bucket()) {
    res.status(503).json({ ok: false, error: 'R2 not configured.' });
    return;
  }

  const body = req.body as {
    owner?: string;
    slug?: string;
    visibility?: string;
    projectName?: string;
    files?: Record<string, unknown>;
    repoUrl?: string;
    message?: string;
  };

  const owner = sanitizeSegment(body.owner || '', 'owner');
  const slug = sanitizeSegment(body.slug || body.projectName || '', 'project');
  const visibility = normalizeVisibility(String(body.visibility || 'private'));
  const projectName = String(body.projectName || slug);
  const files = body.files && typeof body.files === 'object' ? body.files : {};
  const now = new Date().toISOString();

  const metaKey = repoMetaKey(owner, slug);

  try {
    if (await objectExists(client, metaKey)) {
      res.status(409).json({ ok: false, error: 'Repo already exists.' });
      return;
    }

    const revisionId = makeRevisionId();
    const payloadKey = revisionPayloadKey(owner, slug, revisionId);
    const repoUrl = repoPublicUrl(req, owner, slug);

    const payload: RepoPayload = {
      projectName,
      owner,
      slug,
      repoUrl,
      savedAt: now,
      files,
    };

    const revision: RepoRevisionMeta = {
      id: revisionId,
      parentId: null,
      createdAt: now,
      message: String(body.message || 'Initial revision'),
      fileCount: Object.keys(files).length,
      payloadKey,
    };

    const meta: RepoMeta = {
      owner,
      slug,
      projectName,
      visibility,
      createdAt: now,
      updatedAt: now,
      latestRevisionId: revisionId,
      revisions: [revision],
      repoUrl,
    };

    await writeJson(client, payloadKey, payload);
    await writeJson(client, metaKey, meta);

    res.status(201).json({
      ok: true,
      repo: meta,
      revision,
      urls: {
        repo: repoUrl,
        revision: repoRevisionUrl(req, owner, slug, revisionId),
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message || 'Create repo failed.' });
  }
});

router.get('/repos/:owner/:slug', async (req: Request, res: Response) => {
  const client = makeClient();
  if (!client || !bucket()) {
    res.status(503).json({ ok: false, error: 'R2 not configured.' });
    return;
  }

  const owner = sanitizeSegment(req.params.owner, 'owner');
  const slug = sanitizeSegment(req.params.slug, 'project');

  try {
    const meta = await readJson<RepoMeta>(client, repoMetaKey(owner, slug));
    if (!meta) {
      res.status(404).json({ ok: false, error: 'Repo not found.' });
      return;
    }
    res.json({ ok: true, repo: meta });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message || 'Failed to load repo.' });
  }
});

router.post('/repos/:owner/:slug/revisions', async (req: Request, res: Response) => {
  const client = makeClient();
  if (!client || !bucket()) {
    res.status(503).json({ ok: false, error: 'R2 not configured.' });
    return;
  }

  const owner = sanitizeSegment(req.params.owner, 'owner');
  const slug = sanitizeSegment(req.params.slug, 'project');

  const body = req.body as {
    files?: Record<string, unknown>;
    projectName?: string;
    repoUrl?: string;
    message?: string;
  };

  const files = body.files && typeof body.files === 'object' ? body.files : {};
  const now = new Date().toISOString();

  try {
    const metaKey = repoMetaKey(owner, slug);
    const meta = await readJson<RepoMeta>(client, metaKey);
    if (!meta) {
      res.status(404).json({ ok: false, error: 'Repo not found.' });
      return;
    }

    const revisionId = makeRevisionId();
    const payloadKey = revisionPayloadKey(owner, slug, revisionId);
    const parentId = meta.latestRevisionId;

    const payload: RepoPayload = {
      projectName: String(body.projectName || meta.projectName),
      owner,
      slug,
      repoUrl: String(body.repoUrl || meta.repoUrl || repoPublicUrl(req, owner, slug)),
      savedAt: now,
      files,
    };

    const revision: RepoRevisionMeta = {
      id: revisionId,
      parentId,
      createdAt: now,
      message: String(body.message || 'Save revision'),
      fileCount: Object.keys(files).length,
      payloadKey,
    };

    meta.latestRevisionId = revisionId;
    meta.updatedAt = now;
    meta.projectName = String(body.projectName || meta.projectName);
    meta.revisions.push(revision);

    await writeJson(client, payloadKey, payload);
    await writeJson(client, metaKey, meta);

    res.status(201).json({
      ok: true,
      repo: meta,
      revision,
      urls: {
        repo: meta.repoUrl || repoPublicUrl(req, owner, slug),
        revision: repoRevisionUrl(req, owner, slug, revisionId),
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message || 'Save revision failed.' });
  }
});

router.get('/repos/:owner/:slug/latest', async (req: Request, res: Response) => {
  const client = makeClient();
  if (!client || !bucket()) {
    res.status(503).json({ ok: false, error: 'R2 not configured.' });
    return;
  }

  const owner = sanitizeSegment(req.params.owner, 'owner');
  const slug = sanitizeSegment(req.params.slug, 'project');

  try {
    const meta = await readJson<RepoMeta>(client, repoMetaKey(owner, slug));
    if (!meta || !meta.latestRevisionId) {
      res.status(404).json({ ok: false, error: 'Repo or revision not found.' });
      return;
    }

    const revision = meta.revisions.find((item) => item.id === meta.latestRevisionId);
    if (!revision) {
      res.status(404).json({ ok: false, error: 'Latest revision missing.' });
      return;
    }

    const payload = await readJson<RepoPayload>(client, revision.payloadKey);
    if (!payload) {
      res.status(404).json({ ok: false, error: 'Revision payload missing.' });
      return;
    }

    res.json({ ok: true, repo: meta, revision, payload });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message || 'Failed to load latest revision.' });
  }
});

router.get('/repos/:owner/:slug/revisions/:revisionId', async (req: Request, res: Response) => {
  const client = makeClient();
  if (!client || !bucket()) {
    res.status(503).json({ ok: false, error: 'R2 not configured.' });
    return;
  }

  const owner = sanitizeSegment(req.params.owner, 'owner');
  const slug = sanitizeSegment(req.params.slug, 'project');
  const revisionId = sanitizeSegment(req.params.revisionId, 'revision');

  try {
    const meta = await readJson<RepoMeta>(client, repoMetaKey(owner, slug));
    if (!meta) {
      res.status(404).json({ ok: false, error: 'Repo not found.' });
      return;
    }

    const revision = meta.revisions.find((item) => item.id === revisionId);
    if (!revision) {
      res.status(404).json({ ok: false, error: 'Revision not found.' });
      return;
    }

    const payload = await readJson<RepoPayload>(client, revision.payloadKey);
    if (!payload) {
      res.status(404).json({ ok: false, error: 'Revision payload missing.' });
      return;
    }

    res.json({ ok: true, repo: meta, revision, payload });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message || 'Failed to load revision.' });
  }
});

export default router;
