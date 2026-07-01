import { createServer, request as httpRequest } from 'http';
import { spawn } from 'child_process';
import { createReadStream, statSync } from 'fs';
import { join, extname, normalize, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, 'dist/public');
const PORT = Number(process.env.PORT) || 3000;
const API_SIDECAR_PORT = process.env.API_SIDECAR_PORT || '18080';
const API_ORIGIN = process.env.API_ORIGIN || `http://127.0.0.1:${API_SIDECAR_PORT}`;
const API_ENTRY = resolve(__dirname, 'dist/api-server/index.mjs');

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

if (!isFile(join(ROOT, 'index.html'))) {
  throw new Error(`Missing frontend build output at ${ROOT}. Run the frontend build before starting the static server.`);
}

if (!process.env.API_ORIGIN && process.env.START_API_SIDECAR !== '0' && isFile(API_ENTRY)) {
  const apiUrl = new URL(API_ORIGIN);
  const child = spawn(process.execPath, ['--enable-source-maps', API_ENTRY], {
    env: {
      ...process.env,
      PORT: apiUrl.port || API_SIDECAR_PORT,
      NODE_ENV: 'production',
    },
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    console.warn(`EpiCodeSpace API sidecar exited: ${signal || code}`);
  });
}

function resolveRequestPath(urlPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const normalizedPath = normalize(decodedPath.replace(/^\/+/, ''));
  const candidatePath = resolve(ROOT, normalizedPath);
  const rootPrefix = `${ROOT}${sep}`;

  if (candidatePath !== ROOT && !candidatePath.startsWith(rootPrefix)) {
    return null;
  }

  return candidatePath;
}

function proxyApiRequest(req, res) {
  const target = new URL(req.url || '/', API_ORIGIN);
  const proxyReq = httpRequest(target, {
    method: req.method,
    headers: {
      ...req.headers,
      host: target.host,
    },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.statusMessage, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('API proxy unavailable');
  });

  req.pipe(proxyReq);
}

const server = createServer((req, res) => {
  if ((req.url || '').startsWith('/api/')) {
    proxyApiRequest(req, res);
    return;
  }

  for (const [k, v] of Object.entries(ISOLATION_HEADERS)) {
    res.setHeader(k, v);
  }

  const urlPath = (req.url || '/').split('?')[0];
  const filePath = resolveRequestPath(urlPath);

  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

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

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});

  if (!(req.url || '').startsWith('/api/')) {
    socket.destroy();
    return;
  }

  const target = new URL(req.url || '/', API_ORIGIN);
  const proxyReq = httpRequest(target, {
    method: req.method,
    headers: {
      ...req.headers,
      host: target.host,
      connection: 'Upgrade',
      upgrade: req.headers.upgrade || 'websocket',
    },
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    proxySocket.on('error', () => socket.destroy());
    socket.on('close', () => proxySocket.destroy());

    socket.write([
      `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}`,
      ...Object.entries(proxyRes.headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`),
      '',
      '',
    ].join('\r\n'));
    if (proxyHead.length) socket.write(proxyHead);
    if (head.length) proxySocket.write(head);
    proxySocket.pipe(socket).pipe(proxySocket);
  });

  proxyReq.on('error', () => socket.destroy());
  proxyReq.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`EpiCodeSpace serving ${ROOT} on port ${PORT} with cross-origin isolation`);
});
