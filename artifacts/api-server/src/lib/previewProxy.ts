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

import { createProxyMiddleware } from 'http-proxy-middleware';
import type { Request, Response, NextFunction } from 'express';
import { getSessionPort } from './terminalServer';

// http-proxy-middleware is loaded once; the dynamic `router` function picks
// the correct upstream target per-request based on the session ID in the path.
const _proxy = createProxyMiddleware<Request, Response>({
  changeOrigin: true,
  // req.url here is relative to the /api/preview mount point:
  //   /api/preview/<sessionId>/path  →  req.url = /<sessionId>/path
  router: (req) => {
    const sessionId = (req.url ?? '/').split('/').filter(Boolean)[0];
    const port = sessionId ? getSessionPort(sessionId) : null;
    if (!port) return undefined as any;
    return `http://localhost:${port}`;
  },
  // Strip the /<sessionId> segment so the upstream sees the real path
  pathRewrite: (reqPath) => reqPath.replace(/^\/[^/]+/, '') || '/',
  on: {
    // Remove cross-origin isolation headers from proxied responses so that
    // the user's app can load third-party scripts and images freely.
    proxyRes: (proxyRes) => {
      delete proxyRes.headers['cross-origin-opener-policy'];
      delete proxyRes.headers['cross-origin-embedder-policy'];
      delete proxyRes.headers['cross-origin-resource-policy'];
    },
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
  const sessionId = (req.url ?? '/').split('/').filter(Boolean)[0];
  const port = sessionId ? getSessionPort(sessionId) : null;
  if (!port) {
    res.status(503).send(
      'Preview unavailable — make sure your app is running in the terminal.',
    );
    return;
  }
  (_proxy as any)(req, res, next);
}
