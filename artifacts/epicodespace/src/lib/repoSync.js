const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const API = `${BASE}/api/repos`;

function toError(err, fallback = 'Request failed') {
  return err?.message || fallback;
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    return { ok: false, error: data?.error || `HTTP ${res.status}` };
  }
  return { ok: true, ...data };
}

export function parseRepoUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'Repo URL is required.' };

  let path = raw;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      path = u.pathname;
    }
  } catch {
    return { ok: false, error: 'Invalid URL.' };
  }

  const m = path.match(/^\/?r\/([^/]+)\/([^/]+)(?:\/rev\/([^/]+))?\/?$/i);
  if (!m) {
    return { ok: false, error: 'Repo URL must look like /r/owner/slug or /r/owner/slug/rev/id' };
  }

  return {
    ok: true,
    owner: decodeURIComponent(m[1]),
    slug: decodeURIComponent(m[2]),
    revisionId: m[3] ? decodeURIComponent(m[3]) : null,
  };
}

export async function checkRepoStatus() {
  try {
    return await apiFetch('/status');
  } catch (err) {
    return { ok: false, error: toError(err, 'Unable to reach repo API.') };
  }
}

export async function createRepoSnapshot({ owner, slug, visibility = 'private', projectName, files, repoUrl = '', message = 'Initial revision' }) {
  try {
    return await apiFetch('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, slug, visibility, projectName, files, repoUrl, message }),
    });
  } catch (err) {
    return { ok: false, error: toError(err, 'Create repo failed.') };
  }
}

export async function saveRepoRevision({ repoUrl, files, projectName, message = 'Save revision' }) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed.ok) return parsed;

  try {
    return await apiFetch(`/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.slug)}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files, projectName, repoUrl, message }),
    });
  } catch (err) {
    return { ok: false, error: toError(err, 'Save revision failed.') };
  }
}

export async function loadRepoFromUrl(repoUrl) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed.ok) return parsed;

  const owner = encodeURIComponent(parsed.owner);
  const slug = encodeURIComponent(parsed.slug);
  const rev = parsed.revisionId ? encodeURIComponent(parsed.revisionId) : null;
  const path = rev
    ? `/${owner}/${slug}/revisions/${rev}`
    : `/${owner}/${slug}/latest`;

  try {
    const data = await apiFetch(path);
    if (!data.ok) return data;
    const payload = data.payload || {};
    return {
      ok: true,
      owner: parsed.owner,
      slug: parsed.slug,
      revisionId: data.revision?.id || parsed.revisionId || null,
      projectName: payload.projectName || data.repo?.projectName || 'My Project',
      repoUrl: data.repo?.repoUrl || `/r/${parsed.owner}/${parsed.slug}`,
      files: payload.files || {},
      savedAt: payload.savedAt || data.revision?.createdAt || null,
      repo: data.repo,
      revision: data.revision,
    };
  } catch (err) {
    return { ok: false, error: toError(err, 'Load repo failed.') };
  }
}

export async function getRepoInfo(repoUrl) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed.ok) return parsed;

  try {
    return await apiFetch(`/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.slug)}`);
  } catch (err) {
    return { ok: false, error: toError(err, 'Failed to load repo info.') };
  }
}

export async function deleteOwnerRepos(owner, slug = '') {
  const cleanOwner = String(owner || '').trim();
  if (!cleanOwner) return { ok: false, error: 'Owner is required.' };

  const params = new URLSearchParams({ owner: cleanOwner });
  if (String(slug || '').trim()) params.set('slug', String(slug).trim());

  try {
    return await apiFetch(`?${params.toString()}`, {
      method: 'DELETE',
    });
  } catch (err) {
    return { ok: false, error: toError(err, 'Failed to delete repo links.') };
  }
}
