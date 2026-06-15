import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { RefreshCw, Square, Power, Loader2, Copy, ClipboardPaste } from 'lucide-react';
import { bridge } from '../lib/runtime/WebContainerBridge.ts';
import { autoPullRootNewFiles } from '../lib/runtime/syncInbound.ts';
import { lspBridge } from '../lib/lsp/TsLspBridge.ts';
import { logger } from '../lib/logger.js';

/**
 * WebContainerTerminal
 *
 * xterm.js-backed terminal wired to a live `jsh` process inside the
 * WebContainer. The caller provides the file snapshot + a sink so the
 * narrow auto-pull can update editor state when commands create new
 * root-level files.
 */
export default function WebContainerTerminal({ files, sink, serverUrl, onServerUrl }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const processRef = useRef(null);
  const writerRef = useRef(null);
  const [bootState, setBootState] = useState(bridge.state);
  const [bootError, setBootError] = useState(null);
  const [processRunning, setProcessRunning] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);

  // ── xterm mount ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      convertEol: true,
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
      fontSize: 13,
      // GitHub-style thin bar caret. The default 'block' style fills the
      // entire empty remainder of the current cell on iPadOS and renders
      // as the giant selectable "box" users were seeing. 'bar' stays 1px.
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorBlink: true,
      cursorInactiveStyle: 'none',
      // Canvas renderer — matches GitHub's terminal and avoids the DOM
      // renderer's selection artifacts on iPadOS.
      allowTransparency: false,
      disableStdin: false,
      scrollback: 5000,
      theme: {
        background: '#0b1020',
        foreground: '#e5e7eb',
        cursor: '#22d3ee',
        cursorAccent: '#0b1020',
        selectionBackground: '#1e3a8a66',
        black: '#0b1020',
        brightBlack: '#334155',
        red: '#f87171',
        green: '#34d399',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e5e7eb',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    // Two fits: one immediate, one after paint, because the RUNTIME tab
    // is conditionally rendered and the pane may not have final size yet.
    try { fit.fit(); } catch {}
    requestAnimationFrame(() => { try { fit.fit(); } catch {} });
    termRef.current = term;
    fitRef.current = fit;

    // Track selection state so the Copy button enables/disables correctly.
    const selSub = term.onSelectionChange(() => {
      setHasSelection(!!term.getSelection?.());
    });

    term.writeln('\x1b[90m# EpiCodeSpace WebContainer terminal\x1b[0m');
    term.writeln('\x1b[90m# Press "Boot container" to start jsh.\x1b[0m');

    const onResize = () => { try { fit.fit(); } catch {} };
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(hostRef.current);

    // When the panel becomes visible again after being hidden (tab
    // switch), xterm's internal dimensions go stale. An IntersectionObserver
    // catches the transition from display:none → visible and refits.
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          try { fit.fit(); } catch {}
          try { term.refresh(0, term.rows - 1); } catch {}
        }
      }
    });
    io.observe(hostRef.current);

    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      io.disconnect();
      try { selSub.dispose(); } catch {}
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // ── bridge state subscription ──────────────────────────────────────────
  useEffect(() => bridge.onState(setBootState), []);
  useEffect(() => bridge.onServerReady(({ url }) => {
    onServerUrl?.(url);
    termRef.current?.writeln(`\x1b[36m▶ server-ready: ${url}\x1b[0m`);
  }), [onServerUrl]);

  // Mirror LSP install/startup progress into the terminal so the user
  // can actually see what's happening during the slow first install.
  useEffect(() => lspBridge.onLog((line) => {
    termRef.current?.writeln(`\x1b[35m[lsp]\x1b[0m ${line}`);
  }), []);

  // ── Start a shell after boot ──────────────────────────────────────────
  const startShell = useCallback(async () => {
    const term = termRef.current;
    if (!term || !bridge.ready || processRef.current) return;

    // Wait for xterm to have non-zero dimensions — spawning with cols=0
    // on iPadOS Safari reliably triggers "Process aborted".
    let waited = 0;
    while ((term.cols < 2 || term.rows < 2) && waited < 500) {
      try { fitRef.current?.fit(); } catch { /* noop */ }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50));
      waited += 50;
    }
    const cols = Math.max(term.cols || 80, 20);
    const rows = Math.max(term.rows || 24, 6);

    const trySpawn = async (withTerminal) => {
      const container = bridge.getContainer();
      const opts = withTerminal ? { terminal: { cols, rows } } : undefined;
      return container.spawn('jsh', [], opts);
    };

    let proc = null;
    try {
      proc = await trySpawn(true);
    } catch (err) {
      const msg = String(err?.message || err);
      logger.warn('terminal', `spawn (with terminal) failed: ${msg}`);
      if (/abort/i.test(msg)) {
        // iPadOS fallback: retry once without terminal option.
        await new Promise((r) => setTimeout(r, 300));
        try {
          proc = await trySpawn(false);
          term.writeln('\x1b[33m▶ fallback: spawned without PTY sizing\x1b[0m');
        } catch (err2) {
          logger.error('terminal', 'spawn retry failed', err2);
          term.writeln(`\r\n\x1b[31m✖ shell unavailable: ${String(err2?.message || err2)}\x1b[0m`);
          term.writeln('\x1b[90m# Tip: mount at least one file before booting, then try again.\x1b[0m');
          setProcessRunning(false);
          return;
        }
      } else {
        term.writeln(`\r\n\x1b[31m✖ ${msg}\x1b[0m`);
        setProcessRunning(false);
        return;
      }
    }

    try {
      processRef.current = proc;
      setProcessRunning(true);

      // WC → xterm
      proc.output.pipeTo(new WritableStream({
        write(chunk) {
          term.write(chunk);
          // Detect Node.js v22 WASM crash on Safari's Wasm engine.
          // This is intermittent — retrying (Reboot) usually succeeds.
          if (
            typeof chunk === 'string' &&
            (chunk.includes('Out of bounds memory access') || chunk.includes('RuntimeError'))
          ) {
            term.writeln(
              '\r\n\x1b[33m⚠ Node.js WASM crash detected (intermittent on Safari)\x1b[0m'
            );
            term.writeln(
              '\x1b[90m# Press Reboot ↺ to retry — it usually works on the second attempt.\x1b[0m'
            );
          }
        },
      })).catch((err) => logger.warn('terminal', 'output pipe closed', err));

      // xterm → WC
      const writer = proc.input.getWriter();
      writerRef.current = writer;
      const dataSub = term.onData((data) => {
        writer.write(data).catch(() => {});
      });
      const resizeSub = term.onResize(({ cols: c, rows: r }) => {
        try { proc.resize?.({ cols: c, rows: r }); } catch { /* older jsh has no resize */ }
      });

      const code = await proc.exit;
      dataSub.dispose();
      resizeSub.dispose();
      try { writer.close(); } catch { /* noop */ }
      writerRef.current = null;
      processRef.current = null;
      setProcessRunning(false);
      term.writeln(`\r\n\x1b[90m# process exited (${code})\x1b[0m`);

      // Narrow auto-pull: after any command finishes, scan root for new files.
      if (sink) {
        try {
          const added = await autoPullRootNewFiles(sink);
          if (added.length) term.writeln(`\x1b[36m▶ synced back: ${added.join(', ')}\x1b[0m`);
        } catch (err) { logger.warn('terminal', 'auto-pull failed', err); }
      }
    } catch (err) {
      logger.error('terminal', 'shell loop failed', err);
      term.writeln(`\r\n\x1b[31m✖ ${err?.message || err}\x1b[0m`);
      setProcessRunning(false);
    }
  }, [sink]);

  // ── Boot handler ──────────────────────────────────────────────────────
  const handleBoot = useCallback(async () => {
    setBootError(null);
    const term = termRef.current;
    term?.writeln('\x1b[36m▶ booting WebContainer…\x1b[0m');
    if (typeof window !== 'undefined' && !window.crossOriginIsolated) {
      const msg = 'Cross-origin isolation is OFF (no SharedArrayBuffer). COOP=same-origin + COEP=require-corp response headers required.';
      setBootError(msg);
      term?.writeln(`\x1b[31m✖ ${msg}\x1b[0m`);
      return;
    }
    try {
      // 30-second watchdog — if boot() never resolves we surface the hang
      // rather than leaving the UI stuck on "booting…" forever.
      // Common causes of timeout:
      //   1. Origin not registered at webcontainers.io (check DevTools → Console)
      //   2. VITE_WEBCONTAINER_APIKEY env var not set or not picked up at build time
      //   3. COOP/COEP headers missing (check DevTools → Application → Headers)
      const bootPromise = bridge.boot({ files });
      // The timeout id is captured so we can clear it immediately when boot
      // resolves — without this, the 30s timer burns to completion on every
      // successful boot, holding a closure reference for no reason.
      let watchdogId;
      const timeout = new Promise((_, reject) => {
        watchdogId = setTimeout(() => reject(new Error(
          'boot timed out (30s). Check: 1) DevTools Console for WebContainer errors, ' +
          '2) VITE_WEBCONTAINER_APIKEY is set in Vercel env vars and a fresh deploy was triggered, ' +
          '3) your origin is registered at webcontainers.io'
        )), 30000);
      });
      try {
        await Promise.race([bootPromise, timeout]);
      } finally {
        clearTimeout(watchdogId);
      }
      term?.writeln('\x1b[32m✔ container ready\x1b[0m');
      await startShell();
    } catch (err) {
      const msg = err?.message || String(err);
      setBootError(msg);
      term?.writeln(`\x1b[31m✖ boot failed: ${msg}\x1b[0m`);
      logger.error('terminal', 'boot failed', err);
    }
  }, [files, startShell]);

  const handleReboot = useCallback(async () => {
    const term = termRef.current;
    term?.writeln('\x1b[33m▶ rebooting…\x1b[0m');
    processRef.current = null;
    writerRef.current = null;
    setProcessRunning(false);
    try {
      await bridge.reboot({ files });
      term?.writeln('\x1b[32m✔ rebooted\x1b[0m');
      await startShell();
    } catch (err) {
      term?.writeln(`\x1b[31m✖ reboot failed: ${err?.message || err}\x1b[0m`);
    }
  }, [files, startShell]);

  const handleKill = useCallback(() => {
    const proc = processRef.current;
    if (!proc) return;
    try {
      // Send Ctrl-C to the foreground process instead of tearing down.
      writerRef.current?.write('\x03').catch(() => {});
    } catch (err) { logger.warn('terminal', 'kill failed', err); }
  }, []);

  const handleCopy = useCallback(async () => {
    const term = termRef.current;
    const text = term?.getSelection?.() || '';
    if (!text) return;
    // iPadOS Safari: this MUST be inside the button's onClick user gesture.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for old Safari: execCommand via a temp textarea.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
      }
      term?.writeln(`\x1b[90m# copied ${text.length} chars to clipboard\x1b[0m`);
      // Clear the selection so the next tap targets the input again.
      try { term?.clearSelection?.(); } catch {}
      setHasSelection(false);
    } catch (err) {
      logger.warn('terminal', 'clipboard write failed', err);
      term?.writeln(`\x1b[33m# clipboard blocked: ${err?.message || err}\x1b[0m`);
    }
  }, []);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard?.readText?.();
      if (!text) return;
      const writer = writerRef.current;
      if (writer) {
        await writer.write(text).catch(() => {});
      } else {
        termRef.current?.writeln('\x1b[33m# nothing to paste into — start jsh first\x1b[0m');
      }
    } catch (err) {
      logger.warn('terminal', 'clipboard read failed', err);
      termRef.current?.writeln(`\x1b[33m# paste blocked: ${err?.message || err}\x1b[0m`);
    }
  }, []);

  const handleTeardown = useCallback(async () => {
    const term = termRef.current;
    term?.writeln('\x1b[33m▶ tearing down container…\x1b[0m');
    processRef.current = null;
    writerRef.current = null;
    setProcessRunning(false);
    await bridge.teardown();
    term?.writeln('\x1b[90m# container stopped\x1b[0m');
  }, []);

  const isolated = typeof window !== 'undefined' && window.crossOriginIsolated;

  return (
    <div className="flex flex-col h-full bg-[#0b1020] text-slate-200">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 bg-slate-900/60">
        <span className="text-xs font-medium text-slate-300">
          Terminal · {bootStateLabel(bootState)}
        </span>
        <span className="flex-1" />
        {!isolated && (
          <span className="text-[10px] text-amber-400" title="COOP/COEP headers missing">
            not cross-origin-isolated
          </span>
        )}
        <button
          onClick={handleCopy}
          disabled={!hasSelection}
          title="Copy selection to clipboard"
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Copy className="w-3 h-3" /> Copy
        </button>
        <button
          onClick={handlePaste}
          disabled={!processRunning}
          title="Paste clipboard into shell"
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ClipboardPaste className="w-3 h-3" /> Paste
        </button>
        {bootState !== 'ready' && (
          <button
            onClick={handleBoot}
            disabled={!isolated || bootState === 'booting'}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:cursor-not-allowed"
          >
            {bootState === 'booting' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Power className="w-3 h-3" />}
            Boot container
          </button>
        )}
        {bootState === 'ready' && (
          <>
            <button
              onClick={handleKill}
              disabled={!processRunning}
              title="Send Ctrl-C to the foreground process"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40"
            >
              <Square className="w-3 h-3" /> Kill
            </button>
            <button
              onClick={handleReboot}
              title="Tear down and restart the container"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-amber-600 hover:bg-amber-500"
            >
              <RefreshCw className="w-3 h-3" /> Reboot
            </button>
            <button
              onClick={handleTeardown}
              title="Stop container and free memory"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-rose-600 hover:bg-rose-500"
            >
              <Power className="w-3 h-3" /> Stop
            </button>
          </>
        )}
      </div>
      {bootError && (
        <div className="px-3 py-2 text-xs text-rose-300 bg-rose-950/40 border-b border-rose-900">
          {bootError}
        </div>
      )}
      {/*
       * Terminal viewport.
       * - `overflow-hidden` prevents xterm's internal helper <textarea> (which
       *   sits at the caret position) from being scrolled into view on iPadOS,
       *   which is what created the big selectable "box" under the prompt.
       * - `wc-term` scopes the xterm helper-textarea hiding rules in index.css.
       * - `touch-manipulation` disables the 300 ms tap delay on iPad so the
       *   terminal feels responsive to selection gestures.
       */}
      <div
        ref={hostRef}
        className="wc-term flex-1 min-h-0 p-2 overflow-hidden touch-manipulation"
      />
    </div>
  );
}

function bootStateLabel(s) {
  switch (s) {
    case 'idle': return 'idle';
    case 'booting': return 'booting…';
    case 'ready': return 'ready';
    case 'dead': return 'error';
    default: return s;
  }
}
