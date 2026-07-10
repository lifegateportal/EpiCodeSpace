import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  S3Client,
  GetObjectCommand,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';

const router = Router();

const PREFIX = 'epicodespace/repos/';
const CACHE_ROOT = process.env.EPICODESPACE_GIT_CACHE_DIR || '/tmp/epicodespace-git-cache';

type RepoRevisionMeta = {
  id: string;
  payloadKey: string;
};

type RepoMeta = {
  latestRevisionId: string | null;
  revisions: RepoRevisionMeta[];
};

type RepoFileEntry =
  | string
  | {
      content?: unknown;
    };

type RepoPayload = {
  files?: Record<string, RepoFileEntry>;
};

function sanitizeSegment(raw: string, fallback: string): string {
  const value = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return value || fallback;
}

function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function bucket(): string {
  return process.env.R2_BUCKET_NAME ?? '';
}

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

function configured(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME
  );
}

async function readBodyString(data: GetObjectCommandOutput): Promise<string> {
  return await (data.Body as { transformToString(): Promise<string> }).transformToString();
}

async function readJson<T>(client: S3Client, key: string): Promise<T | null> {
  try {
    const data = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    const raw = await readBodyString(data);
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey') return null;
    throw err;
  }
}

function repoMetaKey(owner: string, slug: string): string {
  return `${PREFIX}${owner}/${slug}/meta.json`;
}

function safeRepoPath(root: string, relPath: string): string | null {
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('..') || cleaned.includes('\0')) return null;
  const full = path.resolve(root, cleaned);
  if (!full.startsWith(path.resolve(root) + path.sep) && full !== path.resolve(root)) return null;
  return full;
}

function fileContent(entry: RepoFileEntry): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && 'content' in entry) {
    const value = (entry as { content?: unknown }).content;
    if (typeof value === 'string') return value;
    if (value == null) return '';
    return String(value);
  }
  return '';
}

async function runGit(args: string[], opts?: { cwd?: string; input?: Buffer }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts?.cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'EpiCodeSpace',
        GIT_AUTHOR_EMAIL: 'noreply@epicodespace.local',
        GIT_COMMITTER_NAME: 'EpiCodeSpace',
        GIT_COMMITTER_EMAIL: 'noreply@epicodespace.local',
      },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
      } else {
        reject(new Error(`git ${args.join(' ')} failed (${code}): ${Buffer.concat(stderrChunks).toString('utf8')}`));
      }
    });

    if (opts?.input) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

async function ensureGitMirror(owner: string, slug: string): Promise<string | null> {
  const client = makeClient();
  if (!client || !bucket() || !configured()) return null;

  const meta = await readJson<RepoMeta>(client, repoMetaKey(owner, slug));
  if (!meta || !meta.latestRevisionId) return null;

  const latest = meta.revisions.find((item) => item.id === meta.latestRevisionId);
  if (!latest) return null;

  const payload = await readJson<RepoPayload>(client, latest.payloadKey);
  if (!payload) return null;

  const workDir = path.join(CACHE_ROOT, owner, slug);
  const bareDir = `${workDir}.git`;
  const markerFile = path.join(bareDir, '.epic-latest-revision');

  try {
    const marker = await fs.readFile(markerFile, 'utf8');
    if (marker.trim() === latest.id) return bareDir;
  } catch {
    // cache miss/stale
  }

  await fs.rm(workDir, { recursive: true, force: true });
  await fs.rm(bareDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  const entries = Object.entries(payload.files || {});
  for (const [relPath, entry] of entries) {
    const fullPath = safeRepoPath(workDir, relPath);
    if (!fullPath) continue;
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, fileContent(entry), 'utf8');
  }

  await runGit(['init', '--initial-branch=main'], { cwd: workDir });
  await runGit(['add', '-A'], { cwd: workDir });
  await runGit(['commit', '--allow-empty', '-m', `EpiCodeSpace snapshot ${latest.id}`], { cwd: workDir });
  await runGit(['clone', '--bare', workDir, bareDir]);
  await fs.writeFile(markerFile, `${latest.id}\n`, 'utf8');

  return bareDir;
}

function pktLine(data: string): string {
  const byteLen = Buffer.byteLength(data);
  const total = byteLen + 4;
  return total.toString(16).padStart(4, '0') + data;
}

async function rawBody(req: Request): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

router.get('/:owner/:slug/info/refs', async (req: Request, res: Response) => {
  if (req.query.service !== 'git-upload-pack') {
    res.status(400).send('Unsupported git service');
    return;
  }

  const owner = sanitizeSegment(routeParam(req.params.owner), 'owner');
  const slug = sanitizeSegment(routeParam(req.params.slug), 'project');

  try {
    const bareDir = await ensureGitMirror(owner, slug);
    if (!bareDir) {
      res.status(404).send('Repository not found');
      return;
    }

    const advertised = await runGit(['upload-pack', '--stateless-rpc', '--advertise-refs', bareDir]);
    const prelude = Buffer.from(pktLine('# service=git-upload-pack\n') + '0000', 'utf8');

    res.status(200);
    res.setHeader('Content-Type', 'application/x-git-upload-pack-advertisement');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(Buffer.concat([prelude, advertised]));
  } catch (err: unknown) {
    res.status(500).send((err as Error).message || 'Failed to serve git refs');
  }
});

router.post('/:owner/:slug/git-upload-pack', async (req: Request, res: Response) => {
  const owner = sanitizeSegment(routeParam(req.params.owner), 'owner');
  const slug = sanitizeSegment(routeParam(req.params.slug), 'project');

  try {
    const bareDir = await ensureGitMirror(owner, slug);
    if (!bareDir) {
      res.status(404).send('Repository not found');
      return;
    }

    const input = await rawBody(req);
    const output = await runGit(['upload-pack', '--stateless-rpc', bareDir], { input });

    res.status(200);
    res.setHeader('Content-Type', 'application/x-git-upload-pack-result');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(output);
  } catch (err: unknown) {
    res.status(500).send((err as Error).message || 'Failed to serve git pack');
  }
});

router.get('/:owner/:slug', async (req: Request, res: Response) => {
  const owner = sanitizeSegment(routeParam(req.params.owner), 'owner');
  const slug = sanitizeSegment(routeParam(req.params.slug), 'project');
  const host = req.get('host') || 'localhost';
  const proto = req.get('x-forwarded-proto') || req.protocol;
  res.status(200).json({
    ok: true,
    message: 'EpiCodeSpace snapshot repository endpoint',
    clone: `${proto}://${host}/r/${owner}/${slug}`,
  });
});

export default router;
