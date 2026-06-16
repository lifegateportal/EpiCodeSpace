---
name: WebContainer boot and mount rules
description: Rules for WebContainer.boot() and mount() that must not be broken — violations cause ENOENT on Safari/iPadOS
---

## Rule: never pass mountPoint to mount()

`rawContainer.mount(tree)` — no second argument.

Passing `{ mountPoint: '/home/epicodespace' }` causes ENOENT on Safari/iPadOS because that path doesn't exist in the WASM VFS at mount time. Files land at `/` root; the shell cwd is `/home/epicodespace` (set by `workdirName`).

**Why:** Confirmed via git bisect — commit `9679442` added mountPoint and that's the root cause of all the ENOENT chasing in this session.

**How to apply:** In `WebContainerBridge.ts`, both `boot()` and `syncFiles()` call `c.mount(tree)` with no options. Never add a second arg without testing on iPadOS Safari first.

## Rule: never call configureAPIKey() with VITE_WEBCONTAINER_APIKEY

The env var is set in Replit secrets but the origin (`epi-code-space.replit.app`, `*.replit.dev`) is NOT registered at webcontainers.io. Calling `configureAPIKey(key)` with an unregistered origin causes `WebContainer.boot()` to throw ENOENT.

**Why:** `configureAPIKey` appends `client_id=<key>` to the stackblitz.com headless iframe URL. The server rejects unregistered origins with ENOENT.

**How to apply:** Keep the `configureAPIKey` block commented out in `WebContainerBridge.ts` until the origin is registered at webcontainers.io.

## Rule: deepseek-coder model ID is deprecated

Only `deepseek-chat` (V3) and `deepseek-reasoner` (R1) are active on DeepSeek's API. `deepseek-coder` returns weak/old responses.

**How to apply:** Model router defaults to `deepseek-chat`. Do not re-add `deepseek-coder` to allowed models.
