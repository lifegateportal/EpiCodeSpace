// Inbound sync: WebContainer fs → OPFS/editor state.
//
// Explicit by default. Two paths:
//   1. `pullPaths([...])` — AI tool-call results or manual sync button.
//   2. Narrow auto-pull — after each foreground process exits, scan root
//      level only (non-recursive, denylist applied) for newly appeared
//      small files and merge them back.

import { bridge } from './WebContainerBridge.ts';
import { shouldSync, isRootLevelFile, MAX_MIRROR_BYTES } from './policy.ts';
import { logger } from '../logger.js';

export interface WriteSink {
  writeFile: (path: string, content: string) => void;
  getLatest: () => Record<string, { content?: string; isLarge?: boolean }>;
}

/** Pull an explicit list of paths from the container into the editor state. */
export async function pullPaths(paths: string[], sink: WriteSink): Promise<number> {
  if (!bridge.ready) return 0;
  const c = bridge.getContainer();
  let count = 0;
  for (const raw of paths) {
    if (!shouldSync(raw)) continue;
    try {
      const buf = await c.fs.readFile(raw, 'utf-8');
      if (typeof buf !== 'string') continue;
      if (buf.length > MAX_MIRROR_BYTES) continue;
      sink.writeFile(raw, buf);
      count++;
    } catch (err) {
      logger.warn('runtime', `pullPaths ${raw} failed`, err);
    }
  }
  return count;
}

/** Narrow auto-pull: only *new* root-level small files get mirrored back. */
export async function autoPullRootNewFiles(sink: WriteSink): Promise<string[]> {
  if (!bridge.ready) return [];
  const c = bridge.getContainer();
  let entries: string[] = [];
  try {
    const list = await c.fs.readdir('/', { withFileTypes: true });
    entries = list.filter((e: any) => e.isFile?.()).map((e: any) => e.name);
  } catch (err) {
    logger.warn('runtime', 'autoPull readdir failed', err);
    return [];
  }
  const latest = sink.getLatest();
  const added: string[] = [];
  for (const name of entries) {
    if (!isRootLevelFile(name)) continue;
    if (name in latest) continue; // only *new* files per the agreed policy
    try {
      const content = await c.fs.readFile(name, 'utf-8');
      if (typeof content !== 'string') continue;
      if (content.length > MAX_MIRROR_BYTES) continue;
      sink.writeFile(name, content);
      added.push(name);
    } catch (err) {
      logger.warn('runtime', `autoPull read ${name} failed`, err);
    }
  }
  if (added.length) logger.info('runtime', 'auto-pulled root files', added);
  return added;
}
