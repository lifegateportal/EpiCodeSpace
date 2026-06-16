/**
 * terminalServer.ts — WebSocket-backed server-side bash terminal via node-pty.
 *
 * Design
 * ──────
 * 1. Registry fix
 *    Replit injects `registry=http://package-firewall.replit.local` into npm's
 *    global config.  That hostname does NOT resolve in deployed containers
 *    (EAI_AGAIN).  We override it at the highest-precedence level: env vars
 *    (`npm_config_*`).  These beat every .npmrc file.
 *
 * 2. NODE_ENV override
 *    The API server runs with NODE_ENV=production.  npm respects this and
 *    silently skips devDependencies, so tools like vite are never installed.
 *    We always set NODE_ENV=development inside the pty so the user's project
 *    gets its full dep tree.
 *
 * 3. Correct working directory
 *    Two-stage bash launch so PATH is correct AND the shell starts in the
 *    project dir:
 *      bash --login -c "exec bash --rcfile <init-file> -i"
 *
 * 4. Session persistence
 *    Each pty session is kept alive for SESSION_KEEPALIVE_MS after its
 *    WebSocket disconnects.  The client stores the session ID in sessionStorage
 *    and sends it on reconnect.  If the session is still alive the new socket
 *    is transparently reattached — no re-install needed.
 *
 * 5. Graceful degradation
 *    node-pty is loaded dynamically at runtime.  If the native binary cannot
 *    load in the production container the HTTP server still starts and passes
 *    health checks; only the terminal WebSocket feature is degraded.
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

loadPty().catch(() => {});

// ── Session registry ──────────────────────────────────────────────────────────
//
// Sessions survive WebSocket disconnects for SESSION_KEEPALIVE_MS.  The client
// sends its stored session ID on reconnect; if the session is still alive the
// new socket is reattached without spawning a new shell.

const SESSION_KEEPALIVE_MS = 10 * 60 * 1000; // 10 minutes

interface SessionEntry {
  id: string;
  ptyProcess: any;
  sessionDir: string;
  ws: WebSocket | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  onData: (data: string) => void;
  onExit: (ev: { exitCode: number }) => void;
}

const sessions = new Map<string, SessionEntry>();

function destroySession(entry: SessionEntry): void {
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }
  try { entry.ptyProcess?.kill(); } catch { /* ignore */ }
  fs.rm(entry.sessionDir, { recursive: true, force: true }).catch(() => {});
  sessions.delete(entry.id);
  logger.info({ sessionId: entry.id }, 'terminal session destroyed');
}

function scheduleDestroy(entry: SessionEntry): void {
  if (entry.cleanupTimer) return;
  entry.cleanupTimer = setTimeout(() => {
    logger.info({ sessionId: entry.id }, 'terminal session expired (keepalive timeout)');
    destroySession(entry);
  }, SESSION_KEEPALIVE_MS);
}

function cancelDestroy(entry: SessionEntry): void {
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }
}

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

