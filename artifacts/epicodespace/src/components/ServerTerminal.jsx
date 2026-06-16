import React, {
  useEffect, useRef, useState, useCallback,
  useImperativeHandle, forwardRef,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  RotateCcw, Square, Loader2,
  UploadCloud, ExternalLink, Wifi, WifiOff,
} from 'lucide-react';

/**
 * ServerTerminal
 *
 * xterm.js terminal backed by a real server-side bash shell via WebSocket +
 * node-pty.  Mirrors the GitHub Codespaces / VS Code Remote model:
 *
 *   • Auto-connects on mount — no manual "Connect" button.
 *   • Auto-reconnects (up to 5 attempts, exponential backoff) on unexpected
 *     disconnect.
 *   • npm / pnpm / yarn all talk to registry.npmjs.org — the server sets the
 *     correct registry via per-session HOME/.npmrc.
 *   • Dev-server port detection: the server tail-watches pty output for
 *     "localhost:PORT", resolves the Replit proxy URL, and sends a `serverUrl`
 *     message; we show a clickable banner + call onServerUrl().
 *
 * Props:  files, sink, onServerUrl, onOutput
 * Ref:    sendCommand(cmd) → bool, isReady() → bool
 */
const ServerTerminal = forwardRef(function ServerTerminal(
  { files, sink, onServerUrl, onOutput },
  ref,
) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef  = useRef(null);
  const wsRef   = useRef(null);

  // Keep the latest connect fn in a ref so effects don't go stale
  const connectRef          = useRef(null);
  const reconnectTimerRef   = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const manualStopRef       = useRef(false);

  const [connState, setConnState]       = useState('idle'); // idle|connecting|reconnecting|ready|dead
  const [connError, setConnError]       = useState(null);
  const [processRunning, setProcessRunning] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [detectedUrl, setDetectedUrl]   = useState(null); // { port, url }

  const RECONNECT_DELAYS = [2000, 5000, 10000, 20000, 30000];

  // ── xterm.js mount ──────────────────────────────────────────────────────
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
      scrollback: 10000,
      theme: {
        background:  '#0b1020',
        foreground:  '#e2e8f0',
        cursor:      '#7dd3fc',
        selectionBackground: '#3730a3',
        black:          '#0b1020', brightBlack:   '#334155',
        red:            '#f87171', brightRed:     '#fca5a5',
        green:          '#4ade80', brightGreen:   '#86efac',
        yellow:         '#facc15', brightYellow:  '#fde047',
        blue:           '#60a5fa', brightBlue:    '#93c5fd',
        magenta:        '#c084fc', brightMagenta: '#d8b4fe',
        cyan:           '#22d3ee', brightCyan:    '#67e8f9',
        white:          '#e2e8f0', brightWhite:   '#f8fafc',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    try { fit.fit(); } catch { /* first paint may not have size yet */ }

    termRef.current = term;
    fitRef.current  = fit;

    term.onData((data) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    term.onSelectionChange(() => setHasSelection(term.hasSelection()));

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* ignore */ }
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    });
    const parent = hostRef.current?.parentElement;
    if (parent) ro.observe(parent);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
    };
  }, []);

  // Unmount: close WebSocket cleanly
  useEffect(() => () => {
    manualStopRef.current = true;
    clearTimeout(reconnectTimerRef.current);
    wsRef.current?.close();
  }, []);

  // ── Helpers ─────────────────────────────────────────────────────────────
  const buildFilesMap = useCallback(() => {
    const src = sink?.getLatest?.() ?? files ?? {};
    const out = {};
    for (const [p, v] of Object.entries(src)) {
      if (v?.content !== undefined && !v?.isLarge) out[p] = v.content;
    }
    return out;
  }, [files, sink]);

  // ── Connect ─────────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    // Cancel any pending reconnect
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;

    // Close existing socket
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    manualStopRef.current = false;
    setConnState('connecting');
    setConnError(null);
    setDetectedUrl(null);

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/api/terminal`);
    wsRef.current = ws;

    ws.onopen = () => {
      const flat = buildFilesMap();
      const storedSessionId = sessionStorage.getItem('epicodespace.terminalSessionId');
      ws.send(JSON.stringify({
        type: 'sync',
        files: flat,
        cols: termRef.current?.cols ?? 80,
        rows: termRef.current?.rows ?? 24,
        ...(storedSessionId ? { sessionId: storedSessionId } : {}),
      }));
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'output':
          termRef.current?.write(msg.data);
          onOutput?.(msg.data);
          break;

        case 'ready':
          reconnectAttemptsRef.current = 0;
          setConnState('ready');
          setProcessRunning(true);
          // Persist session ID so reconnects reuse the same shell
          if (msg.sessionId) sessionStorage.setItem('epicodespace.terminalSessionId', msg.sessionId);
          // Clear "connecting..." line
          termRef.current?.write('\r\x1b[K');
          if (msg.reconnected) {
            termRef.current?.writeln('\x1b[32m# reconnected — session restored\x1b[0m');
          }
          break;

        case 'exit':
          setProcessRunning(false);
          termRef.current?.writeln('\x1b[2m\r\n# process exited\x1b[0m');
          break;

        case 'error':
          setConnState('dead');
          setConnError(msg.message);
          termRef.current?.writeln(`\x1b[31m✖ ${msg.message}\x1b[0m`);
          break;

        case 'serverUrl': {
          const { port, proxyPath } = msg;
          // In production the server sends proxyPath (routed through our API).
          // In dev it sends a direct dev-domain URL.
          const url = proxyPath
            ? `${window.location.origin}${proxyPath}`
            : msg.url;
          if (!url) break;
          setDetectedUrl({ port, url });
          onServerUrl?.(url);
          termRef.current?.writeln(
            `\x1b[32m\r\n  Port ${port} → \x1b[36m\x1b[4m${url}\x1b[0m`
          );
          break;
        }

        default:
          break;
      }
    };

    ws.onerror = () => {
      // onclose fires immediately after, handle state there
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return; // stale socket, ignore
      wsRef.current = null;
      setProcessRunning(false);

      if (manualStopRef.current) {
        setConnState('idle');
        return;
      }

      const attempt = reconnectAttemptsRef.current;
      if (attempt < RECONNECT_DELAYS.length) {
        const delay = RECONNECT_DELAYS[attempt];
        reconnectAttemptsRef.current = attempt + 1;
        setConnState('reconnecting');
        termRef.current?.writeln(
          `\x1b[33m\r\n# disconnected — reconnecting in ${delay / 1000}s…\x1b[0m`
        );
        reconnectTimerRef.current = setTimeout(() => connectRef.current?.(), delay);
      } else {
        setConnState('dead');
        setConnError('Connection lost. Click Restart to reconnect.');
        termRef.current?.writeln('\x1b[31m\r\n# connection failed — click Restart\x1b[0m');
      }
    };

    // Show a subtle "connecting" indicator (single line, will be overwritten on ready)
    termRef.current?.write('\x1b[2m# connecting…\x1b[0m');
  }, [buildFilesMap, onOutput, onServerUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep connectRef in sync
  useEffect(() => { connectRef.current = connect; }, [connect]);

  // Auto-connect on mount
  useEffect(() => { connectRef.current?.(); }, []);

  // ── Disconnect ──────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    manualStopRef.current = true;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    reconnectAttemptsRef.current = 0;
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnState('idle');
    setProcessRunning(false);
    setDetectedUrl(null);
    termRef.current?.writeln('\x1b[2m\r\n# terminal stopped\x1b[0m');
  }, []);

  // ── Sync Files ──────────────────────────────────────────────────────────
  const syncFiles = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    const flat = buildFilesMap();
    for (const [p, content] of Object.entries(flat)) {
      ws.send(JSON.stringify({ type: 'writeFile', path: p, content }));
    }
    termRef.current?.writeln(`\x1b[2m\r\n# synced ${Object.keys(flat).length} files\x1b[0m`);
  }, [buildFilesMap]);

  // ── Kill / Restart ───────────────────────────────────────────────────────
  const killProcess = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: 'input', data: '\x03' }));
  }, []);

  const restart = useCallback(() => {
    // Clear stored session so Restart always gives a fresh shell
    sessionStorage.removeItem('epicodespace.terminalSessionId');
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  // ── Copy / Paste ─────────────────────────────────────────────────────────
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

  // ── Ref API ──────────────────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    sendCommand(cmd) {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
        return true;
      }
      termRef.current?.writeln('\x1b[33m⚠ Terminal not connected.\x1b[0m');
      return false;
    },
    isReady() {
      return wsRef.current?.readyState === WebSocket.OPEN && connState === 'ready';
    },
  }), [connState]);

  // ── Render ────────────────────────────────────────────────────────────────
  const isConnected    = connState === 'ready';
  const isConnecting   = connState === 'connecting' || connState === 'reconnecting';
  const isDisconnected = connState === 'idle' || connState === 'dead';

  // Status dot
  const dotColor =
    isConnected  ? 'bg-emerald-400' :
    isConnecting ? 'bg-amber-400 animate-pulse' :
                   'bg-slate-500';

  return (
    <div className="flex flex-col h-full bg-[#0b1020] text-slate-200">

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 bg-[#0d1424] flex-wrap select-none">
        {/* Status */}
        <span className="flex items-center gap-1.5 text-xs text-slate-400">
          <span className={`w-2 h-2 rounded-full ${dotColor}`} />
          {connState === 'ready'        && 'Terminal'}
          {connState === 'connecting'   && 'Connecting…'}
          {connState === 'reconnecting' && 'Reconnecting…'}
          {connState === 'idle'         && 'Stopped'}
          {connState === 'dead'         && 'Disconnected'}
        </span>

        <span className="flex-1" />

        {/* Copy (only when there's a selection) */}
        {hasSelection && (
          <button onClick={handleCopy} title="Copy selection (⌘C)"
            className="px-2 py-0.5 text-xs rounded bg-slate-700/80 hover:bg-slate-700 text-slate-300">
            Copy
          </button>
        )}

        {/* Paste */}
        {isConnected && (
          <button onClick={handlePaste} title="Paste clipboard"
            className="px-2 py-0.5 text-xs rounded bg-slate-700/80 hover:bg-slate-700 text-slate-300">
            Paste
          </button>
        )}

        {/* Sync Files */}
        {isConnected && (
          <button onClick={syncFiles} title="Push current editor files to server session"
            className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-indigo-700/70 hover:bg-indigo-600 text-slate-200">
            <UploadCloud className="w-3 h-3" />
            Sync
          </button>
        )}

        {/* Kill (Ctrl-C) */}
        {isConnected && processRunning && (
          <button onClick={killProcess} title="Send Ctrl-C to foreground process"
            className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-slate-700/80 hover:bg-slate-700 text-slate-300">
            <Square className="w-3 h-3" />
            Kill
          </button>
        )}

        {/* Restart / Reconnect */}
        {(isConnected || isDisconnected) && (
          <button onClick={isDisconnected ? restart : restart}
            title={isDisconnected ? 'Start terminal' : 'Restart terminal session'}
            className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-slate-700/80 hover:bg-slate-700 text-slate-300">
            {isConnecting
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <RotateCcw className="w-3 h-3" />}
            {isDisconnected ? 'Start' : 'Restart'}
          </button>
        )}

        {/* Connecting spinner (no button — auto-connecting) */}
        {isConnecting && !isConnected && (
          <span className="flex items-center gap-1 px-2 py-0.5 text-xs text-slate-500">
            <Loader2 className="w-3 h-3 animate-spin" />
            {connState === 'reconnecting' ? 'Reconnecting' : 'Starting'}
          </span>
        )}

        {/* Stop */}
        {isConnected && (
          <button onClick={disconnect} title="Stop terminal session"
            className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-slate-700/60 hover:bg-rose-900/60 text-slate-400 hover:text-rose-300">
            <WifiOff className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      {connError && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-rose-300 bg-rose-950/40 border-b border-rose-900/60">
          <span className="flex-1">{connError}</span>
          <button onClick={restart}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-rose-800/50 hover:bg-rose-700/60 text-rose-200">
            <RotateCcw className="w-3 h-3" /> Restart
          </button>
        </div>
      )}

      {/* ── Dev-server port banner ────────────────────────────────────────── */}
      {detectedUrl && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-emerald-950/50 border-b border-emerald-800/50">
          <Wifi className="w-3 h-3 text-emerald-400 flex-shrink-0" />
          <span className="text-emerald-300 font-medium">Port {detectedUrl.port}</span>
          <a href={detectedUrl.url} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 text-cyan-400 underline hover:text-cyan-300 truncate min-w-0">
            <span className="truncate">{detectedUrl.url}</span>
            <ExternalLink className="w-3 h-3 flex-shrink-0" />
          </a>
          <button onClick={() => setDetectedUrl(null)}
            className="ml-auto text-slate-500 hover:text-slate-300 flex-shrink-0">✕</button>
        </div>
      )}

      {/* ── xterm.js viewport ────────────────────────────────────────────── */}
      <div
        ref={hostRef}
        className="flex-1 min-h-0 overflow-hidden p-1"
        // Forward paste from browser context-menu
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (!text) return;
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data: text }));
          }
          e.preventDefault();
        }}
      />
    </div>
  );
});

export default ServerTerminal;
