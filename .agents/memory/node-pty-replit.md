---
name: node-pty on Replit
description: How to get node-pty to compile its native addon in the Replit NixOS environment
---

node-pty uses node-gyp which requires Python3. Python3 is NOT installed by default in the Replit nodejs-24 module.

**Fix:** call `installSystemDependencies({ packages: ["python3"] })` in the code_execution sandbox before running `pnpm install`.

**Why:** pnpm blocks build scripts by default ("Ignored build scripts: node-pty@1.1.0"); you must add `node-pty` to `onlyBuiltDependencies` in `pnpm-workspace.yaml`, AND Python3 must be present for node-gyp to succeed.

**How to apply:** Any time node-pty (or other native addons requiring Python/node-gyp) are added to the project, install python3 first, then run pnpm install.

**Verify:** `ls node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/build/Release/*.node`
