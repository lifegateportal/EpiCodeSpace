// One-shot fix: remove duplicate injected section from EpiCodeSpaceComplete.jsx
import { readFileSync, writeFileSync } from 'fs';

const file = new URL('./src/EpiCodeSpaceComplete.jsx', import.meta.url).pathname;
const src = readFileSync(file, 'utf8');
const lines = src.split('\n');

const MARKER = '/* ─── Main Component ────────────────────────────────────────────────────────── */';

const occurrences = lines.reduce((acc, l, i) => {
  if (l.includes('Main Component') && l.includes('──')) acc.push(i);
  return acc;
}, []);

if (occurrences.length !== 2) {
  console.error('Expected 2 occurrences of Main Component marker, found:', occurrences.length, 'at lines:', occurrences.map(i=>i+1));
  process.exit(1);
}

const [first, second] = occurrences;
console.log(`First marker (injected): line ${first + 1}`);
console.log(`Second marker (original): line ${second + 1}`);

// Find the ErrorBoundary closing `}` just before the first marker
// Walk backwards from first to find the last non-blank line before blank lines
let errorBoundaryEnd = first - 1;
while (errorBoundaryEnd >= 0 && lines[errorBoundaryEnd].trim() === '') {
  errorBoundaryEnd--;
}
console.log(`ErrorBoundary closing at line ${errorBoundaryEnd + 1}: ${JSON.stringify(lines[errorBoundaryEnd])}`);

// Keep: lines 0..errorBoundaryEnd
// Skip: lines (errorBoundaryEnd+1)..(second-1)  [blank lines + injected dup + tools]
// Keep: lines second..END

const kept = [
  ...lines.slice(0, errorBoundaryEnd + 1),
  '',
  '',
  ...lines.slice(second),
];

const result = kept.join('\n');
writeFileSync(file, result, 'utf8');

console.log(`Done! File reduced from ${lines.length} to ${kept.length} lines.`);
console.log(`Removed lines ${errorBoundaryEnd + 2}–${second} (${second - errorBoundaryEnd - 1} lines).`);