async function writeSessionInit(sessionDir: string): Promise<string> {
  const initFile = path.join(sessionDir, '.term-init');

  const script = [
    '#!/usr/bin/env bash',
    '# ── EpiCodeSpace terminal init ─────────────────────────────────────',
    '',
    '[ -r "${HOME}/.bashrc" ] && . "${HOME}/.bashrc"',
    '',
    '# Override npm/pnpm/yarn registry',
    'export npm_config_registry=https://registry.npmjs.org',
    'export npm_config_update_notifier=false',
    'export npm_config_fund=false',
    'export npm_config_audit=false',
    'export NO_UPDATE_NOTIFIER=1',
    'export DISABLE_OPENCOLLECTIVE=1',
    '# Always use development so npm installs devDependencies',
    'export NODE_ENV=development',
    '',
    `cd "${sessionDir}" 2>/dev/null`,
    '',
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
  let session: SessionEntry | null = null;
  const announcedPorts = new Set<number>();

  const send = (msg: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
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
          if (session) logger.info({ sessionId: session.id, port, url }, 'detected dev-server port');
        }
      }
    }
  };

  const detachSession = () => {
    if (!session) return;
    session.ws = null;
    scheduleDestroy(session);
    logger.info({ sessionId: session.id }, 'WebSocket detached — session kept alive');
  };

  ws.on('message', async (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── sync: bootstrap or reconnect ─────────────────────────────────────
    if (msg.type === 'sync') {

      // ── Try to reconnect to an existing session ───────────────────────
      const reconnectId: string | undefined = msg.sessionId;
      if (reconnectId) {
        const existing = sessions.get(reconnectId);
        if (existing && existing.ptyProcess) {
          // Reattach
          cancelDestroy(existing);
          existing.ws = ws;
          session = existing;

          // Swap the per-session send callbacks so output goes to new socket
          existing.onData = (data: string) => {
            send({ type: 'output', data });
            scanForPorts(data);
          };

          // Sync any updated files the editor has
          const files: Record<string, string> = msg.files ?? {};
          await Promise.all(
            Object.entries(files).map(async ([filePath, content]) => {
              const full = path.join(existing.sessionDir, filePath);
              await fs.mkdir(path.dirname(full), { recursive: true });
              await fs.writeFile(full, String(content), 'utf8');
            })
          );

          send({ type: 'ready', cwd: existing.sessionDir, sessionId: existing.id, reconnected: true });
          logger.info({ sessionId: existing.id }, 'terminal session reconnected');
          return;
        }
      }

      // ── Create new session ────────────────────────────────────────────
      try {
        const pty = await loadPty();
        if (!pty) {
          send({
            type: 'error',
            message: `Terminal unavailable: node-pty could not load in this environment. ${_ptyError ?? ''}`,
          });
          return;
        }

        const sessionId  = randomUUID().slice(0, 8);
        const sessionDir = path.join(os.tmpdir(), `epicode-${sessionId}`);
        await fs.mkdir(sessionDir, { recursive: true });

        const files: Record<string, string> = msg.files ?? {};
        await Promise.all(
          Object.entries(files).map(async ([filePath, content]) => {
            const full = path.join(sessionDir, filePath);
            await fs.mkdir(path.dirname(full), { recursive: true });
            await fs.writeFile(full, String(content), 'utf8');
          })
        );

        const initFile = await writeSessionInit(sessionDir);

        const entry: SessionEntry = {
          id: sessionId,
          sessionDir,
          ws,
          cleanupTimer: null,
          ptyProcess: null,
          onData: (data: string) => { send({ type: 'output', data }); scanForPorts(data); },
          onExit: ({ exitCode }: { exitCode: number }) => { send({ type: 'exit', exitCode }); },
        };

        const ptyProcess = pty.spawn('bash', [
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
            // Always development so user projects get devDependencies
            NODE_ENV: 'development',
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

        entry.ptyProcess = ptyProcess;

        ptyProcess.onData((data: string) => entry.onData(data));
        ptyProcess.onExit((ev: { exitCode: number }) => {
          entry.onExit(ev);
          entry.ptyProcess = null;
          scheduleDestroy(entry);
        });

        session = entry;
        sessions.set(sessionId, entry);

        send({ type: 'ready', cwd: sessionDir, sessionId });
        logger.info(
          { sessionId, cwd: sessionDir, fileCount: Object.keys(files).length },
          'terminal session started',
        );
      } catch (err: any) {
        const message = err?.message ?? String(err);
        send({ type: 'error', message });
        logger.error({ err }, 'terminal spawn failed');
      }

    // ── input ─────────────────────────────────────────────────────────────
    } else if (msg.type === 'input') {
      session?.ptyProcess?.write(msg.data);

    // ── resize ────────────────────────────────────────────────────────────
    } else if (msg.type === 'resize') {
      const cols = Number(msg.cols);
      const rows = Number(msg.rows);
      if (cols > 0 && rows > 0) session?.ptyProcess?.resize(cols, rows);

    // ── writeFile ─────────────────────────────────────────────────────────
    } else if (msg.type === 'writeFile') {
      if (!session) return;
      try {
        const full = path.join(session.sessionDir, String(msg.path));
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, String(msg.content ?? ''), 'utf8');
      } catch { /* ignore */ }
    }
  });

  ws.on('close', detachSession);
  ws.on('error', detachSession);
}
