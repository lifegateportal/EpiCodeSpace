// WebContainer lifecycle bridge.
//
// Singleton responsible for booting the container, mounting OPFS content
// into it, and tearing it down. Boot is destructive + idempotent: calling
// boot() while already booted is a no-op; reboot() forces a teardown first.
//
// Rule 4: boot requires cross-origin isolation. Without COOP+COEP headers,
// SharedArrayBuffer is unavailable and WebContainer.boot() will throw.

import { WebContainer, configureAPIKey } from '@webcontainer/api';
import type { FileSystemTree, DirectoryNode, FileNode } from '@webcontainer/api';
import { logger } from '../logger.js';
import { shouldSync, normalize, MAX_MIRROR_BYTES } from './policy.ts';

// configureAPIKey must be called at module-init time, before WebContainer.boot().
// Non-localhost origins (e.g. *.vercel.app) need a key from https://webcontainers.io/
// Set VITE_WEBCONTAINER_APIKEY in Vercel → Project Settings → Environment Variables.
{
  const apiKey = (import.meta as any).env?.VITE_WEBCONTAINER_APIKEY;
  if (apiKey) {
    configureAPIKey(apiKey);
    logger.info('runtime', 'configureAPIKey called', { origin: typeof window !== 'undefined' ? window.location.origin : 'ssr' });
  } else {
    logger.warn('runtime', 'VITE_WEBCONTAINER_APIKEY not set — boot will fail on non-localhost origins', { origin: typeof window !== 'undefined' ? window.location.origin : 'ssr' });
  }
}

export type BootState = 'idle' | 'booting' | 'ready' | 'dead';

export interface BootOptions {
  /** Flat path → text content map, matching useFileSystem's shape. */
  files: Record<string, { content?: string; isLarge?: boolean }>;
}

export interface ServerReady {
  port: number;
  url: string;
}

type Listener<T> = (v: T) => void;

class Bridge {
  private container: WebContainer | null = null;
  private _state: BootState = 'idle';
  private stateListeners = new Set<Listener<BootState>>();
  private serverListeners = new Set<Listener<ServerReady>>();
  private bootPromise: Promise<WebContainer> | null = null;

  get state(): BootState { return this._state; }

  get ready(): boolean { return this._state === 'ready' && !!this.container; }

  /** Returns the live container. Throws if not ready. */
  getContainer(): WebContainer {
    if (!this.container || this._state !== 'ready') {
      throw new Error(`WebContainer not ready (state=${this._state})`);
    }
    return this.container;
  }

  onState(cb: Listener<BootState>): () => void {
    this.stateListeners.add(cb);
    cb(this._state);
    return () => { this.stateListeners.delete(cb); };
  }

  onServerReady(cb: Listener<ServerReady>): () => void {
    this.serverListeners.add(cb);
    return () => { this.serverListeners.delete(cb); };
  }

  private setState(s: BootState) {
    this._state = s;
    for (const l of this.stateListeners) {
      try { l(s); } catch (err) { logger.error('runtime', 'state listener', err); }
    }
  }

  /** Boot + mount. Idempotent; returns the same container on repeat calls. */
  async boot(opts: BootOptions): Promise<WebContainer> {
    if (this.container && this._state === 'ready') return this.container;
    if (this.bootPromise) return this.bootPromise;

    if (typeof window !== 'undefined' && !window.crossOriginIsolated) {
      const err = new Error(
        'Cross-origin isolation required. Verify COOP=same-origin and COEP=require-corp response headers.',
      );
      this.setState('idle');
      throw err;
    }

    this.setState('booting');
    this.bootPromise = (async () => {
      try {
        const bootOpts: Parameters<typeof WebContainer.boot>[0] = {
          coep: 'require-corp',
          workdirName: 'epicodespace',
        };

        const c = await WebContainer.boot(bootOpts);
        c.on('server-ready', (port, url) => {
          logger.info('runtime', 'server-ready', { port, url });
          for (const l of this.serverListeners) {
            try { l({ port, url }); } catch (err) { logger.error('runtime', 'server listener', err); }
          }
        });
        c.on('error', (e) => {
          logger.error('runtime', 'webcontainer error', e);
        });

        const tree = buildTreeFromFlat(opts.files);
        await c.mount(tree);

        this.container = c;
        this.setState('ready');
        logger.info('runtime', 'boot complete', { fileCount: Object.keys(opts.files).length });
        return c;
      } catch (err) {
        // Reset to idle (not 'dead') so the Boot button re-enables and the
        // user can retry. 'dead' used to strand the UI after a transient
        // network / SAB failure with no way to recover besides reload.
        this.container = null;
        this.setState('idle');
        logger.error('runtime', 'boot failed', err);
        throw err;
      } finally {
        this.bootPromise = null;
      }
    })();

    return this.bootPromise;
  }

  /** Tear down container and free memory. Safe to call from any state. */
  async teardown(): Promise<void> {
    const c = this.container;
    this.container = null;
    this.setState('idle');
    if (c) {
      try { c.teardown(); } catch (err) { logger.warn('runtime', 'teardown threw', err); }
    }
  }

  /** Full reboot: teardown, then boot again with fresh file snapshot. */
  async reboot(opts: BootOptions): Promise<WebContainer> {
    await this.teardown();
    return this.boot(opts);
  }
}

// Module-level singleton — one WebContainer per page, period.
export const bridge = new Bridge();

/** Convert a flat path→entry map into WebContainer's nested FileSystemTree. */
export function buildTreeFromFlat(
  files: Record<string, { content?: string; isLarge?: boolean }>,
): FileSystemTree {
  const root: FileSystemTree = {};

  for (const [rawPath, entry] of Object.entries(files)) {
    if (!entry) continue;
    if (entry.isLarge) continue; // large files never mount
    const content = entry.content ?? '';
    if (content.length > MAX_MIRROR_BYTES) continue;
    const path = normalize(rawPath);
    if (!shouldSync(path)) continue;

    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    let cursor: FileSystemTree = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let node = cursor[seg] as DirectoryNode | undefined;
      if (!node || !('directory' in node)) {
        node = { directory: {} };
        cursor[seg] = node;
      }
      cursor = node.directory;
    }
    const leaf = parts[parts.length - 1];
    const fileNode: FileNode = { file: { contents: content } };
    cursor[leaf] = fileNode;
  }

  return root;
}

// Auto-teardown on iPad BFCache to release memory pressure.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', (e) => {
    if ((e as PageTransitionEvent).persisted) {
      void bridge.teardown();
    }
  });
}
