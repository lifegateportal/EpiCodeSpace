import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as pty from 'node-pty';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { logger } from './logger';

// ── Resolve real binary paths once at startup ────────────────────────────────

function which(bin: string): string {
  try { return execFileSync('which', [bin], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

const REAL_NPM  = which('npm')  || '/usr/bin/npm';
const REAL_PNPM = which('pnpm') || '';

/**
 * npm 11 + Node 24 crashes with "Exit handler never called!" in production
 * containers because npm's internal worker threads get SIGKILL'd before they
 * can call the exit handler (OOM / PID-limit / seccomp).
 *
 * Fix: write a tiny bash wrapper that silently redirects `npm install` /
 * `npm run` → `pnpm`, which doesn't use the same worker-thread IPC.
 * The user never has to change their commands.
 */
async function writeNpmWrapper(fakeBinDir: string): Promise<void> {
  const hasPnpm = Boolean(REAL_PNPM);

  // npm wrapper
  // Note: \${...} escapes prevent esbuild from treating bash ${@:2} etc.
  // as TypeScript template expressions — only ${REAL_PNPM}/${REAL_NPM} are
  // intentionally interpolated at build time.
  const npmScript = hasPnpm
    ? `#!/usr/bin/env bash
# Transparent npm → pnpm redirect (npm 11+Node 24 crashes in containers).
case "$1" in
  install|i|ci|add|uninstall|remove|rm|update|up)
    printf '\\033[36m[terminal] npm → pnpm %s\\033[0m\\n' "$*" >&2
    exec ${REAL_PNPM} "\$@"
    ;;
  run)
    exec ${REAL_PNPM} run "\${@:2}"
    ;;
  exec|x)
    exec ${REAL_PNPM} exec "\${@:2}"
    ;;
  *)
    exec ${REAL_NPM} "\$@"
    ;;
esac
`
    : `#!/usr/bin/env bash
# pnpm not found — fall back to real npm with minimal flags.
exec ${REAL_NPM} --foreground-scripts --jobs=1 --no-audit --no-fund "\$@"
`;

  const npxScript = hasPnpm
    ? `#!/usr/bin/env bash
exec ${REAL_PNPM} exec "\$@"
`
    : `#!/usr/bin/env bash
exec npx "\$@"
`;

  await fs.writeFile(path.join(fakeBinDir, 'npm'),  npmScript,  { mode: 0o755 });
  await fs.writeFile(path.join(fakeBinDir, 'npx'),  npxScript,  { mode: 0o755 });
}

// ── Replit port URL helper ───────────────────────────────────────────────────

function getPortUrl(port: number): string | null {
  const devDomain = process.env['REPLIT_DEV_DOMAIN'];
  if (!devDomain) return null;
  if (devDomain.includes('-00-')) return `https://${devDomain.replace('-00-', `-${port}-`)}`;
  return `https://${port}-${devDomain}`;
}

const ANSI_RE     = /\x1b\[[0-9;]*[A-Za-z]/g;
const LOCAL_URL_RE = /https?:\/\/localhost:(\d{2,5})/g;

// ── WebSocket server ─────────────────────────────────────────────────────────

export function attachTerminalServer(server: http.Server): void {
  const wss = new WebSocketServer({ server, path: '/api/terminal' });
  logger.info({ path: '/api/terminal', realNpm: REAL_NPM, realPnpm: REAL_PNPM }, 'terminal WebSocket server attached');
  wss.on('connection', (ws) => handleConnection(ws));
}

function handleConnection(ws: WebSocket): void {
  const sessionId  = randomUUID().slice(0, 8);
  const sessionDir = path.join(os.tmpdir(), `epicode-${sessionId}`);
  let ptyProcess: pty.IPty | null = null;
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
          logger.info({ sessionId, port, url }, 'detected dev server port');
        }
      }
    }
  };

  ws.on('message', async (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'sync') {
      try {
        await fs.mkdir(sessionDir, { recursive: true });

        // Write editor files
        const files: Record<string, string> = msg.files ?? {};
        await Promise.all(
          Object.entries(files).map(async ([filePath, content]) => {
            const fullPath = path.join(sessionDir, filePath);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, String(content), 'utf8');
          })
        );

        // Write npm → pnpm wrapper binaries
        const fakeBinDir = path.join(sessionDir, '.bin');
        await fs.mkdir(fakeBinDir, { recursive: true });
        await writeNpmWrapper(fakeBinDir);

        const sessionPath = `${fakeBinDir}:${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}`;

        ptyProcess = pty.spawn('bash', ['--login'], {
          name: 'xterm-256color',
          cols: Number(msg.cols) || 80,
          rows: Number(msg.rows) || 24,
          cwd: sessionDir,
          env: {
            ...process.env,
            PATH: sessionPath,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            // Per-session npm cache so concurrent sessions don't corrupt each other
            npm_config_cache: `${sessionDir}/.npm-cache`,
          } as Record<string, string>,
        });

        ptyProcess.onData((data) => {
          send({ type: 'output', data });
          scanForPorts(data);
        });

        ptyProcess.onExit(({ exitCode }) => {
          send({ type: 'exit', exitCode });
          ptyProcess = null;
        });

        send({ type: 'ready', cwd: sessionDir });
        logger.info({ sessionId, cwd: sessionDir, fileCount: Object.keys(files).length }, 'terminal session started');
      } catch (err: any) {
        const message = err?.message ?? String(err);
        send({ type: 'error', message });
        logger.error({ sessionId, err }, 'terminal spawn failed');
      }

    } else if (msg.type === 'input') {
      ptyProcess?.write(msg.data);

    } else if (msg.type === 'resize') {
      const cols = Number(msg.cols);
      const rows = Number(msg.rows);
      if (cols > 0 && rows > 0) ptyProcess?.resize(cols, rows);

    } else if (msg.type === 'writeFile') {
      try {
        const fullPath = path.join(sessionDir, String(msg.path));
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, String(msg.content ?? ''), 'utf8');
      } catch { /* ignore */ }
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
