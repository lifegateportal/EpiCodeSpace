/**
 * previewProxy.ts — Dynamic HTTP proxy for user dev servers.
 *
 * When the terminal detects a dev server on localhost:PORT, the client is
 * given a URL like /api/preview/<sessionId>/.  This middleware proxies those
 * requests to the correct localhost port looked up from the session registry.
 *
 * Mounted in app.ts BEFORE the /api Express router so that body-parsing
 * middleware does not consume streaming proxy bodies.
 */

import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import type { Request, Response, NextFunction } from 'express';
import { getSessionPort } from './terminalServer';

function getSessionIdFromUrl(rawUrl: string | undefined): string {
  return (rawUrl ?? '/').split('/').filter(Boolean)[0] ?? '';
}

function getSessionPrefix(req: Request): string {
  const sessionId = getSessionIdFromUrl(req.url);
  return sessionId ? `/api/preview/${sessionId}` : '/api/preview';
}

function rewritePreviewPayload(body: string, sessionPrefix: string): string {
  return body.replace(
    /(["'(=:,\s])\/(?!\/|api\/preview\/)/g,
    `$1${sessionPrefix}/`,
  );
}

function shouldRewriteBody(contentType: string): boolean {
  return /^(text\/html|text\/css|application\/javascript|text\/javascript|application\/json)\b/i.test(contentType);
}

// http-proxy-middleware is loaded once; the dynamic `router` function picks
// the correct upstream target per-request based on the session ID in the path.
const _proxy = createProxyMiddleware<Request, Response>({
  changeOrigin: true,
  selfHandleResponse: true,
  // req.url here is relative to the /api/preview mount point:
  //   /api/preview/<sessionId>/path  →  req.url = /<sessionId>/path
  router: (req) => {
    const sessionId = getSessionIdFromUrl(req.url);
    const port = sessionId ? getSessionPort(sessionId) : null;
    if (!port) return undefined as any;
    return `http://localhost:${port}`;
  },
  // Strip the /<sessionId> segment so the upstream sees the real path
  pathRewrite: (reqPath) => reqPath.replace(/^\/[^/]+/, '') || '/',
  on: {
    // Remove cross-origin isolation headers from proxied responses so that
    // the user's app can load third-party scripts and images freely.
    proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req) => {
      delete proxyRes.headers['cross-origin-opener-policy'];
      delete proxyRes.headers['cross-origin-embedder-policy'];
      delete proxyRes.headers['cross-origin-resource-policy'];

      const location = proxyRes.headers.location;
      const sessionPrefix = getSessionPrefix(req);
      if (typeof location === 'string' && location.startsWith('/')) {
        proxyRes.headers.location = `${sessionPrefix}${location}`;
      }

      const contentType = String(proxyRes.headers['content-type'] ?? '');
      if (!shouldRewriteBody(contentType)) {
        return responseBuffer;
      }

      const rewritten = rewritePreviewPayload(responseBuffer.toString('utf8'), sessionPrefix);
      return rewritten;
    }),
    error: (_err, _req, res) => {
      const r = res as Response;
      if (!r.headersSent) {
        r.status(503).send(
          'Preview unavailable — make sure your app is running in the terminal.',
        );
      }
    },
  },
});

export function previewProxy(req: Request, res: Response, next: NextFunction): void {
  // Guard: if the session ID is unknown or no port is stored, return 503
  // immediately rather than letting the proxy throw.
  const sessionId = getSessionIdFromUrl(req.url);
  const port = sessionId ? getSessionPort(sessionId) : null;
  if (!port) {
    res.status(503).send(
      'Preview unavailable — make sure your app is running in the terminal.',
    );
    return;
  }
  (_proxy as any)(req, res, next);
}
