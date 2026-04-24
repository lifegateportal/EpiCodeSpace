const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const srcDir = path.join(rootDir, 'src');
const outputPath = path.join(rootDir, 'index.html');

const excludedFiles = new Set(['pictureeditor.css', 'pictureeditor.jsx', 'pictureedoitor.jsx']);
const files = fs.readdirSync(srcDir);

let combinedCss = '';
let combinedJsx = '';
let indexJsx = '';

for (const file of files) {
  if (excludedFiles.has(file.toLowerCase())) {
    continue;
  }

  const fullPath = path.join(srcDir, file);
  if (!fs.statSync(fullPath).isFile()) {
    continue;
  }

  if (file.endsWith('.css')) {
    combinedCss += `${fs.readFileSync(fullPath, 'utf8')}\n`;
    continue;
  }

  if (file.endsWith('.jsx')) {
    const jsx = fs.readFileSync(fullPath, 'utf8');
    const cleanedJsx = jsx
      .replace(/^\s*import[\s\S]*?;\s*$/gm, '')
      .replace(/^\s*export\s+default\s+/gm, '')
      .replace(/^\s*export\s+/gm, '')
      .trim();

    if (file === 'index.jsx') {
      indexJsx = cleanedJsx;
    } else {
      combinedJsx += `${cleanedJsx}\n\n`;
    }
  }
}

const finalJsx = `${combinedJsx.trim()}\n\n${indexJsx.trim()}`
  .replace(/createRoot/g, 'ReactDOM.createRoot')
  .trim();

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Instant Preview</title>
    <style>
  ${combinedCss.trim()}
    </style>
  </head>
  <body>
    <div id="root"></div>

    <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>

    <script type="text/babel">
      const { useState, useRef, useEffect, useCallback } = React;

${finalJsx}
    </script>
  </body>
</html>
`;

fs.writeFileSync(outputPath, html, 'utf8');
console.log(`Generated ${path.basename(outputPath)} from files in src/`);