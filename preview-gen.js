#!/usr/bin/env node
/**
 * preview-gen.js
 * Reads a JSX component + matching CSS from src/ and writes a zero-build
 * index.html that uses Babel Standalone to compile and render the component
 * directly in the browser.
 *
 * Usage:
 *   node preview-gen.js
 *   node preview-gen.js src/PictureEditor.jsx src/PictureEditor.css
 *
 * Default behavior:
 *   1. Use src/PictureEditor.jsx + src/PictureEditor.css when present.
 *   2. Otherwise fall back to src/EpiCodeSpaceComplete.jsx + src/index.css.
 *
 * CRITICAL: Never modifies, overwrites, or deletes any src/ files.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'index.html');

function resolveSourceFiles() {
  const jsxArg = process.argv[2];
  const cssArg = process.argv[3];

  if (jsxArg) {
    return {
      jsxPath: path.resolve(__dirname, jsxArg),
      cssPath: cssArg ? path.resolve(__dirname, cssArg) : null,
      sourceLabel: 'custom',
    };
  }

  const pictureEditorJsx = path.join(SRC, 'PictureEditor.jsx');
  const pictureEditorCss = path.join(SRC, 'PictureEditor.css');
  if (fs.existsSync(pictureEditorJsx)) {
    return {
      jsxPath: pictureEditorJsx,
      cssPath: fs.existsSync(pictureEditorCss) ? pictureEditorCss : null,
      sourceLabel: 'PictureEditor',
    };
  }

  return {
    jsxPath: path.join(SRC, 'EpiCodeSpaceComplete.jsx'),
    cssPath: path.join(SRC, 'index.css'),
    sourceLabel: 'fallback',
  };
}

function detectMountComponentName(code, jsxPath) {
  const defaultNamedFunction = code.match(/export\s+default\s+function\s+([A-Z]\w*)\s*\(/);
  if (defaultNamedFunction) return defaultNamedFunction[1];

  const defaultNamedClass = code.match(/export\s+default\s+class\s+([A-Z]\w*)\s+/);
  if (defaultNamedClass) return defaultNamedClass[1];

  const defaultIdentifier = code.match(/export\s+default\s+([A-Z]\w*)\s*;?/);
  if (defaultIdentifier) return defaultIdentifier[1];

  const componentFromFileName = path.basename(jsxPath).replace(/\.(jsx|tsx|js|ts)$/i, '');
  return componentFromFileName;
}

// ─── Read source files ────────────────────────────────────────────────────────

const { jsxPath, cssPath, sourceLabel } = resolveSourceFiles();

if (!fs.existsSync(jsxPath)) {
  console.error(`❌  JSX source not found: ${path.relative(__dirname, jsxPath)}`);
  console.error('    Usage: node preview-gen.js src/YourComponent.jsx src/YourStyles.css');
  process.exit(1);
}

const rawJsx = fs.readFileSync(jsxPath, 'utf8');
const rawCss = cssPath && fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
const mountComponentName = detectMountComponentName(rawJsx, jsxPath);

// ─── Strip import / export statements ────────────────────────────────────────

let jsx = rawJsx;

// Remove all import lines
jsx = jsx.replace(/^\s*import\s[^\n]*\n?/gm, '');

// Remove "export default function Foo" -> "function Foo"
jsx = jsx.replace(/^export\s+default\s+function\s+/m, 'function ');
// Remove "export default class Foo" -> "class Foo"
jsx = jsx.replace(/^export\s+default\s+class\s+/m, 'class ');
// Remove standalone "export default Foo;"
jsx = jsx.replace(/^export\s+default\s+\w+\s*;?\s*$/m, '');
// Remove "export function / const / class"
jsx = jsx.replace(/^export\s+((?:function|const|let|var|class)\s+)/mg, '$1');
// Remove "export { ... };"
jsx = jsx.replace(/^export\s+\{[^}]*\}\s*;?\s*$/gm, '');

jsx = jsx.trim();

// ─── Detect which React hooks are used ───────────────────────────────────────

const hookNames = [
  'useState', 'useEffect', 'useRef', 'useCallback', 'useMemo',
  'useContext', 'useReducer', 'useLayoutEffect', 'useId',
  'useImperativeHandle', 'useTransition', 'useDeferredValue',
];

const usedHooks = hookNames.filter(h => new RegExp(`\\b${h}\\b`).test(jsx));

const destructure = usedHooks.length
  ? `const { ${usedHooks.join(', ')} } = React;\n`
  : '';

// ─── Assemble the final script block ─────────────────────────────────────────

const scriptContent = `${destructure}\n${jsx}\n\nReactDOM.createRoot(document.getElementById('root')).render(<${mountComponentName} />);`;

// ─── Build HTML ───────────────────────────────────────────────────────────────

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${mountComponentName} Preview</title>

  <!-- React 18 + ReactDOM 18 -->
  <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>

  <!-- Babel Standalone (JSX → JS in-browser) -->
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>

${rawCss ? `  <style>\n${rawCss}\n  </style>` : '  <!-- no CSS found -->'}
</head>
<body>
  <div id="root"></div>

  <script type="text/babel">
${scriptContent.split('\n').map(l => '    ' + l).join('\n')}
  </script>
</body>
</html>
`;

// Safety guard: never write into src/
if (OUT.startsWith(SRC)) {
  console.error('❌  Output path is inside src/ — aborting.');
  process.exit(1);
}

fs.writeFileSync(OUT, html, 'utf8');
console.log(`✅  index.html written (${Math.round(html.length / 1024)} KB)`);
console.log(`    Source: ${path.relative(__dirname, jsxPath)}${cssPath ? ` + ${path.relative(__dirname, cssPath)}` : ''}`);
if (sourceLabel === 'fallback') {
  console.log('    PictureEditor files were not found, so the generator used src/EpiCodeSpaceComplete.jsx + src/index.css.');
}
console.log('    Open with: xdg-open index.html  or  npx serve .');
