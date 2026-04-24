const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const cssPath = path.join(rootDir, 'src', 'PictureEditor.css');
const jsxPath = path.join(rootDir, 'src', 'PictureEditor.jsx');
const outputPath = path.join(rootDir, 'index.html');

const css = fs.readFileSync(cssPath, 'utf8');
const jsx = fs.readFileSync(jsxPath, 'utf8');

const jsxWithoutImports = jsx.replace(/^\s*import[\s\S]*?;\s*$/gm, '');
const jsxWithoutExportDefault = jsxWithoutImports.replace(/\bexport\s+default\s+/g, '');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Instant Preview</title>
    <style>
${css}
    </style>
  </head>
  <body>
    <div id="root"></div>

    <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>

    <script type="text/babel">
      const { useState, useRef, useEffect, useCallback } = React;

${jsxWithoutExportDefault}

      const RootComponent =
        typeof PictureEditor !== 'undefined'
          ? PictureEditor
          : typeof App !== 'undefined'
            ? App
            : null;

      ReactDOM.createRoot(document.getElementById('root')).render(
        RootComponent ? <RootComponent /> : <div>Could not find a root component to render.</div>
      );
    </script>
  </body>
</html>
`;

fs.writeFileSync(outputPath, html, 'utf8');
console.log(`Generated ${path.basename(outputPath)} from src/PictureEditor.css and src/PictureEditor.jsx`);