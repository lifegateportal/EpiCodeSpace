/**
 * ───────────────────────────────────────────────────────────────────────────
 *  OPFS filesystem — shared types & protocol contract
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  This file is the single source of truth for messages passed between the
 *  main thread and the filesystem Web Worker. Both sides must stay in sync
 *  with these types.
 *
 *  Design goals (iPadOS / WebKit):
 *   - No `SharedArrayBuffer` → no COOP/COEP headers needed.
 *   - Streaming reads/writes so we never hold > 2 MB of file content in
 *     memory on the main thread.
 *   - All error conditions flow through typed codes, never thrown across
 *     the worker boundary as generic `Error`s that would lose their shape
 *     through structured clone.
 */

/** Upper bound on the size of a text read that returns the whole file.
 *  Anything larger must be streamed via `readChunk`. */
export const MAX_INLINE_READ_BYTES = 2 * 1024 * 1024;        // 2 MB

/** Chunk size for streaming reads / writes — small enough that iPadOS
 *  won't evict the tab even under memory pressure. */
export const STREAM_CHUNK_BYTES = 64 * 1024;                 // 64 KB

/** Headroom kept back from `navigator.storage.estimate().quota` before we
 *  refuse to write. Guards against silent truncation on iPadOS when the
 *  origin is near its cap. */
export const QUOTA_RESERVE_BYTES = 50 * 1024 * 1024;         // 50 MB

// ─── Error taxonomy ───────────────────────────────────────────────────────

export type FsErrorCode =
  | 'ENOENT'        // path does not exist
  | 'EEXIST'        // destination already exists
  | 'EINVAL'        // invalid path / argument
  | 'EISDIR'        // expected a file, got a directory
  | 'ENOTDIR'       // expected a directory, got a file
  | 'EQUOTA'        // quota exceeded
  | 'ETOOBIG'       // file exceeds MAX_INLINE_READ_BYTES
  | 'EUNSUPPORTED'  // OPFS not available in this browser
  | 'EIO';          // unknown low-level failure

export interface FsError {
  code: FsErrorCode;
  message: string;
}

/** Build a structured-cloneable error. Never throw the raw DOMException
 *  across the worker boundary — its `name` survives but its `message`
 *  often gets clipped in Safari. */
export function fsError(code: FsErrorCode, message: string): FsError {
  return { code, message };
}

/** Narrow a thrown value to an FsError. */
export function isFsError(x: unknown): x is FsError {
  return !!x && typeof x === 'object' && 'code' in x && 'message' in x;
}

// ─── Filesystem entities ─────────────────────────────────────────────────

export type FsKind = 'file' | 'directory';

export interface FsEntry {
  name: string;
  path: string;          // normalized, forward-slash separated, no leading `/`
  kind: FsKind;
}

export interface FsStat extends FsEntry {
  size: number;          // bytes (0 for directories)
  mtime: number | null;  // ms since epoch, null if unknown (OPFS lastModified)
}

export interface FsUsage {
  usage: number;
  quota: number;
  reserved: number;      // = QUOTA_RESERVE_BYTES (mirrored for UI display)
}

// ─── Write-stream handle (opaque token) ──────────────────────────────────

export type WriteHandle = string;

// ─── Public API surface exposed via Comlink ──────────────────────────────

/**
 * The methods here are exactly what `Comlink.wrap<FsWorkerApi>()` gives
 * back on the main thread. Every method returns a Promise because Comlink
 * serialises calls over `postMessage`.
 *
 * Paths are always "posix-like": no leading slash, forward slashes only,
 * no `..` segments. Use `paths.ts` helpers to normalize before calling.
 */
export interface FsWorkerApi {
  /** One-time handshake. Detects OPFS support and returns driver info.
   *  Rejects with `EUNSUPPORTED` if OPFS is not available. */
  init(): Promise<{ driver: 'opfs'; supportsSyncAccess: boolean }>;

  /** Heartbeat — used by the main thread to detect a dead worker
   *  (iPadOS can kill backgrounded workers without notice). */
  ping(): Promise<number>;

  /** Report current storage usage + quota. */
  usage(): Promise<FsUsage>;

  /** List immediate children of `dir`. Pass `''` for the project root. */
  list(dir: string): Promise<FsEntry[]>;

  /** Stat a single entry. */
  stat(path: string): Promise<FsStat>;

  /** Check existence without throwing. */
  exists(path: string): Promise<boolean>;

  /** Create a directory (and all missing parents). No-op if it exists. */
  mkdir(path: string): Promise<void>;

  /** Remove a file or directory. Set `recursive` for non-empty dirs. */
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;

  /** Rename / move within the same driver. Implemented as copy+delete
   *  because OPFS `move()` is not yet shipping on WebKit. */
  rename(from: string, to: string): Promise<void>;

  /** Read a whole file as UTF-8 text.
   *  @throws {FsError} ETOOBIG if the file exceeds MAX_INLINE_READ_BYTES
   *                    (caller should switch to `readChunk`). */
  readText(path: string, opts?: { maxBytes?: number }): Promise<{
    text: string;
    bytes: number;
    truncated: false;
  }>;

  /** Read an arbitrary byte range. Returns an ArrayBuffer that Comlink
   *  will `Transfer` back to the main thread (zero-copy on WebKit). */
  readChunk(path: string, offset: number, length: number): Promise<ArrayBuffer>;

  /** Atomically overwrite a file with UTF-8 text. Writes to `{path}.tmp`
   *  then renames, so a backgrounded tab never leaves a half-written file. */
  writeText(path: string, text: string): Promise<{ bytes: number }>;

  /** Open a streaming write. Returns an opaque handle used for subsequent
   *  append / close calls. Each main-thread caller should keep the handle
   *  local and always `writeStreamClose` (or `writeStreamAbort`) it. */
  writeStreamOpen(path: string): Promise<WriteHandle>;

  /** Append a chunk. The caller should `await` each append before sending
   *  the next so we never queue tens of MBs of messages on iPad. */
  writeStreamAppend(handle: WriteHandle, chunk: ArrayBuffer): Promise<{ written: number }>;

  /** Commit the write and release the handle. */
  writeStreamClose(handle: WriteHandle): Promise<{ bytes: number }>;

  /** Abort without committing. Cleans up the temp file. */
  writeStreamAbort(handle: WriteHandle): Promise<void>;
}
