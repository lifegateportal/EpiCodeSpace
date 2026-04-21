/**
 * OpfsDriver — the real filesystem implementation, running inside
 * `fs.worker.ts`. The main thread never imports this file directly; it
 * talks to us via Comlink.
 *
 * WebKit / iPadOS notes:
 *  - `createSyncAccessHandle()` is only valid inside a dedicated Worker.
 *    Using it on the main thread throws `InvalidStateError` on Safari.
 *  - There is no `move()` API on Safari yet (April 2026), so `rename` is
 *    implemented as `copy + remove` via sync access handles.
 *  - Sync access handles hold an exclusive lock on the file until
 *    `.close()` is called. Every code path below uses try/finally to
 *    guarantee release, otherwise a crashed write would wedge the file.
 */

import {
  FsEntry,
  FsStat,
  FsUsage,
  QUOTA_RESERVE_BYTES,
  STREAM_CHUNK_BYTES,
  fsError,
  WriteHandle,
} from '../types.ts';
import { basename, normalize, split, toFsError } from '../paths.ts';

type FsDirHandle = FileSystemDirectoryHandle;
type FsFileHandle = FileSystemFileHandle;
type SyncHandle = FileSystemSyncAccessHandle;

// In-progress streaming writes. Keyed by opaque handle string returned to
// the caller; the real SyncAccessHandle lives only inside the worker.
interface ActiveStream {
  finalPath: string;
  tmpPath: string;
  dir: FsDirHandle;
  tmpName: string;
  file: FsFileHandle;
  handle: SyncHandle;
  offset: number;
}
const streams = new Map<WriteHandle, ActiveStream>();
let streamCounter = 0;

// ─── Root access ──────────────────────────────────────────────────────────

let rootPromise: Promise<FsDirHandle> | null = null;
function getRoot(): Promise<FsDirHandle> {
  if (!rootPromise) {
    const nav = (self as unknown as { navigator: Navigator }).navigator;
    if (!nav?.storage?.getDirectory) {
      return Promise.reject(fsError('EUNSUPPORTED', 'OPFS is not available in this browser'));
    }
    rootPromise = nav.storage.getDirectory();
  }
  return rootPromise;
}

// ─── Traversal helpers ────────────────────────────────────────────────────

async function resolveDir(path: string, create = false): Promise<FsDirHandle> {
  const norm = normalize(path);
  let dir = await getRoot();
  if (!norm) return dir;
  for (const seg of norm.split('/')) {
    try {
      dir = await dir.getDirectoryHandle(seg, { create });
    } catch (err) {
      throw create ? toFsError(err, 'mkdir failed') : fsError('ENOENT', `no such directory: ${path}`);
    }
  }
  return dir;
}

async function resolveFile(path: string, create = false): Promise<{ dir: FsDirHandle; file: FsFileHandle; name: string }> {
  const [parent, name] = split(path);
  if (!name) throw fsError('EINVAL', 'empty filename');
  const dir = await resolveDir(parent, create);
  let file: FsFileHandle;
  try {
    file = await dir.getFileHandle(name, { create });
  } catch (err) {
    // On WebKit, asking for a file that is actually a directory throws TypeMismatchError
    const isTypeMismatch = err instanceof DOMException && err.name === 'TypeMismatchError';
    if (isTypeMismatch) throw fsError('EISDIR', `${path} is a directory`);
    throw create ? toFsError(err, 'open-for-write failed') : fsError('ENOENT', `no such file: ${path}`);
  }
  return { dir, file, name };
}

// ─── Capability probe ────────────────────────────────────────────────────

async function probeSyncAccess(): Promise<boolean> {
  try {
    const root = await getRoot();
    // Use a unique scratch name so we never race with user files.
    const probeName = `.ecs_probe_${Math.random().toString(36).slice(2)}`;
    const f = await root.getFileHandle(probeName, { create: true });
    try {
      const sah = await f.createSyncAccessHandle();
      sah.close();
      return true;
    } finally {
      try { await root.removeEntry(probeName); } catch { /* ignore */ }
    }
  } catch {
    return false;
  }
}

// ─── Public operations ───────────────────────────────────────────────────

