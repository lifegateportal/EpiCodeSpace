import React, {
  useEffect, useRef, useState, useCallback,
  useImperativeHandle, forwardRef,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  RefreshCw, Square, Power, Loader2,
  Copy, ClipboardPaste, UploadCloud,
} from 'lucide-react';

/**
 * ServerTerminal — xterm.js terminal backed by a real server-side bash shell
 * via WebSocket + node-pty.  Drop-in replacement for WebContainerTerminal:
 * accepts the same props (files, sink, onServerUrl, onOutput) and exposes
 * the same ref API (sendCommand, isReady).
 *
 * No WASM, no COOP/COEP headers, works on every browser including Safari.
 */
const ServerTerminal = forwardRef(function ServerTerminal(
  { files, sink, onOutput },
  ref,
) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef  = useRef(null);
  const wsRef   = useRef(null);

  const [connState, setConnState]     = useState('idle'); // idle | connecting | ready | dead
  const [connError, setConnError]     = useState(null);
  const [processRunning, setProcessRunning] = useState(false);
  const [hasSelection, setHasSelection]     = useState(false);

  // ── xterm.js mount ────────────────────────────────────────────────────
  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      convertEol: true,
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
      fontSize: 13,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorBlink: true,
      cursorInactiveStyle: 'none',
      allowTransparency: false,
      scrollback: 5000,
      theme: {
        background: '#0b1020', foreground: '#e2e8f0', cursor: '#7dd3fc',
        selectionBackground: '#3730a3',
        black: '#0b1020',   red: '#f87171',   green: '#4ade80',  yellow: '#facc15',
        blue:  '#60a5fa',   magenta: '#c084fc', cyan: '#22d3ee', white: '#e2e8f0',
        brightBlack: '#334155', brightRed: '#fca5a5', brightGreen: '#86efac',
        brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9', brightWhite: '#f8fafc',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    try { fit.fit(); } catch { /* first paint may not have size yet */ }

    termRef.current = term;
    fitRef.current  = fit;

    // Keystrokes → WebSocket
    term.onData((data) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    term.onSelectionChange(() => setHasSelection(term.hasSelection()));

    // Resize observer → fit + inform server
    const resizeObs = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* ignore */ }
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    });
    const parent = hostRef.current.parentElement;
    if (parent) resizeObs.observe(parent);

    return () => {
      resizeObs.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
    };
  }, []);

  // Unmount: close WebSocket
  useEffect(() => () => { wsRef.current?.close(); }, []);

  // ── Helpers ───────────────────────────────────────────────────────────
  /** Flatten the fileSystem map to path → string content for the server. */
  const buildFilesMap = useCallback(() => {
    const src = sink?.getLatest?.() ?? files ?? {};
    const out = {};
    for (const [p, v] of Object.entries(src)) {
      if (v?.content !== undefined && !v?.isLarge) out[p] = v.content;
    }
    return out;
  }, [files, sink]);

  // ── Connect ───────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    // Close any existing connection first
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    setConnState('connecting');
    setConnError(null);

    const term = termRef.current;
    term?.writeln('\x1b[36m▶ connecting to server terminal…\x1b[0m');

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/api/terminal`);
    wsRef.current = ws;

    ws.onopen = () => {
      term?.writeln('\x1b[36m▶ syncing files to server…\x1b[0m');
      const flat = buildFilesMap();
      ws.send(JSON.stringify({
        type: 'sync',
        files: flat,
        cols: termRef.current?.cols ?? 80,
        rows: termRef.current?.rows ?? 24,
      }));
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'output') {
        termRef.current?.write(msg.data);
        onOutput?.(msg.data);
      } else if (msg.type === 'ready') {
        setConnState('ready');
        setProcessRunning(true);
        term?.writeln('\x1b[32m✔ server terminal ready\x1b[0m');
      } else if (msg.type === 'exit') {
        setProcessRunning(false);
        term?.writeln(`\x1b[33m\r\n# shell exited (code ${msg.exitCode ?? '?'})\x1b[0m`);
      } else if (msg.type === 'error') {
        setConnState('dead');
        setConnError(msg.message);
        term?.writeln(`\x1b[31m✖ ${msg.message}\x1b[0m`);
      }
    };

    ws.onerror = () => {
      setConnState('dead');
      const msg = 'WebSocket connection failed — is the API server running?';
      setConnError(msg);
      term?.writeln(`\x1b[31m✖ ${msg}\x1b[0m`);
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
        setConnState('idle');
        setProcessRunning(false);
      }
    };
  }, [buildFilesMap, onOutput]);

  // ── Disconnect ────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnState('idle');
    setProcessRunning(false);
    termRef.current?.writeln('\x1b[33m# disconnected\x1b[0m');
  }, []);

  // ── Sync Files ────────────────────────────────────────────────────────
  const syncFiles = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    const flat = buildFilesMap();
    const term = termRef.current;
    term?.writeln(`\x1b[36m▶ syncing ${Object.keys(flat).length} files…\x1b[0m`);
    for (const [p, content] of Object.entries(flat)) {
      ws.send(JSON.stringify({ type: 'writeFile', path: p, content }));
    }
    term?.writeln('\x1b[32m✔ synced\x1b[0m');
  }, [buildFilesMap]);

  // ── Kill / Copy / Paste ───────────────────────────────────────────────
  const kill = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: 'input', data: '\x03' }));
  }, []);

  const handleCopy = useCallback(async () => {
    const sel = termRef.current?.getSelection();
    if (sel) await navigator.clipboard.writeText(sel).catch(() => {});
  }, []);

  const handlePaste = useCallback(async () => {
    const text = await navigator.clipboard.readText().catch(() => '');
    if (!text) return;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: text }));
    }
  }, []);

  // ── Ref API (matches WebContainerTerminal) ────────────────────────────
  useImperativeHandle(ref, () => ({
    sendCommand(cmd) {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
        return true;
      }
      termRef.current?.writeln('\x1b[33m⚠ Terminal not connected — tap Connect first.\x1b[0m');
      termRef.current?.writeln(`\x1b[90m# Pending: ${cmd}\x1b[0m`);
      return false;
    },
    isReady() {
      return wsRef.current?.readyState === WebSocket.OPEN && connState === 'ready';
    },
  }), [connState]);

  // ── Render ────────────────────────────────────────────────────────────
  const stateLabel = { idle: 'Disconnected', connecting: 'Connecting…', ready: 'Connected', dead: 'Error' }[connState] ?? connState;

  return (
    <div className="flex flex-col h-full bg-[#0b1020] text-slate-200">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 bg-slate-900/60 flex-wrap">
        <span className="text-xs font-medium text-slate-300">Terminal · {stateLabel}</span>
        <span className="flex-1" />

        <button onClick={handleCopy} disabled={!hasSelection}
          title="Copy selection"
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed">
          <Copy className="w-3 h-3" /> Copy
        </button>
        <button onClick={handlePaste} disabled={!processRunning}
          title="Paste clipboard"
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed">
          <ClipboardPaste className="w-3 h-3" /> Paste
        </button>

        {connState !== 'ready' ? (
          <button onClick={connect} disabled={connState === 'connecting'}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:cursor-not-allowed"
            title="Start a server-side bash shell">
            {connState === 'connecting'
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Power className="w-3 h-3" />}
            Connect
          </button>
        ) : (
          <>
            <button onClick={syncFiles}
              title="Push current editor files to the server"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500">
              <UploadCloud className="w-3 h-3" /> Sync Files
            </button>
            <button onClick={kill} disabled={!processRunning}
              title="Send Ctrl-C to foreground process"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40">
              <Square className="w-3 h-3" /> Kill
            </button>
            <button onClick={connect}
              title="Start a fresh session (reconnects)"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-amber-600 hover:bg-amber-500">
              <RefreshCw className="w-3 h-3" /> Reboot
            </button>
            <button onClick={disconnect}
              title="Disconnect from terminal"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-rose-600 hover:bg-rose-500">
              <Power className="w-3 h-3" /> Stop
            </button>
          </>
        )}
      </div>

      {/* Error banner */}
      {connError && (
        <div className="px-3 py-2 text-xs text-rose-300 bg-rose-950/40 border-b border-rose-900">
          {connError}
        </div>
      )}

      {/* xterm viewport */}
      <div
        ref={hostRef}
        className="flex-1 min-h-0 overflow-hidden wc-term touch-manipulation p-1"
      />
    </div>
  );
});

export default ServerTerminal;
