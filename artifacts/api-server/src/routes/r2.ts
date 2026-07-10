import { Router, type Request, type Response } from 'express';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const router = Router();

const PREFIX = 'epicodespace/';
const WORKSPACE_PREFIX = `${PREFIX}workspaces/`;

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

function normalizeSaveKey(raw: string): string {
  const text = String(raw || '').trim().replace(/\\/g, '/');
  const withoutPrefix = text.startsWith(PREFIX) ? text.slice(PREFIX.length) : text;
  const cleaned = withoutPrefix
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => seg.replace(/[^a-zA-Z0-9._-]/g, '_'))
    .join('/');

  if (!cleaned) return '';
  if (cleaned.startsWith('workspaces/')) return cleaned;
  return `workspaces/${cleaned}`;
}

function isWorkspaceKey(strippedKey: string): boolean {
  if (strippedKey.startsWith('repos/')) return false;
  if (strippedKey.startsWith('workspaces/')) return true;
  // Legacy flat keys like "MyProject/latest.json" are workspace saves.
  return strippedKey.includes('/') && strippedKey.endsWith('.json');
}

function toSaveRecord(keyWithPrefix: string, size: number, lastModified: string) {
  const stripped = keyWithPrefix.startsWith(PREFIX) ? keyWithPrefix.slice(PREFIX.length) : keyWithPrefix;
  return {
    key: stripped,
    path: stripped,
    size,
    lastModified,
  };
}

function legacySafeKey(raw: string): string {
  return String(raw || '').trim().replace(/\\/g, '/').replace(/[^a-zA-Z0-9._\-/]/g, '_');
}

function candidateObjectKeys(raw: string): string[] {
  const out = new Set<string>();
  const normalized = normalizeSaveKey(raw);
  if (normalized) out.add(`${PREFIX}${normalized}`);

  const legacy = legacySafeKey(raw);
  if (legacy) {
    if (legacy.startsWith(PREFIX)) out.add(legacy);
    else out.add(`${PREFIX}${legacy}`);
  }

  return Array.from(out);
}

/** GET /api/r2/status — check if R2 env vars are set */
router.get('/r2/status', (_req: Request, res: Response) => {
  if (!configured()) {
    res.status(503).json({
      ok: false,
      error: 'R2 not configured. Add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME as Replit secrets.',
    });
    return;
  }
  res.json({ ok: true, bucket: bucket() });
});

/** GET /api/r2/saves — list all saves (newest first) */
router.get('/r2/saves', async (_req: Request, res: Response) => {
  const client = makeClient();
  if (!client || !bucket()) { res.status(503).json({ ok: false, error: 'R2 not configured.' }); return; }
  try {
    const [workspaceData, rootData] = await Promise.all([
      client.send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: WORKSPACE_PREFIX })),
      client.send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: PREFIX })),
    ]);

    const byKey = new Map<string, { key: string; path: string; size: number; lastModified: string }>();

    for (const o of workspaceData.Contents ?? []) {
      const fullKey = o.Key || '';
      if (!fullKey || !fullKey.endsWith('.json')) continue;
      const rec = toSaveRecord(fullKey, o.Size ?? 0, o.LastModified?.toISOString() ?? '');
      byKey.set(rec.key, rec);
    }

    for (const o of rootData.Contents ?? []) {
      const fullKey = o.Key || '';
      if (!fullKey || !fullKey.endsWith('.json')) continue;
      const stripped = fullKey.slice(PREFIX.length);
      if (!isWorkspaceKey(stripped)) continue;
      const rec = toSaveRecord(fullKey, o.Size ?? 0, o.LastModified?.toISOString() ?? '');
      byKey.set(rec.key, rec);
    }

    const saves = Array.from(byKey.values())
      .filter((s) => s.key)
      .sort((a, b) => {
        const at = Date.parse(a.lastModified || '');
        const bt = Date.parse(b.lastModified || '');
        return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
      });
    res.json({ ok: true, saves });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message ?? 'Failed to list saves.' });
  }
});

/** POST /api/r2/save — body: { key: string, payload: object } */
router.post('/r2/save', async (req: Request, res: Response) => {
  const client = makeClient();
  if (!client || !bucket()) { res.status(503).json({ ok: false, error: 'R2 not configured.' }); return; }
  const { key, payload } = req.body as { key?: string; payload?: unknown };
  if (!key || payload === undefined) { res.status(400).json({ ok: false, error: 'key and payload required.' }); return; }
  const safeKey = normalizeSaveKey(key);
  if (!safeKey) { res.status(400).json({ ok: false, error: 'Invalid key.' }); return; }
  try {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    await client.send(new PutObjectCommand({
      Bucket: bucket(),
      Key: `${PREFIX}${safeKey}`,
      Body: body,
      ContentType: 'application/json',
    }));
    res.json({ ok: true, key: safeKey });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message ?? 'Save failed.' });
  }
});

/** GET /api/r2/load?key=… */
router.get('/r2/load', async (req: Request, res: Response) => {
  const client = makeClient();
  if (!client || !bucket()) { res.status(503).json({ ok: false, error: 'R2 not configured.' }); return; }
  const rawKey = typeof req.query.key === 'string' ? req.query.key : '';
  const candidates = candidateObjectKeys(rawKey);
  if (!candidates.length) { res.status(400).json({ ok: false, error: 'key required.' }); return; }
  try {
    let lastErr: unknown = null;
    for (const objectKey of candidates) {
      try {
        const data = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: objectKey }));
        const raw = await (data.Body as { transformToString(): Promise<string> }).transformToString();
        res.json({ ok: true, payload: JSON.parse(raw) });
        return;
      } catch (err: unknown) {
        lastErr = err;
        const name = (err as { name?: string }).name;
        if (name !== 'NoSuchKey') throw err;
      }
    }
    const name = (lastErr as { name?: string } | null)?.name;
    if (name === 'NoSuchKey' || !lastErr) { res.status(404).json({ ok: false, error: 'Save not found.' }); return; }
    throw lastErr;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey') { res.status(404).json({ ok: false, error: 'Save not found.' }); return; }
    res.status(500).json({ ok: false, error: (err as Error).message ?? 'Load failed.' });
  }
});

/** DELETE /api/r2/save?key=… */
router.delete('/r2/save', async (req: Request, res: Response) => {
  const client = makeClient();
  if (!client || !bucket()) { res.status(503).json({ ok: false, error: 'R2 not configured.' }); return; }
  const rawKey = typeof req.query.key === 'string' ? req.query.key : '';
  const candidates = candidateObjectKeys(rawKey);
  if (!candidates.length) { res.status(400).json({ ok: false, error: 'key required.' }); return; }
  try {
    let deleted = false;
    for (const objectKey of candidates) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket(), Key: objectKey }));
        deleted = true;
      } catch (err: unknown) {
        const name = (err as { name?: string }).name;
        if (name !== 'NoSuchKey') throw err;
      }
    }
    if (!deleted) {
      res.status(404).json({ ok: false, error: 'Save not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message ?? 'Delete failed.' });
  }
});

export default router;