export const OpfsDriver = {
  async init() {
    await getRoot(); // throws EUNSUPPORTED early if OPFS missing
    const supportsSyncAccess = await probeSyncAccess();
    if (!supportsSyncAccess) {
      throw fsError('EUNSUPPORTED', 'OPFS sync access handles are unavailable — cannot proceed safely');
    }
    return { driver: 'opfs' as const, supportsSyncAccess };
  },

  async usage(): Promise<FsUsage> {
    const nav = (self as unknown as { navigator: Navigator }).navigator;
    try {
      const est = await nav.storage.estimate();
      return {
        usage: est.usage ?? 0,
        quota: est.quota ?? 0,
        reserved: QUOTA_RESERVE_BYTES,
      };
    } catch (err) {
      throw toFsError(err, 'usage query failed');
    }
  },

  async list(dirPath: string): Promise<FsEntry[]> {
    const dir = await resolveDir(dirPath);
    const out: FsEntry[] = [];
    // Skip our internal `.tmp` files from user-visible listings.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [name, handle] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (name.endsWith('.__ecs_tmp__')) continue;
      out.push({
        name,
        path: dirPath ? `${dirPath}/${name}` : name,
        kind: handle.kind === 'directory' ? 'directory' : 'file',
      });
    }
    out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  },

  async stat(path: string): Promise<FsStat> {
    const norm = normalize(path);
    if (!norm) {
      return { name: '', path: '', kind: 'directory', size: 0, mtime: null };
    }
    const [parent, name] = split(norm);
    const dir = await resolveDir(parent);
    // Try file first; fall back to directory.
    try {
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      return { name, path: norm, kind: 'file', size: file.size, mtime: file.lastModified ?? null };
    } catch (err) {
      const notFound = err instanceof DOMException && err.name === 'NotFoundError';
      const wrongType = err instanceof DOMException && err.name === 'TypeMismatchError';
      if (wrongType) {
        // It's a directory.
        try {
          await dir.getDirectoryHandle(name);
          return { name, path: norm, kind: 'directory', size: 0, mtime: null };
        } catch {
          throw fsError('ENOENT', `no such entry: ${path}`);
        }
      }
      if (notFound) throw fsError('ENOENT', `no such entry: ${path}`);
      throw toFsError(err, 'stat failed');
    }
  },

  async exists(path: string): Promise<boolean> {
    try { await OpfsDriver.stat(path); return true; } catch { return false; }
  },

  async mkdir(path: string): Promise<void> {
    const norm = normalize(path);
    if (!norm) return;
    // resolveDir(create=true) walks and creates each segment.
    await resolveDir(norm, true);
  },

  async remove(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const [parent, name] = split(path);
    if (!name) throw fsError('EINVAL', 'cannot remove root');
    const dir = await resolveDir(parent);
    try {
      await dir.removeEntry(name, { recursive: !!opts.recursive });
    } catch (err) {
      const e = err as DOMException;
      if (e?.name === 'NotFoundError') throw fsError('ENOENT', `no such entry: ${path}`);
      if (e?.name === 'InvalidModificationError') throw fsError('ENOTDIR', `directory not empty: ${path}`);
      throw toFsError(err, 'remove failed');
    }
  },

  // ── Reads ─────────────────────────────────────────────────────────────

  async readText(path: string, opts: { maxBytes?: number } = {}): Promise<{ text: string; bytes: number; truncated: false }> {
    const { file } = await resolveFile(path);
    const blob = await file.getFile();
    const max = opts.maxBytes ?? 2 * 1024 * 1024;
    if (blob.size > max) {
      throw fsError('ETOOBIG', `file ${path} is ${blob.size} bytes (limit ${max}) — use readChunk`);
    }
    const text = await blob.text();
    return { text, bytes: blob.size, truncated: false };
  },

  async readChunk(path: string, offset: number, length: number): Promise<ArrayBuffer> {
    if (!Number.isFinite(offset) || offset < 0) throw fsError('EINVAL', 'offset must be >= 0');
    if (!Number.isFinite(length) || length <= 0 || length > 16 * 1024 * 1024) {
      throw fsError('EINVAL', 'length must be in (0, 16 MB]');
    }
    const { file } = await resolveFile(path);
    const blob = await file.getFile();
    // Slice is zero-copy in modern Safari; `arrayBuffer()` allocates a
    // fresh backing store that we can transfer back to the main thread.
    const slice = blob.slice(offset, offset + length);
    return await slice.arrayBuffer();
  },

  // ── Atomic text write ────────────────────────────────────────────────

  async writeText(path: string, text: string): Promise<{ bytes: number }> {
    await guardQuota(text.length * 2); // UTF-16 worst case; UTF-8 is usually smaller
    const [parent, name] = split(path);
    const dir = await resolveDir(parent, true);
    const tmpName = `${name}.__ecs_tmp__`;
    const finalName = name;

    // Write temp file using a sync access handle (fastest + atomic from
    // the worker's perspective). Clean up on any failure.
    const tmpHandle = await dir.getFileHandle(tmpName, { create: true });
    const sah = await tmpHandle.createSyncAccessHandle();
    let bytes = 0;
    try {
      const encoded = new TextEncoder().encode(text);
      bytes = encoded.byteLength;
      sah.truncate(0);
      sah.write(encoded, { at: 0 });
      sah.flush();
    } finally {
      sah.close();
    }

    // OPFS on WebKit has no `move()` yet → copy+delete.
    await copyWithin(dir, tmpName, finalName);
    try { await dir.removeEntry(tmpName); } catch { /* non-fatal — next call's temp will overwrite */ }
    return { bytes };
  },

  // ── Streaming writes ─────────────────────────────────────────────────

  async writeStreamOpen(path: string): Promise<WriteHandle> {
    const [parent, name] = split(path);
    const dir = await resolveDir(parent, true);
    const tmpName = `${name}.__ecs_tmp__`;
    const tmp = await dir.getFileHandle(tmpName, { create: true });
    const sah = await tmp.createSyncAccessHandle();
    try {
      sah.truncate(0);
    } catch (err) {
      sah.close();
      throw toFsError(err, 'truncate failed');
    }
    const handle = `w${++streamCounter}`;
    streams.set(handle, { finalPath: path, tmpPath: `${parent}/${tmpName}`, dir, tmpName, file: tmp, handle: sah, offset: 0 });
    return handle;
  },

  async writeStreamAppend(handle: WriteHandle, chunk: ArrayBuffer): Promise<{ written: number }> {
    const s = streams.get(handle);
    if (!s) throw fsError('EINVAL', `unknown stream handle: ${handle}`);
    if (chunk.byteLength === 0) return { written: 0 };
    if (chunk.byteLength > STREAM_CHUNK_BYTES * 4) {
      // Soft cap: caller should split — protects worker event loop.
      throw fsError('EINVAL', `chunk too large (${chunk.byteLength}); split into <= ${STREAM_CHUNK_BYTES * 4} bytes`);
    }
    try {
      s.handle.write(new Uint8Array(chunk), { at: s.offset });
      s.offset += chunk.byteLength;
      return { written: chunk.byteLength };
    } catch (err) {
      // Clean up on any IO failure so the handle doesn't leak.
      await OpfsDriver.writeStreamAbort(handle).catch(() => { /* already cleaning */ });
      throw toFsError(err, 'append failed');
    }
  },

  async writeStreamClose(handle: WriteHandle): Promise<{ bytes: number }> {
    const s = streams.get(handle);
    if (!s) throw fsError('EINVAL', `unknown stream handle: ${handle}`);
    streams.delete(handle);
    const bytes = s.offset;
    try {
      s.handle.flush();
    } finally {
      s.handle.close();
    }
    // Rename temp → final.
    await copyWithin(s.dir, s.tmpName, basename(s.finalPath));
    try { await s.dir.removeEntry(s.tmpName); } catch { /* non-fatal */ }
    return { bytes };
  },

  async writeStreamAbort(handle: WriteHandle): Promise<void> {
    const s = streams.get(handle);
    if (!s) return;
    streams.delete(handle);
    try { s.handle.close(); } catch { /* ignore */ }
    try { await s.dir.removeEntry(s.tmpName); } catch { /* ignore */ }
  },

  // ── Rename (copy + delete) ───────────────────────────────────────────

  async rename(from: string, to: string): Promise<void> {
    const fromNorm = normalize(from);
    const toNorm = normalize(to);
    if (fromNorm === toNorm) return;

    // Destination must not exist (matches POSIX noclobber semantics here —
    // the UI already guards, so this is defensive).
    if (await OpfsDriver.exists(toNorm)) throw fsError('EEXIST', `destination exists: ${toNorm}`);

    const srcStat = await OpfsDriver.stat(fromNorm);
    if (srcStat.kind === 'file') {
      const [fromParent, fromName] = split(fromNorm);
      const [toParent, toName] = split(toNorm);
      const fromDir = await resolveDir(fromParent);
      const toDir = await resolveDir(toParent, true);
      await copyFileBetween(fromDir, fromName, toDir, toName);
      await fromDir.removeEntry(fromName);
      return;
    }

    // Directory rename: recursively copy then remove.
    await mkdirRecursive(toNorm);
    await copyTree(fromNorm, toNorm);
    await OpfsDriver.remove(fromNorm, { recursive: true });
  },

  async ping(): Promise<number> {
    return Date.now();
  },
};

