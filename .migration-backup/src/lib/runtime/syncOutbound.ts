// Outbound sync: OPFS/editor mutations → WebContainer fs.
//
// Subscribes to useFileSystem's onMutation seam and debounces writes into
// the container. Obeys the shared policy — node_modules and friends are
// never mirrored outbound.

import { bridge } from './WebContainerBridge.ts';
import { shouldSync, normalize, MAX_MIRROR_BYTES } from './policy.ts';
import { logger } from '../logger.js';

export type MutationEvent =
  | { type: 'write' | 'patch'; path: string; content: string; isLarge?: boolean }
  | { type: 'write-binary'; path: string; bytes: Uint8Array; size?: number }
  | { type: 'delete'; path: string }
  | { type: 'rename'; oldPath: string; newPath: string; content?: string }
  | { type: 'replaceAll'; files: Record<string, { content?: string; isLarge?: boolean }> };

const DEBOUNCE_MS = 800; // 800ms — prevents every keystroke crossing the worker boundary

type Pending =
  | { kind: 'upsert-text'; path: string; content: string }
  | { kind: 'upsert-bytes'; path: string; bytes: Uint8Array }
  | { kind: 'remove'; path: string };

const queue = new Map<string, Pending>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function schedule() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, DEBOUNCE_MS);
}

export async function flush() {
  flushTimer = null;
  if (!bridge.ready) {
    queue.clear();
    return;
  }
  const container = bridge.getContainer();
  const batch = Array.from(queue.values());
  queue.clear();

  for (const op of batch) {
    try {
      if (op.kind === 'remove') {
        await container.fs.rm(op.path, { recursive: true, force: true });
      } else {
        const dir = op.path.includes('/') ? op.path.slice(0, op.path.lastIndexOf('/')) : '';
        if (dir) await container.fs.mkdir(dir, { recursive: true });
        if (op.kind === 'upsert-bytes') await container.fs.writeFile(op.path, op.bytes);
        else await container.fs.writeFile(op.path, op.content);
      }
    } catch (err) {
      logger.warn('runtime', `outbound ${op.kind} failed: ${op.path}`, err);
    }
  }
}

function queueUpsert(path: string, content: string) {
  const n = normalize(path);
  if (!shouldSync(n)) return;
  if ((content?.length ?? 0) > MAX_MIRROR_BYTES) return;
  queue.set(n, { kind: 'upsert-text', path: n, content });
  schedule();
}

function queueUpsertBytes(path: string, bytes: Uint8Array) {
  const n = normalize(path);
  if (!shouldSync(n)) return;
  if ((bytes?.byteLength ?? 0) > MAX_MIRROR_BYTES) return;
  queue.set(n, { kind: 'upsert-bytes', path: n, bytes });
  schedule();
}

function queueRemove(path: string) {
  const n = normalize(path);
  if (!shouldSync(n)) return;
  queue.set(n, { kind: 'remove', path: n });
  schedule();
}

/** Apply a single mutation event to the outbound queue. */
export function applyMutation(ev: MutationEvent): void {
  switch (ev.type) {
    case 'write':
    case 'patch':
      if (ev.isLarge) return;
      queueUpsert(ev.path, ev.content ?? '');
      break;
    case 'write-binary':
      if (!ev.bytes) return;
      queueUpsertBytes(ev.path, ev.bytes);
      break;
    case 'delete':
      queueRemove(ev.path);
      break;
    case 'rename':
      queueRemove(ev.oldPath);
      if (typeof ev.content === 'string') queueUpsert(ev.newPath, ev.content);
      break;
    case 'replaceAll':
      // Fresh snapshot — clearest way to keep WC in sync is a full remount.
      // We don't drive that from here; BridgeProvider calls reboot().
      break;
  }
}

// Register flush as a pre-teardown hook so the visibilitychange/pagehide
// lifecycle drains any pending outbound writes before the container is torn down.
bridge.registerPreTeardownHook(flush);
