# EpiCodeSpace

A web-native AI-powered IDE that runs entirely in the browser, featuring a Monaco code editor, file explorer, terminal (via WebContainers), multi-provider AI chat (OpenAI, Claude, Gemini, DeepSeek), and OPFS-backed persistent storage.

## Run & Operate

- `pnpm --filter @workspace/epicodespace run dev` — run the frontend (port assigned by workflow)
- `pnpm --filter @workspace/api-server run dev` — run the API server (proxies AI chat requests)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- Required env vars:
  - `OPENAI_API_KEY` — for GPT-4o / o3 agents
  - `ANTHROPIC_API_KEY` — for Claude agents
  - `GOOGLE_AI_API_KEY` — for Gemini agents
  - `DEEPSEEK_API_KEY` — for DeepSeek agents
  - `VITE_WEBCONTAINER_APIKEY` — (optional) for WebContainers on non-localhost origins
  - `VITE_ACCESS_PASSWORD_HASH` — (optional) SHA-256 hex hash to enable lock screen

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React 19 + Vite 7, Tailwind CSS v3
- Editor: Monaco Editor + LSP bridge
- Terminal: xterm.js + WebContainers (@webcontainer/api)
- Storage: OPFS (Origin Private File System) via Comlink web worker
- AI: Multi-provider chat proxy (OpenAI, Anthropic, Gemini, DeepSeek)
- API: Express 5 at `/api/chat`

## Where things live

- `artifacts/epicodespace/src/EpiCodeSpaceComplete.jsx` — main app component (monolith)
- `artifacts/epicodespace/src/components/` — extracted sub-components
- `artifacts/epicodespace/src/lib/` — utilities (storage, agentRegistry, modelRouter, fs, lsp, runtime)
- `artifacts/epicodespace/src/hooks/` — custom React hooks
- `artifacts/api-server/src/routes/chat.ts` — AI chat proxy (replaces Vercel serverless function)
- `artifacts/epicodespace/public/` — static assets (icons, manifest, service worker)

## Architecture decisions

- Converted from Vercel serverless function (`api/chat.js`) to Express route (`/api/chat`) — same logic, same provider support
- Vite config adds COOP/COEP headers required by WebContainers (SharedArrayBuffer)
- Tailwind v3 is used (the original project), not the v4 scaffold default
- `index.html` entry point is `src/index.jsx` (the original), not `main.tsx`
- `optimizeDeps.exclude: ['@webcontainer/api']` prevents Vite from double-bundling WebContainers

## Product

EpiCodeSpace is a browser-based IDE where users can edit files, run a terminal, and chat with multiple AI coding assistants (EpiCode Agent, Claude, Gemini, DeepSeek). Files are persisted in OPFS for durability.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- COOP/COEP headers must be set on every response for WebContainers to work
- `VITE_WEBCONTAINER_APIKEY` is set in Replit secrets — do NOT call `configureAPIKey()` with it; the origin is not registered at webcontainers.io and calling it with an unregistered origin causes `WebContainer.boot()` to throw ENOENT
- `WebContainer.mount()` must be called **without** a `mountPoint` option — passing `{ mountPoint: '/home/epicodespace' }` causes ENOENT on Safari/iPadOS because the directory doesn't exist yet at mount time. Files land at `/` root, and the shell starts at `/home/epicodespace` (set by `workdirName`)
- The app uses Tailwind v3 — do not migrate to v4 without testing all custom utilities
- `@webcontainer/api` must be in `optimizeDeps.exclude` or Vite will fail to pre-bundle it
- DeepSeek's `deepseek-coder` model ID is deprecated — only `deepseek-chat` (V3) and `deepseek-reasoner` (R1) are active

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
