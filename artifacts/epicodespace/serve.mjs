import { createServer } from 'http';
import { createReadStream, statSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, 'dist/public');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain',
};

// These headers enable window.crossOriginIsolated = true, required for WebContainers.
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

const server = createServer((req, res) => {
  for (const [k, v] of Object.entries(ISOLATION_HEADERS)) {
    res.setHeader(k, v);
  }

  const urlPath = req.url.split('?')[0];
  const filePath = join(ROOT, urlPath);
  const candidates = [filePath, join(ROOT, 'index.html')];
  const found = candidates.find(isFile);

  if (!found) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const ext = extname(found);
  const mime = MIME[ext] || 'application/octet-stream';
  const isHtml = ext === '.html';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', isHtml ? 'no-cache' : 'public, max-age=31536000, immutable');
  res.writeHead(200);
  createReadStream(found).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`EpiCodeSpace serving ${ROOT} on port ${PORT} with cross-origin isolation`);
});
