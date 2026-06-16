/**
 * terminalServer.ts — WebSocket-backed server-side bash terminal via node-pty.
 *
 * Design
 * ──────
 * 1. Registry fix (the critical one)
 *    Replit injects `registry=http://package-firewall.replit.local` into npm's
 *    global config.  That hostname does NOT resolve in deployed containers
 *    (EAI_AGAIN).  We override it at the highest-precedence level: env vars
 *    (`npm_config_*`).  These beat every .npmrc file, including the one Replit
 *    writes globally.  Result: npm, pnpm, yarn all hit registry.npmjs.org.
 *
 * 2. Correct working directory
 *    `bash --login` may cd to HOME (Replit's /home/runner/workspace) after
 *    reading /etc/profile.  We launch the shell with a two-step wrapper:
 *
 *      bash --login -c "exec bash --rcfile <init-file> -i"
 *
 *    The outer login shell sets up PATH (Nix, node, npm, pnpm…).  The inner
 *    interactive shell reads our init file, which sources the user's real
 *    .bashrc (colors, git-prompt, completions) and then cd's into the synced
 *    session directory.  The user sees their project files immediately.
 *
 * 3. Dev-server detection
 *    Pty output is scanned for "localhost:PORT".  Matched ports are translated
 *    to the Replit proxy URL and sent as a `serverUrl` message.
 *
 * 4. Graceful degradation
 *    node-pty is loaded dynamically at runtime (not as a static ESM import).
 *    If the native binary cannot load in the production container, the HTTP
 *    server still starts, passes health checks, and serves AI chat normally.
 *    Only the terminal WebSocket feature is degraded — clients receive a clear
 *    error message instead of crashing the whole server.
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import type * as PtyTypes from 'node-pty';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { logger } from './logger';

// ── Lazy node-pty loader ──────────────────────────────────────────────────────
//
// node-pty is a native module. A static `import` at the top of this file would
// crash the entire process if the binary is incompatible with the production
// container. Instead we load it once on first use and cache the result (or the
// error). If it fails, the HTTP server continues to serve chat and health checks.

type PtyModule = typeof PtyTypes;

let _ptyModule: PtyModule | null = null;
let _ptyError: string | null = null;
let _ptyLoading: Promise<PtyModule | null> | null = null;

function loadPty(): Promise<PtyModule | null> {
  if (_ptyLoading) return _ptyLoading;
  _ptyLoading = import('node-pty')
    .then((mod) => {
      _ptyModule = mod as unknown as PtyModule;
      logger.info('node-pty loaded successfully');
      return _ptyModule;
    })
    .catch((err: unknown) => {
      _ptyError = (err instanceof Error) ? err.message : String(err);
      logger.error({ err }, 'node-pty failed to load — terminal feature unavailable');
      return null;
    });
  return _ptyLoading;
}

// Begin loading eagerly so it's ready before the first WebSocket connection.
loadPty().catch(() => {});

// ── Port URL helper ────────────────────────────────────────────────────────────

function getPortUrl(port: number): string | null {
  const devDomain = process.env['REPLIT_DEV_DOMAIN'];
  if (!devDomain) return null;
  if (devDomain.includes('-00-')) return `https://${devDomain.replace('-00-', `-${port}-`)}`;
  return `https://${port}-${devDomain}`;
}

const ANSI_RE      = /\x1b\[[0-9;]*[A-Za-z]/g;
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/g;

// ── Session init file ─────────────────────────────────────────────────────────

/**
 * Write a bash init file for the interactive shell that:
 *   - sources the user's real ~/.bashrc (prompt, colors, git-branch indicator)
 *   - re-exports correct npm registry env vars (belt-and-suspenders)
 *   - cd's into the session project directory
 *
 * We use a two-stage launch so that the login shell still sets up PATH
 * (Nix, Node, pnpm, etc.) while our init file controls the cwd.
 */
async function writeSessionInit(sessionDir: string): Promise<string> {
  const initFile = path.join(sessionDir, '.term-init');

  // NOTE: no esbuild template issues here — this is written to a file, not
  // embedded as a TS template literal.  The ${sessionDir} below is TypeScript.
  const script = [
    '#!/usr/bin/env bash',
    '# ── EpiCodeSpace terminal init ─────────────────────────────────────',
    '',
    '# Source the user real .bashrc for git-prompt, colors, completions, etc.',
    '[ -r "${HOME}/.bashrc" ] && . "${HOME}/.bashrc"',
    '',
    '# Override npm/pnpm/yarn registry — Replit private registry (package-firewall)',
    '# is only reachable from the dev workspace, not deployed containers.',
    'export npm_config_registry=https://registry.npmjs.org',
    'export npm_config_update_notifier=false',
    'export npm_config_fund=false',
    'export npm_config_audit=false',
    'export NO_UPDATE_NOTIFIER=1',
    'export DISABLE_OPENCOLLECTIVE=1',
    '',
    '# Start in the session project directory',
    `cd "${sessionDir}" 2>/dev/null`,
    '',
    '# Write a project-level .npmrc as belt-and-suspenders for tools that',
    '# read it from the cwd and ignore env vars (some old pnpm versions do).',
    `cat > "${sessionDir}/.npmrc" <<'__NPMRC__'`,
    'registry=https://registry.npmjs.org',
    'update-notifier=false',
    'fund=false',
    'audit=false',
    '__NPMRC__',
  ].join('\n');

  await fs.writeFile(initFile, script, { mode: 0o644 });
  return initFile;
}

