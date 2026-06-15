/**
 * Path helpers for the OPFS adapter.
 *
 * Paths are "posix-like": no leading slash, forward slashes only, no `.`
 * or `..` segments. Everything that crosses the worker boundary or touches
 * OPFS must first pass through `normalize()` to prevent path traversal
 * and keep separator handling consistent across platforms.
 */

import { fsError, FsError } from './types';

/** Normalise a user-supplied path. Throws FsError('EINVAL') on traversal
 *  attempts or paths containing a NUL byte (a real attack vector on some
 *  filesystem APIs). */
export function normalize(raw: string): string {
  if (typeof raw !== 'string') throw fsError('EINVAL', 'path must be a string');
  if (raw.includes('\0')) throw fsError('EINVAL', 'path contains NUL byte');

  // Collapse backslashes → forward slashes (Windows paste-in safety).
  const unified = raw.replace(/\\/g, '/').trim();
  const parts: string[] = [];

  for (const seg of unified.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // Reject all upward traversal — we're inside a single origin sandbox.
      throw fsError('EINVAL', `path traversal is not allowed: ${raw}`);
    }
    // Reject control characters and per-OS reserved names — OPFS itself
    // accepts almost anything, but keeping names portable helps export.
    if (/[\x00-\x1f]/.test(seg)) throw fsError('EINVAL', `illegal character in segment: ${seg}`);
    parts.push(seg);
  }

  return parts.join('/');
}

/** Split a path into `[parentDir, basename]`. */
export function split(path: string): [string, string] {
  const p = normalize(path);
  const idx = p.lastIndexOf('/');
  if (idx === -1) return ['', p];
  return [p.slice(0, idx), p.slice(idx + 1)];
}

/** Join segments into a normalised path. */
export function join(...segments: string[]): string {
  return normalize(segments.filter(Boolean).join('/'));
}

/** Basename (last segment). */
export function basename(path: string): string {
  return split(path)[1];
}

/** Dirname (parent directory, or `''` for root). */
export function dirname(path: string): string {
  return split(path)[0];
}

/** Every ancestor directory of `path`, root-first. Useful for `mkdir -p`. */
export function ancestors(path: string): string[] {
  const parts = normalize(path).split('/').filter(Boolean);
  const out: string[] = [];
  let acc = '';
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    out.push(acc);
  }
  return out;
}

/** Rethrow as FsError if this is one, otherwise wrap as EIO. */
export function toFsError(err: unknown, fallback = 'filesystem error'): FsError {
  if (err && typeof err === 'object' && 'code' in (err as object) && 'message' in (err as object)) {
    return err as FsError;
  }
  const msg = err instanceof Error ? err.message : String(err ?? fallback);
  return fsError('EIO', msg);
}
