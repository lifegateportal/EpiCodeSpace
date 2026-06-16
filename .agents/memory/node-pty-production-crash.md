---
name: node-pty static import crash in Cloud Run
description: Static ESM import of node-pty crashes the whole server if the native binary is incompatible with the production container — use dynamic import with graceful fallback instead.
---

# node-pty native module — production crash pattern

## The Rule
Never use a static top-level ESM import for node-pty (or any native `.node` module) in a server that must pass a health check.

## Why
`import * as pty from 'node-pty'` is resolved synchronously at module-load time. If the native binary (`pty.node`) is incompatible with the production container (e.g. glibc version mismatch in Cloud Run vs. Nix dev env), Node throws during the import — causing the *entire* entry-point module chain to fail. The server never binds its port, every health check returns 500 (connection refused remapped), and the deployment is stuck failing.

## How to Apply
Use a lazy dynamic import with error catching:

```ts
import type * as PtyTypes from 'node-pty';
let _ptyLoading: Promise<typeof PtyTypes | null> | null = null;

function loadPty() {
  if (_ptyLoading) return _ptyLoading;
  _ptyLoading = import('node-pty').catch(err => {
    logger.error({ err }, 'node-pty failed — terminal unavailable');
    return null;
  });
  return _ptyLoading;
}
// Kick off eagerly at module init so it's ready before first connection
loadPty().catch(() => {});
```

In the WebSocket handler, await `loadPty()` and send an error message to the client if null — don't crash the server.

**Why it's safe:** The HTTP server (`server.listen(port, ...)`) and all other routes are unaffected. Health checks pass. Only the terminal WebSocket feature degrades gracefully.
