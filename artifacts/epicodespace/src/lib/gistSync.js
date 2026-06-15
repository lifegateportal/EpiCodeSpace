// ─── GitHub Gist Sync ─────────────────────────────────────────────────────────
// Persists the virtual workspace FS to a private GitHub Gist so the same
// workspace is accessible from any device that uses the same GitHub token.
//
// Storage keys
//   GIST_TOKEN_KEY  — GitHub personal access token (gist scope)
//   GIST_ID_KEY     — ID of the Gist created on first push (auto-created)
//
// Flow
//   1. User adds a GitHub token in the Gist Sync panel.
//   2. On first save: POST /gists  → store the returned id in localStorage.
//   3. On subsequent saves: PATCH /gists/:id
//   4. On load (any device): GET /gists/:id → restore FS from file content.

export const GIST_TOKEN_KEY = 'epicodespace_gist_token_v1';
export const GIST_ID_KEY    = 'epicodespace_gist_id_v1';

const GIST_FILENAME = 'epicodespace-workspace.json';
const GH_API        = 'https://api.github.com';

function getToken() {
  try { return localStorage.getItem(GIST_TOKEN_KEY) || ''; } catch { return ''; }
}
function getGistId() {
  try { return localStorage.getItem(GIST_ID_KEY) || ''; } catch { return ''; }
}
function setGistId(id) {
  try { localStorage.setItem(GIST_ID_KEY, id); } catch { /* quota */ }
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };
}

/** Returns true if a token is configured. */
export function isGistSyncEnabled() {
  return !!getToken();
}

/**
 * Push the current file system snapshot to the Gist.
 * Creates the Gist on first call; PATCHes on subsequent calls.
 *
 * @param {import('../types').FileSystem} fileSystem
 * @param {string} projectName
 * @returns {Promise<{ ok: boolean, gistId?: string, error?: string }>}
 */
export async function pushToGist(fileSystem, projectName) {
  const token = getToken();
  if (!token) return { ok: false, error: 'No GitHub token configured.' };

  const payload = JSON.stringify({ projectName, files: fileSystem }, null, 0);
  const body = {
    description: `EpiCodeSpace workspace — ${projectName || 'My Project'}`,
    public: false,
    files: { [GIST_FILENAME]: { content: payload } },
  };

  try {
    const gistId = getGistId();
    let res;
    if (gistId) {
      res = await fetch(`${GH_API}/gists/${gistId}`, {
        method: 'PATCH',
        headers: headers(token),
        body: JSON.stringify(body),
      });
      // If the gist was deleted remotely, fall through to create a new one.
      if (res.status === 404) {
        setGistId('');
        return pushToGist(fileSystem, projectName);
      }
    } else {
      res = await fetch(`${GH_API}/gists`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify(body),
      });
    }

    if (!res.ok) {
      const msg = await res.text().catch(() => `HTTP ${res.status}`);
      return { ok: false, error: `GitHub error ${res.status}: ${msg}` };
    }

    const data = await res.json();
    setGistId(data.id);
    return { ok: true, gistId: data.id };
  } catch (err) {
    return { ok: false, error: err.message || 'Network error' };
  }
}

/**
 * Pull the workspace snapshot from the Gist.
 *
 * @returns {Promise<{ ok: boolean, projectName?: string, files?: import('../types').FileSystem, error?: string }>}
 */
export async function pullFromGist() {
  const token = getToken();
  if (!token) return { ok: false, error: 'No GitHub token configured.' };
  const gistId = getGistId();
  if (!gistId) return { ok: false, error: 'No Gist ID saved. Push first to create one.' };

  try {
    const res = await fetch(`${GH_API}/gists/${gistId}`, {
      headers: headers(token),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => `HTTP ${res.status}`);
      return { ok: false, error: `GitHub error ${res.status}: ${msg}` };
    }
    const data = await res.json();
    const raw = data.files?.[GIST_FILENAME]?.content;
    if (!raw) return { ok: false, error: 'Workspace file not found in Gist.' };

    const parsed = JSON.parse(raw);
    return {
      ok: true,
      projectName: parsed.projectName || 'My Project',
      files: parsed.files || {},
    };
  } catch (err) {
    return { ok: false, error: err.message || 'Network error' };
  }
}

/**
 * Verify a token by fetching the authenticated user.
 * @param {string} token
 * @returns {Promise<{ ok: boolean, login?: string, error?: string }>}
 */
export async function verifyGistToken(token) {
  try {
    const res = await fetch(`${GH_API}/user`, { headers: headers(token) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const d = await res.json();
    return { ok: true, login: d.login };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
