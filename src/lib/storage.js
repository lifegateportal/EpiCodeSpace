// ─── localStorage persistence ─────────────────────────────────────────────────

export const STORAGE_KEY  = 'epicodespace_fs_v2';
export const CONVOS_KEY   = 'epicodespace_conversations_v1';
export const PREFS_KEY    = 'epicodespace_preferences_v1';
export const PANELS_KEY   = 'epicodespace_panels_v1';
export const AGENT_KEY    = 'epicodespace_agent_v1';
export const MODELS_KEY   = 'epicodespace_agent_models_v1';
export const MODE_KEY     = 'epicodespace_mode_v1';

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
      // Sanitise: ensure every entry has a string content field
      keys.forEach((k) => {
        if (!parsed[k] || typeof parsed[k].content !== 'string') {
          parsed[k] = {
            name: k.split('/').pop(),
            language: 'text',
            content: parsed[k]?.content ?? '',
          };
        }
        if (!parsed[k].name) parsed[k].name = k.split('/').pop();
      });
      return parsed;
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
