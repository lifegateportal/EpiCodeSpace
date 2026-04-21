import { readFileSync, writeFileSync } from 'fs';

const file = new URL('./src/EpiCodeSpaceComplete.jsx', import.meta.url).pathname;
let src = readFileSync(file, 'utf8');
const before = src;

// 1. Remove entire bad empty-state button block + hint div
// Uses [\s\S]*? to match across lines including NBSP, backticks, and other special chars
src = src.replace(
  /\n[ \t]*<button\n[ \t]*onClick=\{[^\n]*window\.open[\s\S]*?<\/button>\n[ \t]*<div[^>]*>Run[\s\S]*?<\/div>/,
  ''
);

// 2. Remove FIRST (stale) onClick on port row button, keeping onClick={openPreviewTab}
src = src.replace(
  /\n([ \t]*)onClick=\{[^\n]*window\.open\([^\n]*localhost[^\n]*\n([ \t]*onClick=\{openPreviewTab\})/,
  '\n$2'
);

const changed = src !== before;
writeFileSync(file, src);
console.log(changed ? 'Fixed successfully.' : 'WARNING: No changes made — check regex patterns.');
