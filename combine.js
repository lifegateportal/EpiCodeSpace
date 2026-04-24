#!/usr/bin/env node
/**
 * combine.js
 * Merges src/EpiCodeSpaceComplete.jsx + all component/hook/lib files + src/index.css
 * into a single standalone Preview.jsx at the project root.
 *
 * Rules:
 *  - Never modifies, overwrites, or deletes any original src files.
 *  - Strips all local relative imports (./  or ../ prefixed).
 *  - Strips lazy() dynamic imports that reference local paths.
 *  - Injects CSS via an injected <style> block appended to document.head.
 *  - Default export of the output file is the App (EpiCodeSpaceComplete) component.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'Preview.jsx');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readSrc(rel) {
  const candidates = [rel, rel + '.jsx', rel + '.js', rel + '.ts', rel + '.tsx'];
  for (const c of candidates) {
    const full = path.join(SRC, c);
    if (fs.existsSync(full)) return fs.readFileSync(full, 'utf8');
  }
  return null;
}

function stripLocalImports(code) {
  // Remove static import lines that reference relative paths: import X from './...' or import './...'
  code = code.replace(
    /^import\s[^'"]*from\s['"](\.|\.\.)[^'"]*['"]\s*;?\s*$/gm,
    ''
  );
  // Remove bare side-effect imports: import './foo.css'
  code = code.replace(
    /^import\s+['"](\.|\.\.)[^'"]*['"]\s*;?\s*$/gm,
    ''
  );
  // Remove lazy(() => import('./...')) assignments: keep the variable name but replace with a stub
  code = code.replace(
    /^(const\s+\w+\s*=\s*)lazy\(\s*\(\s*\)\s*=>\s*import\(['"][^'"]*['"]\)\s*\)\s*;?\s*$/gm,
    (match, prefix) => {
      const varName = prefix.match(/const\s+(\w+)/)?.[1];
      return varName
        ? `// [combine] lazy stub for ${varName} (inlined below)\nconst ${varName} = React.forwardRef((p, r) => <div data-stub="${varName}" ref={r} {...p} />);`
        : '';
    }
  );
  return code;
}

function stripExportDefault(code) {
  // Remove "export default function Foo" -> "function Foo"
  code = code.replace(/^export\s+default\s+function\s+/m, 'function ');
  // Remove "export default class Foo" -> "class Foo"
  code = code.replace(/^export\s+default\s+class\s+/m, 'class ');
  // Remove standalone "export default Foo;" lines
  code = code.replace(/^export\s+default\s+\w+\s*;?\s*$/m, '');
  return code;
}

function stripNamedExports(code) {
  // Convert "export function Foo" -> "function Foo"
  code = code.replace(/^export\s+(function\s+)/mg, '$1');
  // Convert "export const Foo" -> "const Foo"
  code = code.replace(/^export\s+(const\s+)/mg, '$1');
  // Convert "export class Foo" -> "class Foo"
  code = code.replace(/^export\s+(class\s+)/mg, '$1');
  // Remove "export { ... };" lines
  code = code.replace(/^export\s+\{[^}]*\}\s*;?\s*$/gm, '');
  return code;
}

// ─── Collect component/hook/lib source files ──────────────────────────────────

// Order matters: dependencies before dependents.
const componentFiles = [
  'components/Toaster.jsx',
  'components/ErrorBoundary.jsx',
  'components/CodeBlock.jsx',
  'components/FileExplorer.jsx',
  'components/MarkdownContent.jsx',
  'components/LspStatusBadge.jsx',
  'components/CodeEditor.jsx',
  'components/WebContainerTerminal.jsx',
  'hooks/useFileSystem.js',
];

// ─── CSS ──────────────────────────────────────────────────────────────────────

const cssPath = path.join(SRC, 'index.css');
const rawCss = fs.existsSync(cssPath)
  ? fs.readFileSync(cssPath, 'utf8').replace(/`/g, '\\`').replace(/\$/g, '\\$')
  : '';

const cssInjector = rawCss
  ? `
// ─── Injected CSS ────────────────────────────────────────────────────────────
(function injectStyles() {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('__preview_styles__');
  if (existing) return;
  const style = document.createElement('style');
  style.id = '__preview_styles__';
  style.textContent = \`${rawCss}\`;
  document.head.appendChild(style);
})();
`
  : '';

// ─── Main component ───────────────────────────────────────────────────────────

const mainRaw = fs.readFileSync(path.join(SRC, 'EpiCodeSpaceComplete.jsx'), 'utf8');

// Preserve the top-level React + third-party imports from the main file
const externalImportLines = [];
const mainLines = mainRaw.split('\n');

for (const line of mainLines) {
  const isImport = /^\s*import\s/.test(line);
  if (!isImport) break; // stop at first non-import line
  const isLocal = /from\s+['"](\.|\.\.)[^'"]*['"]/.test(line) || /import\s+['"](\.|\.\.)[^'"]*['"]/.test(line);
  if (!isLocal) externalImportLines.push(line);
}

// Strip ALL imports from main (local + external — we'll re-add external at top)
let mainCode = stripLocalImports(mainRaw);
// Remove the external imports we already captured (they'll go at the top)
mainCode = mainCode.replace(/^\s*import\s[^\n]+\n/gm, '');
// Remove the default export marker so we can re-add it ourselves
mainCode = mainCode.replace(/^export\s+default\s+/m, '// export default (see bottom) \n');

// ─── Process component files ──────────────────────────────────────────────────

const componentSections = componentFiles.map(rel => {
  const raw = readSrc(rel);
  if (!raw) return `// [combine] WARNING: ${rel} not found\n`;
  let code = stripLocalImports(raw);
  code = stripExportDefault(code);
  code = stripNamedExports(code);
  // Strip all remaining import lines (duplicates of what's at the top)
  code = code.replace(/^\s*import\s[^\n]+\n/gm, '');
  return `\n// ─── ${rel} ────────────────────────────────────────────────\n${code.trim()}\n`;
});

// ─── Assemble ─────────────────────────────────────────────────────────────────

const output = [
  '// AUTO-GENERATED by combine.js — do not edit by hand.',
  '// Source files in src/ are untouched.',
  '',
  ...externalImportLines,
  '',
  cssInjector,
  ...componentSections,
  '',
  '// ─── EpiCodeSpaceComplete (main App) ────────────────────────────────────────',
  mainCode.trim(),
  '',
  '// ─── Default export ─────────────────────────────────────────────────────────',
  'export default App;',
  '',
].join('\n');

fs.writeFileSync(OUT, output, 'utf8');
console.log(`✅  Preview.jsx written to ${OUT} (${Math.round(output.length / 1024)} KB)`);