// ── WebSocket server ──────────────────────────────────────────────────────────

export function attachTerminalServer(server: http.Server): void {
  const wss = new WebSocketServer({ server, path: '/api/terminal' });
  logger.info({ path: '/api/terminal' }, 'terminal WebSocket server attached');
  wss.on('connection', (ws) => handleConnection(ws));
}

// ── Per-connection handler ────────────────────────────────────────────────────

function handleConnection(ws: WebSocket): void {
  const sessionId  = randomUUID().slice(0, 8);
  const sessionDir = path.join(os.tmpdir(), `epicode-${sessionId}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ptyProcess: any = null;
  const announcedPorts = new Set<number>();

  const send = (msg: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const cleanup = () => {
    if (ptyProcess) {
      try { ptyProcess.kill(); } catch { /* ignore */ }
      ptyProcess = null;
    }
    fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    logger.info({ sessionId }, 'terminal session cleaned up');
  };

  const scanForPorts = (raw: string) => {
    const clean = raw.replace(ANSI_RE, '');
    LOCAL_URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LOCAL_URL_RE.exec(clean)) !== null) {
      const port = Number(m[1]);
      if (!announcedPorts.has(port)) {
        announcedPorts.add(port);
        const url = getPortUrl(port);
        if (url) {
          send({ type: 'serverUrl', port, url });
          logger.info({ sessionId, port, url }, 'detected dev-server port');
        }
      }
    }
  };

  ws.on('message', async (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── sync: initial session bootstrap ──────────────────────────────────
    if (msg.type === 'sync') {
      try {
        // Ensure node-pty is available before starting the session
        const pty = await loadPty();
        if (!pty) {
          send({
            type: 'error',
            message: `Terminal unavailable: node-pty could not load in this environment. ${_ptyError ?? ''}`,
          });
          return;
        }

        await fs.mkdir(sessionDir, { recursive: true });

        // Write synced editor files
        const files: Record<string, string> = msg.files ?? {};
        await Promise.all(
          Object.entries(files).map(async ([filePath, content]) => {
            const full = path.join(sessionDir, filePath);
            await fs.mkdir(path.dirname(full), { recursive: true });
            await fs.writeFile(full, String(content), 'utf8');
          })
        );

        // Write bash init file
        const initFile = await writeSessionInit(sessionDir);

        // Two-stage launch:
        //   Stage 1 — bash --login: reads /etc/profile, sets up Nix PATH,
        //             makes node/npm/pnpm/yarn/git/etc. available.
        //   Stage 2 — exec bash --rcfile <initFile> -i: starts the interactive
        //             shell from our init file which cds into the session dir.
        ptyProcess = pty.spawn('bash', [
          '--login',
          '-c',
          `exec bash --rcfile "${initFile}" -i`,
        ], {
          name: 'xterm-256color',
          cols: Number(msg.cols) || 80,
          rows: Number(msg.rows) || 24,
          cwd: sessionDir,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            // Env-var registry override — highest precedence, beats all .npmrc files.
            // Set here so child processes spawned by npm scripts inherit it too.
            npm_config_registry: 'https://registry.npmjs.org',
            npm_config_update_notifier: 'false',
            npm_config_fund: 'false',
            npm_config_audit: 'false',
            npm_config_loglevel: 'warn',
            npm_config_cache: `${sessionDir}/.npm-cache`,
            NO_UPDATE_NOTIFIER: '1',
            DISABLE_OPENCOLLECTIVE: '1',
            SUPPRESS_JEST_WARNINGS: '1',
          } as Record<string, string>,
        });

        ptyProcess.onData((data: string) => {
          send({ type: 'output', data });
          scanForPorts(data);
        });

        ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
          send({ type: 'exit', exitCode });
          ptyProcess = null;
        });

        send({ type: 'ready', cwd: sessionDir });
        logger.info(
          { sessionId, cwd: sessionDir, fileCount: Object.keys(files).length },
          'terminal session started',
        );
      } catch (err: any) {
        const message = err?.message ?? String(err);
        send({ type: 'error', message });
        logger.error({ sessionId, err }, 'terminal spawn failed');
      }

    // ── input: keystroke forwarding ───────────────────────────────────────
    } else if (msg.type === 'input') {
      ptyProcess?.write(msg.data);

    // ── resize ────────────────────────────────────────────────────────────
    } else if (msg.type === 'resize') {
      const cols = Number(msg.cols);
      const rows = Number(msg.rows);
      if (cols > 0 && rows > 0) ptyProcess?.resize(cols, rows);

    // ── writeFile: live editor-to-server sync ─────────────────────────────
    } else if (msg.type === 'writeFile') {
      try {
        const full = path.join(sessionDir, String(msg.path));
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, String(msg.content ?? ''), 'utf8');
      } catch { /* ignore */ }
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
