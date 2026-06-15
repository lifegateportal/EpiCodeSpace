// ─── Cloudflare R2 Sync ───────────────────────────────────────────────────────
// All R2 credentials live in Replit secrets and are accessed server-side only.
// The browser calls the Express proxy at /api/r2/* — no keys in the client.

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const API = `${BASE}/api/r2`;

async function r2Fetch(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts);
  return res.json();
}

/** Check if R2 env vars are configured on the server. */
export async function checkR2Status() {
  try { return await r2Fetch('/status'); }
  catch (err) { return { ok: false, error: err.message }; }
}

/** List all saved workspaces (newest first). */
export async function listR2Saves() {
  try { return await r2Fetch('/saves'); }
  catch (err) { return { ok: false, error: err.message }; }
}

/**
 * Save the current workspace to R2.
 * snapshot=false  → overwrites `{slug}/latest.json`
 * snapshot=true   → creates  `{slug}/{iso-timestamp}.json`
 */
export async function saveToR2(fileSystem, projectName, { snapshot = false } = {}) {
  const ts   = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = (projectName || 'workspace').replace(/[^a-zA-Z0-9._-]/g, '_');
  const key  = snapshot ? `${slug}/${ts}.json` : `${slug}/latest.json`;
  const payload = { projectName, files: fileSystem, savedAt: new Date().toISOString() };
  try {
    const data = await r2Fetch('/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, payload }),
    });
    return data.ok ? { ok: true, key } : { ok: false, error: data.error };
  } catch (err) { return { ok: false, error: err.message }; }
}

/**
 * Load a workspace from R2 by key.
 * Returns { ok, projectName, files, savedAt } on success.
 */
export async function loadFromR2(key) {
  try {
    const data = await r2Fetch(`/load?key=${encodeURIComponent(key)}`);
    if (!data.ok) return { ok: false, error: data.error };
    return {
      ok: true,
      projectName: data.payload.projectName || 'My Project',
      files: data.payload.files || {},
      savedAt: data.payload.savedAt,
    };
  } catch (err) { return { ok: false, error: err.message }; }
}

/** Delete a save from R2 by key. */
export async function deleteR2Save(key) {
  try {
    return await r2Fetch(`/save?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
  } catch (err) { return { ok: false, error: err.message }; }
}
