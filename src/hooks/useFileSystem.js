import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { loadFS, saveFS } from '../lib/storage.js';
import { logger } from '../lib/logger.js';
import { FsClient } from '../lib/fs/FsClient.ts';
import { MAX_INLINE_READ_BYTES } from '../lib/fs/types.ts';

/**
 * Amendment #5 — State management.
 *
 * Single source of truth for the virtual filesystem. The in-memory shape
 * `{ [path]: { name, language, content, size?, isLarge? } }` is what the
 * UI reads. Persistence happens through one of two backends:
 *
 *   • memory mode (default)  → debounced JSON dump into localStorage
 *   • opfs mode  (flagged)   → per-path writes through `FsClient` into
 *                              the browser's Origin Private File System,
 *                              offloaded to a dedicated Web Worker.
 *
 * Enable OPFS:
 *   localStorage.setItem('EPICODESPACE_USE_OPFS', '1') && reload.
 *
 * On first OPFS mount the hook migrates the user's existing localStorage
 * workspace into OPFS so nothing is lost. Files larger than the 2 MB
 * inline ceiling are represented as *stubs* (`isLarge: true, content: ''`)
 * and must be opened with `readLargeChunk` for streamed access.
 */

// ─── Feature flag ────────────────────────────────────────────────────────

const USE_OPFS_KEY = 'EPICODESPACE_USE_OPFS';

/** Public flag reader so the UI can render an "OPFS on" badge if it wants. */
export function isOpfsEnabled() {
  try { return localStorage.getItem(USE_OPFS_KEY) === '1'; }
  catch { return false; }
}

// ─── Language inference ──────────────────────────────────────────────────

const EXT_TO_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  css: 'css', scss: 'css',
  html: 'html', htm: 'html',
  json: 'json', md: 'markdown',
  py: 'python', yml: 'yaml', yaml: 'yaml',
};

function languageFor(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  return EXT_TO_LANG[ext] || 'text';
}

// ─── Reducer ─────────────────────────────────────────────────────────────

function reducer(state, action) {
  switch (action.type) {
    case 'set':
      return action.files || {};
    case 'write': {
      const { path, content, language, size, isLarge } = action;
      const name = path.split('/').pop();
      return {
        ...state,
        [path]: {
          name,
          language: language || languageFor(path),
          content: isLarge ? '' : (content ?? ''),
          size: size ?? (typeof content === 'string' ? content.length : 0),
          isLarge: !!isLarge,
        },
      };
    }
    case 'patch': {
      const { path, content } = action;
      if (!state[path]) return state;
      const size = content.length;
      const isLarge = size > MAX_INLINE_READ_BYTES;
      return {
        ...state,
        [path]: {
          ...state[path],
          content: isLarge ? '' : content,
          size,
          isLarge,
        },
      };
    }
    case 'rename': {
      const { oldPath, newPath } = action;
      if (!state[oldPath] || state[newPath] || oldPath === newPath) return state;
      const next = { ...state };
      next[newPath] = { ...next[oldPath], name: newPath.split('/').pop() };
      delete next[oldPath];
      return next;
    }
    case 'delete': {
      if (!state[action.path]) return state;
      const next = { ...state };
      delete next[action.path];
      return next;
    }
    case 'deletePrefix': {
      const next = { ...state };
      Object.keys(next).forEach((p) => {
        if (p === action.prefix || p.startsWith(action.prefix + '/')) delete next[p];
      });
      return next;
    }
    default:
      logger.warn('useFileSystem', `Unknown action: ${action?.type}`);
      return state;
  }
}

// ─── OPFS helpers ────────────────────────────────────────────────────────

// Flatten an OPFS tree into the flat `{path: entry}` shape the UI expects.
// Files over 2 MB are left as stubs — content stays on disk.
async function readOpfsTree(baseDir = '') {
  const out = {};
  const walk = async (dir) => {
    const entries = await FsClient.list(dir);
    for (const e of entries) {
      if (e.kind === 'directory') {
        await walk(e.path);
        continue;
      }
      try {
        const st = await FsClient.stat(e.path);
        if (st.size > MAX_INLINE_READ_BYTES) {
          out[e.path] = {
            name: e.name,
            language: languageFor(e.path),
            content: '',
            size: st.size,
            isLarge: true,
          };
        } else {
          const { text, bytes } = await FsClient.readText(e.path);
          out[e.path] = {
            name: e.name,
            language: languageFor(e.path),
            content: text,
            size: bytes,
            isLarge: false,
          };
        }
      } catch (err) {
        // Skip unreadable entries rather than abort the whole load.
        logger.warn('useFileSystem', `skip unreadable ${e.path}`, { err });
      }
    }
  };
  await walk(baseDir);
  return out;
}

