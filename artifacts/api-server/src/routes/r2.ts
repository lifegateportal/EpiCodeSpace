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
    const data = await client.send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: PREFIX }));
    const saves = (data.Contents ?? [])
      .map(o => ({
        key: o.Key?.slice(PREFIX.length) ?? '',
        size: o.Size ?? 0,
        lastModified: o.LastModified?.toISOString() ?? '',
      }))
      .filter(s => s.key)
      .sort((a, b) => (b.lastModified > a.lastModified ? 1 : -1));
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
  const safeKey = key.replace(/[^a-zA-Z0-9._\-/]/g, '_');
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
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  if (!key) { res.status(400).json({ ok: false, error: 'key required.' }); return; }
  try {
    const data = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: `${PREFIX}${key}` }));
    const raw = await (data.Body as { transformToString(): Promise<string> }).transformToString();
    res.json({ ok: true, payload: JSON.parse(raw) });
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
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  if (!key) { res.status(400).json({ ok: false, error: 'key required.' }); return; }
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket(), Key: `${PREFIX}${key}` }));
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message ?? 'Delete failed.' });
  }
});

export default router;