// ─── Internals ────────────────────────────────────────────────────────────

async function guardQuota(requestedBytes: number): Promise<void> {
  const nav = (self as unknown as { navigator: Navigator }).navigator;
  try {
    const est = await nav.storage.estimate();
    const free = (est.quota ?? 0) - (est.usage ?? 0);
    if (free - QUOTA_RESERVE_BYTES < requestedBytes) {
      throw fsError('EQUOTA', `write of ${requestedBytes} bytes would exceed reserved quota headroom (free=${free})`);
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'EQUOTA') throw err;
    // estimate() unsupported or failed — fall through; real writes will
    // still surface a QuotaExceededError from OPFS itself.
  }
}

/** Copy `srcName` to `dstName` within the same directory using sync
 *  access handles (worker only). */
async function copyWithin(dir: FsDirHandle, srcName: string, dstName: string): Promise<void> {
  const src = await dir.getFileHandle(srcName);
  const dst = await dir.getFileHandle(dstName, { create: true });
  const srcSah = await src.createSyncAccessHandle();
  const dstSah = await dst.createSyncAccessHandle();
  try {
    const size = srcSah.getSize();
    dstSah.truncate(0);
    const buf = new Uint8Array(STREAM_CHUNK_BYTES);
    let offset = 0;
    while (offset < size) {
      const remaining = size - offset;
      const toRead = remaining < buf.byteLength ? remaining : buf.byteLength;
      const view = toRead < buf.byteLength ? buf.subarray(0, toRead) : buf;
      srcSah.read(view, { at: offset });
      dstSah.write(view, { at: offset });
      offset += toRead;
    }
    dstSah.flush();
  } finally {
    srcSah.close();
    dstSah.close();
  }
}

