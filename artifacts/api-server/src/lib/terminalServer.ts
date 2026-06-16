import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as pty from 'node-pty';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { logger } from './logger';

export function attachTerminalServer(server: http.Server): void {
  const wss = new WebSocketServer({ server, path: '/api/terminal' });
  logger.info({ path: '/api/terminal' }, 'terminal WebSocket server attached');
  wss.on('connection', (ws) => handleConnection(ws));
}

function handleConnection(ws: WebSocket): void {
  const sessionId = randomUUID().slice(0, 8);
  const sessionDir = path.join(os.tmpdir(), `epicode-${sessionId}`);
  let ptyProcess: pty.IPty | null = null;

  const send = (msg: object) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  const cleanup = () => {
    if (ptyProcess) {
      try { ptyProcess.kill(); } catch { /* ignore */ }
      ptyProcess = null;
    }
    fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    logger.info({ sessionId }, 'terminal session cleaned up');
  };

  ws.on('message', async (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'sync') {
      // ── Write editor files to a fresh session dir, then spawn bash ──
      try {
        await fs.mkdir(sessionDir, { recursive: true });
        const files: Record<string, string> = msg.files ?? {};
        await Promise.all(
          Object.entries(files).map(async ([filePath, content]) => {
            const fullPath = path.join(sessionDir, filePath);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, String(content), 'utf8');
          })
        );

        ptyProcess = pty.spawn('bash', ['--login'], {
          name: 'xterm-256color',
          cols: Number(msg.cols) || 80,
          rows: Number(msg.rows) || 24,
          cwd: sessionDir,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
          } as Record<string, string>,
        });

        ptyProcess.onData((data) => send({ type: 'output', data }));
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
      // Hot-sync a single file from the editor into the session dir
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
