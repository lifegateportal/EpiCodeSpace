// ─── localStorage persistence ─────────────────────────────────────────────────

export const STORAGE_KEY  = 'epicodespace_fs_v2';
export const CONVOS_KEY   = 'epicodespace_conversations_v1';
export const PREFS_KEY    = 'epicodespace_preferences_v1';
export const PANELS_KEY   = 'epicodespace_panels_v1';
export const AGENT_KEY    = 'epicodespace_agent_v1';
export const MODELS_KEY   = 'epicodespace_agent_models_v1';
export const MODE_KEY     = 'epicodespace_mode_v1';
export const SNAPSHOTS_KEY = 'epicodespace_snapshots_v1';

const MAX_SNAPSHOT_ENTRIES = 20;

/** Safely parse JSON from localStorage, returning `fallback` on any error. */
export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** Safely serialise a value to localStorage (ignores quota errors). */
export function storeJSON(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* storage quota exceeded — silently skip */
  }
}

export const DEFAULT_FS = {};

function sanitizeFS(raw) {
  if (!raw || typeof raw !== 'object') return DEFAULT_FS;
  const out = {};
  Object.entries(raw).forEach(([k, v]) => {
    if (typeof k !== 'string' || !k) return;
    const content = typeof v?.content === 'string' ? v.content : '';
    out[k] = {
      name: v?.name || k.split('/').pop(),
      language: v?.language || 'text',
      content,
      size: typeof v?.size === 'number' ? v.size : content.length,
      isLarge: !!v?.isLarge,
      ...(v && typeof v === 'object' ? v : {}),
    };
  });
  return out;
}

/** Load the virtual file system from localStorage with migration / sanitisation. */
export function loadFS() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Clear stale mock/default data from an older version of the app
      const oldMockKeys = [
        'copilot-instructions.md',
        'src/App.jsx',
        'src/index.css',
        'src/hooks/useFileSystem.ts',
      ];
      const keys = Object.keys(parsed);
      if (keys.length <= 4 && keys.every((k) => oldMockKeys.includes(k))) {
        localStorage.removeItem(STORAGE_KEY);
        return DEFAULT_FS;
      }
      return sanitizeFS(parsed);
    }
  } catch {
    /* corrupted storage — fall through to default */
  }
  return DEFAULT_FS;
}

/** Persist the virtual file system to localStorage. */
export function saveFS(fs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fs));
  } catch {
    /* storage quota exceeded */
  }
}

export function saveLocalSnapshot(snapshot, opts = {}) {
  try {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const maxEntries = Math.max(1, Number(opts.maxEntries || MAX_SNAPSHOT_ENTRIES));
    const existing = loadJSON(SNAPSHOTS_KEY, []);
    const list = Array.isArray(existing) ? existing : [];
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      snapshot,
    };
    const next = [entry, ...list].slice(0, maxEntries);
    storeJSON(SNAPSHOTS_KEY, next);
    return entry;
  } catch {
    return null;
  }
}

export function loadLatestSnapshot() {
  const raw = loadJSON(SNAPSHOTS_KEY, []);
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const entry = raw[0];
  if (!entry || typeof entry !== 'object' || !entry.snapshot) return null;
  const snap = entry.snapshot;
  const files = sanitizeFS(snap.files || {});
  const fileKeys = Object.keys(files);
  const openTabs = Array.isArray(snap.openTabs)
    ? snap.openTabs.filter((p) => typeof p === 'string' && files[p])
    : [];
  const activeFile = typeof snap.activeFile === 'string' && files[snap.activeFile]
    ? snap.activeFile
    : (openTabs[0] || fileKeys[0] || null);
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    snapshot: {
      files,
      projectName: typeof snap.projectName === 'string' ? snap.projectName : 'My Project',
      openTabs,
      activeFile,
      previewRenderMode: snap.previewRenderMode === 'live' ? 'live' : 'static',
      previewSourcePath: typeof snap.previewSourcePath === 'string' ? snap.previewSourcePath : 'index.html',
    },
  };
}