async function copyFileBetween(
  srcDir: FsDirHandle, srcName: string,
  dstDir: FsDirHandle, dstName: string,
): Promise<void> {
  const src = await srcDir.getFileHandle(srcName);
  const dst = await dstDir.getFileHandle(dstName, { create: true });
  const srcSah = await src.createSyncAccessHandle();
  const dstSah = await dst.createSyncAccessHandle();
  try {
    const size = srcSah.getSize();
    dstSah.truncate(0);
    const buf = new Uint8Array(STREAM_CHUNK_BYTES);
    let offset = 0;
    while (offset < size) {
      const remaining = size - offset;
      const toRead = remaining < buf.byteLength ? remaining : buf.byteLength;
      const view = toRead < buf.byteLength ? buf.subarray(0, toRead) : buf;
      srcSah.read(view, { at: offset });
      dstSah.write(view, { at: offset });
      offset += toRead;
    }
    dstSah.flush();
  } finally {
    srcSah.close();
    dstSah.close();
  }
}

async function mkdirRecursive(path: string): Promise<void> {
  await resolveDir(path, true);
}

async function copyTree(from: string, to: string): Promise<void> {
  const entries = await OpfsDriver.list(from);
  for (const entry of entries) {
    const relName = entry.name;
    const dstPath = to ? `${to}/${relName}` : relName;
    if (entry.kind === 'directory') {
      await mkdirRecursive(dstPath);
      await copyTree(entry.path, dstPath);
    } else {
      const [fromParent] = split(entry.path);
      const [toParent, toName] = split(dstPath);
      const fromDir = await resolveDir(fromParent);
      const toDir = await resolveDir(toParent, true);
      await copyFileBetween(fromDir, entry.name, toDir, toName);
    }
  }
}
