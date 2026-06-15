// OPFS ↔ WebContainer sync policy.
//
// Rule 1 of the bridge: node_modules and build output never cross in either
// direction. This is enforced at a single chokepoint so both outbound and
// inbound sync use the exact same rules.

export const MAX_MIRROR_BYTES = 2 * 1024 * 1024; // 2 MB — matches OPFS inline ceiling

export const DENY_PREFIXES: readonly string[] = [
  'node_modules/',
  '.git/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.cache/',
  '.turbo/',
  '.parcel-cache/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.vercel/',
  '.netlify/',
  '.DS_Store',
];

/** Normalise a path into a WebContainer-friendly form (no leading slash). */
export function normalize(p: string): string {
  if (!p) return '';
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('/')) out = out.slice(1);
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}

/** True iff a path is safe to mirror between OPFS and the WebContainer. */
export function shouldSync(path: string): boolean {
  const n = normalize(path);
  if (!n) return false;
  if (n.includes('..')) return false; // traversal guard
  for (const deny of DENY_PREFIXES) {
    if (n === deny.replace(/\/$/, '')) return false;
    if (n.startsWith(deny)) return false;
  }
  return true;
}

/** True iff an inbound path is a *root-level* file eligible for narrow auto-pull. */
export function isRootLevelFile(path: string): boolean {
  const n = normalize(path);
  if (!n) return false;
  if (n.includes('/')) return false;
  return shouldSync(n);
}
