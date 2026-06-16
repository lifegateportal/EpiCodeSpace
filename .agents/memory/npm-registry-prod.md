---
name: npm registry in production
description: Fix for EAI_AGAIN on package-firewall.replit.local in deployed containers + cwd setup
---

## Problem
Replit injects `registry=http://package-firewall.replit.local` into the global npm config (via the Nix environment). This hostname only resolves inside the Replit dev workspace. In deployed (autoscale) containers, DNS fails with `EAI_AGAIN`, breaking every `npm install` / `pnpm install`.

Additionally, `bash --login` in the Replit dev container reads `/etc/profile` which does `cd ~/workspace`, moving the shell out of the synced session dir. This is dev-only; production containers start in the correct place.

## Fix applied (terminalServer.ts)

1. **Env var override** — set `npm_config_registry=https://registry.npmjs.org` in the pty env. Env vars are highest-precedence for npm/pnpm/yarn, beating all .npmrc files. Also set other noise-reduction vars: `npm_config_fund`, `npm_config_audit`, `NO_UPDATE_NOTIFIER`, etc.

2. **Two-stage bash launch** to ensure correct cwd:
   ```
   bash --login -c "exec bash --rcfile <session-init-file> -i"
   ```
   - Outer `bash --login`: reads /etc/profile → sets Nix PATH (node, npm, pnpm, git…)
   - Inner `bash --rcfile`: reads our `.term-init` → sources `~/.bashrc` for prompt/colors, then `cd "${sessionDir}"`

3. **Project-level .npmrc** written inside session dir (via the rcfile) as belt-and-suspenders for tools that read cwd `.npmrc` before env vars.

## What NOT to do
- Don't use npm→pnpm wrapper scripts — they don't fix the registry and break the "real npm" expectation
- Don't override HOME to redirect ~/.npmrc — /etc/profile in Replit resets HOME anyway, making the override useless
- Don't add npm_config_jobs or similar parallelism limits — they don't fix registry errors

## When to apply
Any terminal session spawned in a deployed (autoscale) Replit container. The fix is in `artifacts/api-server/src/lib/terminalServer.ts` in the `sync` message handler.