// Copy every entry of an in-memory FS into OPFS. Used once, on migration.
async function migrateToOpfs(files) {
  const paths = Object.keys(files);
  logger.info('useFileSystem', `migrating ${paths.length} files to OPFS`);
  for (const p of paths) {
    const entry = files[p];
    if (!entry || typeof entry.content !== 'string') continue;
    try {
      await FsClient.writeText(p, entry.content);
    } catch (err) {
      logger.error('useFileSystem', `migration write failed for ${p}`, { err });
      throw err; // abort — user should see the failure, not half-migrate.
    }
  }
}

// ─── Main hook ───────────────────────────────────────────────────────────

export function useFileSystem() {
  const opfsEnabled = useMemo(isOpfsEnabled, []);
  const [mode, setMode] = useState(opfsEnabled ? 'opfs-pending' : 'memory');
  const [initError, setInitError] = useState(null);
  const [isReady, setIsReady] = useState(!opfsEnabled); // memory mode ready immediately

  const [fileSystem, dispatch] = useReducer(reducer, undefined, loadFS);
  const fsRef = useRef(fileSystem);
  fsRef.current = fileSystem;

  // ── One-shot OPFS init + migration ────────────────────────────────────
  const didInitOpfs = useRef(false);
  useEffect(() => {
    if (!opfsEnabled || didInitOpfs.current) return;
    didInitOpfs.current = true;

    let cancelled = false;
    (async () => {
      try {
        await FsClient.init();
        if (cancelled) return;

        const rootEntries = await FsClient.list('');
        const rootEmpty = rootEntries.length === 0;

        if (rootEmpty) {
          const legacy = loadFS();
          const legacyCount = Object.keys(legacy).length;
          if (legacyCount > 0) {
            await migrateToOpfs(legacy);
            logger.info('useFileSystem', `migration complete (${legacyCount} files)`);
          }
        }

        if (cancelled) return;
        const tree = await readOpfsTree('');
        if (cancelled) return;

        // Replace reducer state with the on-disk truth. The sync-baseline
        // ref is seeded from the same snapshot below so the write-diff
        // effect won't try to re-upload everything we just read.
        dispatch({ type: 'set', files: tree });
        setMode('opfs');
        setIsReady(true);
      } catch (err) {
        logger.error('useFileSystem', 'OPFS init failed — falling back to memory mode', { err });
        if (cancelled) return;
        setInitError(err?.code ? err : { code: 'EIO', message: String(err?.message || err) });
        setMode('memory'); // graceful degradation: keep using localStorage.
        setIsReady(true);
      }
    })();

    return () => { cancelled = true; };
  }, [opfsEnabled]);

  // ── Persistence: memory mode → debounced localStorage dump ────────────
  useEffect(() => {
    if (mode !== 'memory') return;
    const t = setTimeout(() => {
      try { saveFS(fileSystem); }
      catch (err) { logger.error('useFileSystem', 'Persist failed', { err }); }
    }, 400);
    return () => clearTimeout(t);
  }, [fileSystem, mode]);

  // ── Persistence: OPFS mode → per-path diff-based sync ─────────────────
  //
  // Compare each new snapshot against the last one we wrote to disk.
  // Paths whose content changed get re-written; paths that vanished get
  // removed. Renames surface as delete+write (OPFS `rename()` doesn't
  // preserve mtime anyway since it's implemented as copy+delete).
  const lastSyncedRef = useRef(null); // null until first seed
  const pendingSyncRef = useRef(null);
  const queueRef = useRef(Promise.resolve());

  // Serialise disk ops so two rapid writes never race on the same file.
  const enqueue = useCallback((fn) => {
    queueRef.current = queueRef.current.then(fn).catch((err) => {
      logger.error('useFileSystem', 'opfs sync op failed', { err });
    });
    return queueRef.current;
  }, []);

  useEffect(() => {
    if (mode !== 'opfs') return;

    // First render after mode flips: seed baseline with whatever we just
    // loaded so nothing is re-written.
    if (lastSyncedRef.current === null) {
      const snap = {};
      for (const [p, e] of Object.entries(fsRef.current)) snap[p] = { ...e };
      lastSyncedRef.current = snap;
      return;
    }

    clearTimeout(pendingSyncRef.current);
    pendingSyncRef.current = setTimeout(() => {
      const prev = lastSyncedRef.current;
      const curr = fsRef.current;

      // Deletions
      for (const path of Object.keys(prev)) {
        if (!(path in curr)) {
          enqueue(async () => {
            try { await FsClient.remove(path); }
            catch (err) {
              if (err?.code !== 'ENOENT') throw err;
            }
          });
        }
      }

      // Writes / updates — skip large-file stubs (content lives on disk).
      for (const [path, entry] of Object.entries(curr)) {
        if (entry?.isLarge) continue;
        const before = prev[path];
        const contentChanged = !before || before.content !== entry.content;
        if (contentChanged) {
          const content = entry.content ?? '';
          enqueue(() => FsClient.writeText(path, content));
        }
      }

      // Update baseline. Shallow-copy so later mutations don't alias.
      const snap = {};
      for (const [p, e] of Object.entries(curr)) snap[p] = { ...e };
      lastSyncedRef.current = snap;
    }, 400);

    return () => clearTimeout(pendingSyncRef.current);
  }, [fileSystem, mode, enqueue]);

  // ── Public actions ────────────────────────────────────────────────────

  // Mutation subscribers (e.g. WebContainer outbound sync). Subscribers are
  // invoked synchronously after each dispatch. Keep them fast and pure.
  const mutationSubsRef = useRef(new Set());
  const emit = useCallback((ev) => {
    for (const cb of mutationSubsRef.current) {
      try { cb(ev); } catch (err) { logger.error('useFileSystem', 'mutation subscriber threw', { err }); }
    }
  }, []);
  const onMutation = useCallback((cb) => {
    mutationSubsRef.current.add(cb);
    return () => { mutationSubsRef.current.delete(cb); };
  }, []);

  const replaceAll = useCallback((files) => {
    dispatch({ type: 'set', files: files || {} });
    emit({ type: 'replaceAll', files: files || {} });
  }, [emit]);
  const writeFile = useCallback((path, content = '', language) => {
    const size = typeof content === 'string' ? content.length : 0;
    const isLarge = size > MAX_INLINE_READ_BYTES;
    if (isLarge) {
      // Never let oversize content leak into memory state. UI should
      // stream writes through `FsClient.writeStreamOpen/Append/Close`
      // instead when it needs to persist bigger files.
      logger.warn(
        'useFileSystem',
        `writeFile ${path}: ${size}B exceeds ${MAX_INLINE_READ_BYTES}B inline ceiling — stored as stub`,
      );
    }
    dispatch({ type: 'write', path, content, language, size, isLarge });
    emit({ type: 'write', path, content: content ?? '', isLarge });
  }, [emit]);
  const writeBinaryFile = useCallback(async (path, bytes, language = 'binary') => {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);

    if (mode === 'opfs') {
      const handle = await FsClient.writeStreamOpen(path);
      try {
        for (let offset = 0; offset < view.byteLength; offset += 64 * 1024) {
          const chunk = view.subarray(offset, Math.min(view.byteLength, offset + 64 * 1024));
          const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
          await FsClient.writeStreamAppend(handle, ab);
        }
        await FsClient.writeStreamClose(handle);
      } catch (err) {
        await FsClient.writeStreamAbort(handle).catch(() => {});
        logger.error('useFileSystem', `writeBinaryFile failed for ${path}`, { err });
        throw err;
      }
    }

    dispatch({ type: 'write', path, content: '', language, size: view.byteLength, isLarge: true });
    emit({ type: 'write-binary', path, bytes: view, size: view.byteLength });
  }, [emit, mode]);
  const patchFile = useCallback((path, content) => {
    dispatch({ type: 'patch', path, content });
    emit({ type: 'patch', path, content: content ?? '' });
  }, [emit]);
  const renameFile = useCallback((oldPath, newPath) => {
    const prev = fsRef.current[oldPath];
    dispatch({ type: 'rename', oldPath, newPath });
    emit({ type: 'rename', oldPath, newPath, content: prev?.content });
  }, [emit]);
  const deleteFile = useCallback((path) => {
    dispatch({ type: 'delete', path });
    emit({ type: 'delete', path });
  }, [emit]);
  const deletePrefix = useCallback((prefix) => {
    const snap = fsRef.current;
    const victims = Object.keys(snap).filter((p) => p === prefix || p.startsWith(prefix + '/'));
    dispatch({ type: 'deletePrefix', prefix });
    for (const p of victims) emit({ type: 'delete', path: p });
  }, [emit]);

  // ── Large-file escape hatch ──────────────────────────────────────────
  // The UI uses this to render previews for files > 2 MB without ever
  // materialising them fully in memory.
  const readLargeChunk = useCallback(async (path, offset = 0, length = 64 * 1024) => {
    if (mode !== 'opfs') {
      throw { code: 'EUNSUPPORTED', message: 'large-file chunked reads require OPFS mode' };
    }
    return await FsClient.readChunk(path, offset, length);
  }, [mode]);

  const isLargeFile = useCallback((path) => !!fsRef.current[path]?.isLarge, []);

  return {
    // State
    fileSystem,
    mode,                    // 'memory' | 'opfs-pending' | 'opfs'
    isReady,
    initError,               // FsError or null
    maxInlineBytes: MAX_INLINE_READ_BYTES,

    // Read helpers
    getLatest: () => fsRef.current,
    isLargeFile,
    readLargeChunk,          // (path, offset, length) → Promise<ArrayBuffer>

    // Mutations
    replaceAll,
    writeFile,
    writeBinaryFile,
    patchFile,
    renameFile,
    deleteFile,
    deletePrefix,
    dispatch,

    // Subscription seam for WebContainer outbound sync.
    onMutation,
  };
}

export { languageFor };
export default useFileSystem;
