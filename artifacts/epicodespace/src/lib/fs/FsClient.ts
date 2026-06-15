/**
 * FsClient — main-thread façade for the OPFS worker.
 *
 * Responsibilities beyond a plain `Comlink.wrap`:
 *  1. Lifecycle: spawn the worker lazily on first call; respawn it after
 *     iPadOS BFCache (pagehide → pageshow kills the worker in Safari).
 *  2. Heartbeat: a lightweight ping every 15 s so we notice a dead worker
 *     before the user's next file op.
 *  3. Error normalisation: rehydrate plain objects thrown over Comlink
 *     back into the `FsError` shape app code expects.
 *  4. Single-flight `init()`: every op waits on the same initialisation
 *     promise so we never race a half-booted worker.
 *
 * This module intentionally keeps ZERO UI concerns. All toasts, confirms,
 * and progress surfaces belong to the caller.
 */

import * as Comlink from 'comlink';
import type { FsWorkerApi, FsError } from './types.ts';
import { isFsError, fsError } from './types.ts';
import { logger } from '../logger.js';

const HEARTBEAT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 4_000;

type Remote = Comlink.Remote<FsWorkerApi>;

interface Session {
  worker: Worker;
  remote: Remote;
  ready: Promise<void>;
  heartbeat: ReturnType<typeof setInterval> | null;
  dead: boolean;
}

let session: Session | null = null;
let spawnLock: Promise<Session> | null = null;

function spawnWorker(): Worker {
  // Vite 6 syntax — `new URL(..., import.meta.url)` is what makes this
  // bundled correctly as a module worker in production.
  return new Worker(new URL('./fs.worker.ts', import.meta.url), {
    type: 'module',
    name: 'epicode-fs',
  });
}

async function openSession(): Promise<Session> {
  if (spawnLock) return spawnLock;

  spawnLock = (async () => {
    const worker = spawnWorker();
    const remote = Comlink.wrap<FsWorkerApi>(worker);

    worker.addEventListener('error', (e) => {
      logger.error('fs', 'worker error', { message: e.message, filename: e.filename });
      if (session) session.dead = true;
    });
    worker.addEventListener('messageerror', () => {
      logger.error('fs', 'worker messageerror');
      if (session) session.dead = true;
    });

    const ready = (async () => {
      try {
        await remote.init();
      } catch (err) {
        logger.error('fs', 'worker init failed', { err });
        throw normalise(err);
      }
    })();

    const s: Session = { worker, remote, ready, heartbeat: null, dead: false };
    s.heartbeat = setInterval(() => void heartbeat(s), HEARTBEAT_MS);
    session = s;
    return s;
  })();

  try {
    return await spawnLock;
  } finally {
    spawnLock = null;
  }
}

async function heartbeat(s: Session): Promise<void> {
  if (s.dead) return;
  try {
    await Promise.race([
      s.remote.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('heartbeat timeout')), HEARTBEAT_TIMEOUT_MS)),
    ]);
  } catch (err) {
    logger.warn('fs', 'heartbeat failed — marking dead', { err: String(err) });
    s.dead = true;
    teardown(s);
  }
}

function teardown(s: Session): void {
  if (s.heartbeat) clearInterval(s.heartbeat);
  s.heartbeat = null;
  try { s.worker.terminate(); } catch { /* ignore */ }
  if (session === s) session = null;
}

async function getSession(): Promise<Session> {
  if (session && !session.dead) {
    await session.ready;
    return session;
  }
  if (session?.dead) teardown(session);
  const s = await openSession();
  await s.ready;
  return s;
}

// Safari kills workers across BFCache. When the page comes back, we force
// a respawn on the next op rather than calling the now-dead remote.
function wireLifecycle(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('pagehide', () => {
    if (session) {
      logger.info('fs', 'pagehide: marking worker dead');
      session.dead = true;
    }
  });
  window.addEventListener('pageshow', (e) => {
    // `persisted` === true means BFCache restoration.
    if (e.persisted && session) {
      logger.info('fs', 'pageshow(persisted): forcing worker respawn');
      teardown(session);
    }
  });
}
wireLifecycle();

// ─── Error normalisation ──────────────────────────────────────────────────

function normalise(err: unknown): FsError {
  if (isFsError(err)) return err;
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code: string; message: string };
    return fsError(e.code as FsError['code'], e.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return fsError('EIO', msg);
}

// ─── Call wrapper with one-shot respawn-on-dead ──────────────────────────

async function call<T>(op: (r: Remote) => Promise<T>): Promise<T> {
  let s = await getSession();
  try {
    return await op(s.remote);
  } catch (err) {
    // If the worker died mid-call, respawn once and retry.
    const isDeadWorker = err instanceof Error && /terminated|closed/i.test(err.message);
    if (isDeadWorker) {
      logger.warn('fs', 'op failed because worker died; retrying once');
      teardown(s);
      s = await getSession();
      try {
        return await op(s.remote);
      } catch (err2) {
        throw normalise(err2);
      }
    }
    throw normalise(err);
  }
}

// ─── Public, typed API ───────────────────────────────────────────────────

export const FsClient = {
  async init() {
    const s = await getSession();
    return call(() => s.remote.init());
  },
  usage() { return call((r) => r.usage()); },
  list(path: string) { return call((r) => r.list(path)); },
  stat(path: string) { return call((r) => r.stat(path)); },
  exists(path: string) { return call((r) => r.exists(path)); },
  mkdir(path: string) { return call((r) => r.mkdir(path)); },
  remove(path: string, opts?: { recursive?: boolean }) { return call((r) => r.remove(path, opts)); },
  rename(from: string, to: string) { return call((r) => r.rename(from, to)); },
  readText(path: string, opts?: { maxBytes?: number }) { return call((r) => r.readText(path, opts)); },
  async readChunk(path: string, offset: number, length: number) {
    return call((r) => r.readChunk(path, offset, length));
  },
  writeText(path: string, text: string) { return call((r) => r.writeText(path, text)); },
  writeStreamOpen(path: string) { return call((r) => r.writeStreamOpen(path)); },
  async writeStreamAppend(handle: string, chunk: ArrayBuffer) {
    // Transfer the buffer so we don't pay a copy on large writes.
    return call((r) => r.writeStreamAppend(handle, Comlink.transfer(chunk, [chunk])));
  },
  writeStreamClose(handle: string) { return call((r) => r.writeStreamClose(handle)); },
  writeStreamAbort(handle: string) { return call((r) => r.writeStreamAbort(handle)); },

  // Escape hatches for tests / shutdown.
  _isAlive() { return !!session && !session.dead; },
  async _dispose() { if (session) teardown(session); },
};

export type { FsError } from './types.ts';
