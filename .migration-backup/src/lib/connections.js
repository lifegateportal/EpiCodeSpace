// Shared connection store — persists deploy credentials to localStorage.

export const CONNECTIONS_KEY = 'epicodespace_connections_v1';

export const PLATFORM_META = {
  epicglobal: { label: 'EpiGlobal', badge: 'bg-fuchsia-700', tokenPlaceholder: 'Paste VITE_ORCHESTRATOR_API_KEY…', hint: 'epicglobal.app → Setup → EpiCodeSpaces API credentials' },
  netlify:    { label: 'Netlify',   badge: 'bg-teal-600',    tokenPlaceholder: 'nfp_…',                           hint: 'app.netlify.com/user/applications' },
  vercel:     { label: 'Vercel',    badge: 'bg-zinc-500',    tokenPlaceholder: 'your vercel token',                hint: 'vercel.com/account/tokens' },
  github:     { label: 'GitHub',    badge: 'bg-purple-700',  tokenPlaceholder: 'ghp_…',                           hint: 'github.com/settings/tokens (repo scope)' },
  custom:     { label: 'Custom',    badge: 'bg-sky-700',     tokenPlaceholder: 'token (or leave blank)',            hint: 'Any REST API endpoint' },
};

export function loadConnections() {
  try { return JSON.parse(localStorage.getItem(CONNECTIONS_KEY) || '[]'); } catch { return []; }
}

export function saveConnections(arr) {
  localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(arr));
}

export function makeConnection(overrides = {}) {
  return {
    id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2),
    platform: 'netlify',
    label: '',
    token: '',
    meta: {},
    ...overrides,
  };
}
