// TypeScript LSP bridge.
//
// Spawns `typescript-language-server --stdio` inside the running
// WebContainer, pipes its stdio through vscode-jsonrpc, exposes a typed
// connection plus a state machine. Every failure path is caught and
// surfaces as state='error' so Monaco keeps working even if the server
// OOMs or refuses to install.
//
// iPad memory resilience:
//   - `npx` is attempted once; npm install is done in-place on failure
//     so the server can survive a cold tmpfs.
//   - We listen for proc.exit and downgrade to 'disconnected' — we do
//     NOT auto-restart (that would thrash memory on an already-tight
//     device). User gets a "Reconnect LSP" button in the status bar.
//   - All errors inside the JSON-RPC connection are trapped; the bridge
//     never throws into React render.

import {
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc';
import * as lsp from 'vscode-languageserver-protocol';
import { WcStreamReader, WcStreamWriter } from './framing.ts';
import { bridge as wcBridge } from '../runtime/WebContainerBridge.ts';
import { logger } from '../logger.js';

export type LspState =
  | 'idle'          // not started
  | 'installing'    // npm install typescript-language-server
  | 'starting'      // spawned, awaiting initialize response
  | 'ready'         // initialized
  | 'error'         // failed to start / crashed / unrecoverable
  | 'disconnected'; // server exited cleanly or was torn down

type Listener<T> = (v: T) => void;

const INSTALL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

class TsLspBridge {
  private _state: LspState = 'idle';
  private _lastError: string | null = null;
  private conn: MessageConnection | null = null;
  private proc: Awaited<ReturnType<Awaited<ReturnType<typeof wcBridge.boot>>['spawn']>> | null = null;
  private stateListeners = new Set<Listener<LspState>>();
  private diagnosticListeners = new Set<Listener<lsp.PublishDiagnosticsParams>>();
  private logListeners = new Set<Listener<string>>();
  private startPromise: Promise<void> | null = null;
  private capabilities: lsp.ServerCapabilities | null = null;

  get state(): LspState { return this._state; }
  get lastError(): string | null { return this._lastError; }
  get connection(): MessageConnection | null { return this.conn; }
  get serverCapabilities(): lsp.ServerCapabilities | null { return this.capabilities; }

  onState(cb: Listener<LspState>): () => void {
    this.stateListeners.add(cb);
    cb(this._state);
    return () => { this.stateListeners.delete(cb); };
  }

  onDiagnostics(cb: Listener<lsp.PublishDiagnosticsParams>): () => void {
    this.diagnosticListeners.add(cb);
    return () => { this.diagnosticListeners.delete(cb); };
  }

  /** Subscribe to install/startup log lines so the terminal can mirror them. */
  onLog(cb: Listener<string>): () => void {
    this.logListeners.add(cb);
    return () => { this.logListeners.delete(cb); };
  }

  private emitLog(line: string) {
    for (const l of this.logListeners) {
      try { l(line); } catch { /* noop */ }
    }
  }

  private setState(s: LspState, err?: string) {
    this._state = s;
    if (err !== undefined) this._lastError = err;
    if (s === 'ready') this._lastError = null;
    for (const l of this.stateListeners) {
      try { l(s); } catch (e) { logger.error('lsp', 'state listener threw', e); }
    }
  }

  /** Idempotent start. Safe to call repeatedly — will coalesce. */
  async start(): Promise<void> {
    if (this._state === 'ready' || this._state === 'starting' || this._state === 'installing') {
      return this.startPromise ?? Promise.resolve();
    }
    this.startPromise = this._start().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async _start(): Promise<void> {
    try {
      if (!wcBridge.ready) {
        this.setState('error', 'WebContainer is not ready');
        return;
      }
      const container = wcBridge.getContainer();

      // 1. Skip install if server binary already exists from a prior run.
      let alreadyInstalled = false;
      try {
        const stat = await container.fs.readFile(
          'node_modules/.bin/typescript-language-server',
          'utf-8',
        );
        if (stat) alreadyInstalled = true;
      } catch { /* not installed yet — fall through */ }

      if (!alreadyInstalled) {
        this.setState('installing');
        this.emitLog('▶ Installing typescript + typescript-language-server (first-time, may take ~60s)…');
        try {
          const install = await container.spawn('npm', [
            'install',
            '--no-audit',
            '--no-fund',
            '--prefer-offline',
            '--progress=false',
            '--loglevel=error',
            '--fetch-retries=10',
            '--fetch-retry-mintimeout=20000',
            '--fetch-retry-maxtimeout=120000',
            '--fetch-timeout=300000',
            'typescript@latest',
            'typescript-language-server@latest',
          ]);

          // CRITICAL: we MUST consume proc.output or WebContainer's internal
          // buffers stall and the process appears to hang forever. Stream
          // every line to log subscribers so the terminal can mirror it.
          let lineBuf = '';
          const pump = install.output.pipeTo(new WritableStream({
            write: (chunk) => {
              lineBuf += chunk;
              let nl;
              while ((nl = lineBuf.indexOf('\n')) >= 0) {
                const line = lineBuf.slice(0, nl).replace(/\r$/, '');
                lineBuf = lineBuf.slice(nl + 1);
                if (line.trim()) this.emitLog(line);
              }
            },
          })).catch(() => { /* swallow */ });

          // Timeout guard: kill the install if it exceeds the budget.
          let timedOut = false;
          const timeout = new Promise<number>((resolve) => {
            setTimeout(() => {
              timedOut = true;
              try { install.kill(); } catch { /* noop */ }
              resolve(-1);
            }, INSTALL_TIMEOUT_MS);
          });

          const code = await Promise.race([install.exit, timeout]);
          try { await pump; } catch { /* noop */ }

          if (timedOut) {
            this.setState('error', `npm install timed out after ${INSTALL_TIMEOUT_MS / 1000}s`);
            return;
          }
          if (code !== 0) {
            this.setState('error', `npm install exited ${code}`);
            return;
          }
          this.emitLog('▶ install complete.');
        } catch (err: any) {
          this.setState('error', `install failed: ${err?.message || err}`);
          return;
        }
      } else {
        this.emitLog('▶ typescript-language-server already installed, skipping npm install.');
      }

      // 2. Spawn the server.
      this.setState('starting');
      let proc;
      try {
        proc = await container.spawn('npx', [
          '--no-install',
          'typescript-language-server',
          '--stdio',
        ]);
      } catch (err: any) {
        this.setState('error', `spawn failed: ${err?.message || err}`);
        return;
      }
      this.proc = proc;

      // Wire stderr to the logger so we can see server crashes.
      // proc.output streams BOTH stdout+stderr for jsh; typescript-language-server
      // writes its LSP traffic to stdout only. stderr surfaces via proc.stderr
      // when available; if not, it's interleaved — the framing parser drops
      // anything not matching Content-Length and continues.

      const reader = new WcStreamReader(proc.output as ReadableStream<string>);
      const writer = new WcStreamWriter(proc.input as WritableStream<string>);
      const conn = createMessageConnection(reader, writer, {
        error: (msg) => logger.warn('lsp', 'rpc', msg),
        warn:  (msg) => logger.warn('lsp', msg),
        info:  () => { /* quiet */ },
        log:   () => { /* quiet */ },
      });
      this.conn = conn;

      // Diagnostics fan-out.
      conn.onNotification(lsp.PublishDiagnosticsNotification.type, (params) => {
        for (const l of this.diagnosticListeners) {
          try { l(params); } catch (e) { logger.error('lsp', 'diag listener threw', e); }
        }
      });
      conn.onNotification(lsp.LogMessageNotification.type, () => { /* quiet */ });
      conn.onNotification(lsp.ShowMessageNotification.type, () => { /* quiet */ });

      conn.onError(([err]) => {
        logger.warn('lsp', 'connection error', err);
        // Don't flip to error here — single rpc hiccups are recoverable.
      });
      conn.onClose(() => {
        if (this._state !== 'error') this.setState('disconnected');
        this.conn = null;
      });
      conn.onUnhandledNotification((n) => logger.debug?.('lsp', 'unhandled', n));

      conn.listen();

      // 3. initialize.
      const rootUri = 'file:///home/epicodespace/';
      try {
        const result = await conn.sendRequest(lsp.InitializeRequest.type, {
          processId: null,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: 'epicodespace' }],
          capabilities: {
            textDocument: {
              synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
              completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown','plaintext'] } },
              hover: { contentFormat: ['markdown','plaintext'] },
              signatureHelp: { signatureInformation: { documentationFormat: ['markdown','plaintext'] } },
              definition: { linkSupport: false },
              publishDiagnostics: { relatedInformation: false },
              rename: { prepareSupport: false },
            },
            workspace: {
              workspaceFolders: true,
              configuration: false,
            },
          },
          initializationOptions: {
            preferences: {
              includeCompletionsForModuleExports: true,
              includeCompletionsWithInsertText: true,
              allowIncompleteCompletions: true,
            },
          },
        });
        this.capabilities = (result as lsp.InitializeResult).capabilities;
        await conn.sendNotification(lsp.InitializedNotification.type, {});
        this.setState('ready');
        logger.info('lsp', 'initialized', { caps: Object.keys(this.capabilities || {}) });
      } catch (err: any) {
        this.setState('error', `initialize failed: ${err?.message || err}`);
        try { conn.dispose(); } catch { /* noop */ }
        this.conn = null;
        return;
      }

      // 4. Track process exit for OOM/kill resilience.
      (async () => {
        try {
          const code = await this.proc?.exit;
          logger.warn('lsp', `tsserver process exited (${code})`);
          if (this._state === 'ready') this.setState('disconnected', `tsserver exited (${code})`);
          try { this.conn?.dispose(); } catch { /* noop */ }
          this.conn = null;
          this.proc = null;
        } catch (err) {
          logger.warn('lsp', 'exit watcher error', err);
        }
      })();
    } catch (outer: any) {
      // Belt & braces: anything that slipped through lands here.
      this.setState('error', `unexpected: ${outer?.message || outer}`);
    }
  }

  /** Manual stop. Also called on WebContainer teardown. */
  async stop(): Promise<void> {
    try {
      if (this.conn) {
        try { await this.conn.sendRequest(lsp.ShutdownRequest.type); } catch { /* noop */ }
        try { await this.conn.sendNotification(lsp.ExitNotification.type); } catch { /* noop */ }
        try { this.conn.dispose(); } catch { /* noop */ }
      }
    } finally {
      this.conn = null;
      this.proc = null;
      this.capabilities = null;
      this.setState('idle');
    }
  }

  /** Force a clean restart. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
}

export const lspBridge = new TsLspBridge();

// Auto-lifecycle: when the WebContainer dies, disconnect LSP. We do NOT
// auto-start on boot — user opens a TS file or clicks the badge.
if (typeof window !== 'undefined') {
  wcBridge.onState((s) => {
    if (s === 'idle' || s === 'dead') {
      if (lspBridge.state !== 'idle') void lspBridge.stop();
    }
  });
}
