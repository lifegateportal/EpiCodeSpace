import React, { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { RefreshCw, Square, Power, Loader2, Copy, ClipboardPaste, UploadCloud, AlertTriangle } from 'lucide-react';
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
const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJhilrsu]|\x1b\][^\x07]*\x07|\x1b[>=]|\r/g;

const WebContainerTerminal = forwardRef(function WebContainerTerminal({ files, sink, serverUrl, onServerUrl, onOutput }, ref) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const processRef = useRef(null);
  const writerRef = useRef(null);
  const [bootState, setBootState] = useState(bridge.state);
  const [bootError, setBootError] = useState(null);
  const [reloadRequired, setReloadRequired] = useState(false);
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
    // Tell the user to use the in-app Preview tab — opening the WebContainer
    // URL in a new browser tab shows a blank page because the container's
    // network proxy is tied to this browsing context.
    termRef.current?.writeln(`\x1b[36m▶ server-ready — PREVIEW tab is open\x1b[0m`);
    termRef.current?.writeln(`\x1b[90m# Wait a moment, then tap "Load Preview" in the Preview tab.\x1b[0m`);
    termRef.current?.writeln(`\x1b[90m# Do NOT open the URL directly — it will abort the shell on Safari.\x1b[0m`);
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
          if (onOutput && typeof chunk === 'string') {
            const clean = chunk.replace(ANSI_RE, '');
            clean.split('\n').forEach(line => { if (line.trim()) onOutput(line.trim()); });
          }
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
      const msg = err?.message || String(err);
      term.writeln(`\r\n\x1b[31m✖ ${msg}\x1b[0m`);
      if (/abort/i.test(msg)) {
        term.writeln('\x1b[90m# The shell was aborted — usually memory pressure (common on iPadOS with heavy\x1b[0m');
        term.writeln('\x1b[90m# Node.js processes like Next.js). Click "New Shell ↺" to restart without rebooting.\x1b[0m');
      }
      setProcessRunning(false);
    }
  }, [sink]);

  // ── Safari background-kill detector ──────────────────────────────────
  // iPadOS aggressively suspends WASM processes when you switch to another
  // app or tab. We detect the return and auto-restart jsh so the user
  // doesn't have to manually tap "New Shell" every time.
  const startShellRef = useRef(startShell);
  useEffect(() => { startShellRef.current = startShell; }, [startShell]);

  useEffect(() => {
    let wakeLock = null;

    const onHide = async () => {
      // Warn immediately when the tab goes to background.
      if (processRef.current) {
        termRef.current?.writeln(
          '\r\n\x1b[33m⚠ Tab backgrounded — Safari may kill the WebContainer.\x1b[0m'
        );
        termRef.current?.writeln(
          '\x1b[90m# Return quickly. If the shell dies, EpiCodeSpace will restart it.\x1b[0m'
        );
      }
      // Request screen wake lock to slow down Safari's aggression (iOS 16.4+).
      try {
        wakeLock = await navigator.wakeLock?.request('screen');
      } catch { /* not available or denied */ }
    };

    const onShow = async () => {
      // Release wake lock now that we're foregrounded again.
      try { await wakeLock?.release(); } catch {} finally { wakeLock = null; }

      const state = bridge.state;
      if (state === 'ready' && !processRef.current) {
        // Container alive but jsh was killed — restart the shell automatically.
        termRef.current?.writeln(
          '\r\n\x1b[33m⚠ Returned from background — shell was killed by Safari.\x1b[0m'
        );
        termRef.current?.writeln('\x1b[36m▶ Restarting shell…\x1b[0m');
        try { await startShellRef.current(); } catch (err) {
          termRef.current?.writeln(`\x1b[31m✖ auto-restart failed: ${err?.message || err}\x1b[0m`);
        }
      } else if (state === 'idle' || state === 'dead') {
        termRef.current?.writeln(
          '\r\n\x1b[33m⚠ Returned from background — WebContainer was killed by Safari.\x1b[0m'
        );
        termRef.current?.writeln(
          '\x1b[90m# Tap "Reboot ↺" to restart.\x1b[0m'
        );
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) { onHide(); } else { onShow(); }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      try { wakeLock?.release(); } catch {}
    };
  }, []); // no deps — uses refs to read current values

  // ── WebContainers storage recovery ────────────────────────────────────
  // Clears all WebContainers-owned browser storage so a fresh boot can succeed.
  // WebContainers persists state in three places that can become corrupt after
  // a Safari mid-boot kill or a failed boot with a bad API key:
  //   1. OPFS — virtual FS entries (already cleared on prior attempt)
  //   2. Service Workers — network proxy SW stays registered after crashes;
  //      a stale/corrupted SW causes every subsequent boot to ENOENT
  //   3. IndexedDB — internal bookkeeping databases
  const clearWebContainerOPFS = useCallback(async () => {
    const term = termRef.current;
    let cleared = 0;

    // 1. OPFS — remove entries not matching user file names
    try {
      const root = await navigator.storage.getDirectory();
      const userNames = new Set(
        Object.keys(files).map(p => p.split('/')[0]).filter(Boolean)
      );
      const toDelete = [];
      for await (const name of root.keys()) {
        if (!userNames.has(name)) toDelete.push(name);
      }
      for (const name of toDelete) {
        try { await root.removeEntry(name, { recursive: true }); } catch { /* ignore */ }
      }
      if (toDelete.length > 0) {
        term?.writeln(`\x1b[33m  OPFS: removed ${toDelete.length} entr${toDelete.length === 1 ? 'y' : 'ies'}\x1b[0m`);
        cleared += toDelete.length;
      }
    } catch (e) {
      term?.writeln(`\x1b[33m  OPFS cleanup error: ${e?.message || e}\x1b[0m`);
    }

    // 2. Service Workers — unregister all registrations for this origin.
    //    WebContainers registers a SW to proxy npm/network requests.
    //    A stale SW from a failed/killed boot causes ENOENT on re-boot.
    try {
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(r => r.unregister().catch(() => {})));
        if (registrations.length > 0) {
          term?.writeln(`\x1b[33m  Service Workers: unregistered ${registrations.length}\x1b[0m`);
          cleared += registrations.length;
        }
      }
    } catch (e) {
      term?.writeln(`\x1b[33m  SW cleanup error: ${e?.message || e}\x1b[0m`);
    }

    // 3. IndexedDB — delete databases that look like WebContainers internal DBs
    //    (names not matching user file names, or starting with known WC prefixes).
    try {
      if (indexedDB?.databases) {
        const dbs = await indexedDB.databases();
        const userNames = new Set(
          Object.keys(files).map(p => p.split('/')[0]).filter(Boolean)
        );
        for (const { name } of dbs) {
          if (!name) continue;
          // Keep databases that match user project top-level names; delete others.
          const topLevel = name.split('/')[0].split(':')[0];
          if (!userNames.has(topLevel)) {
            try { indexedDB.deleteDatabase(name); cleared++; } catch { /* ignore */ }
          }
        }
      }
    } catch (e) {
      // indexedDB.databases() is not available in all browsers — ignore.
    }

    if (cleared === 0) {
      term?.writeln('\x1b[33m  nothing to clear\x1b[0m');
    }
    return cleared;
  }, [files]);

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
    const attemptBoot = async () => {
      const bootPromise = bridge.boot({ files });
      let watchdogId;
      const timeout = new Promise((_, reject) => {
        watchdogId = setTimeout(() => reject(new Error(
          'boot timed out (30s) — COOP/COEP headers may be missing or the container is stuck'
        )), 30000);
      });
      try {
        await Promise.race([bootPromise, timeout]);
      } finally {
        clearTimeout(watchdogId);
      }
    };
    try {
      await attemptBoot();
      // Successful boot — clear the ENOENT-reload flag so a future failure
      // will auto-reload again (it's only a loop-guard, not a permanent flag).
      sessionStorage.removeItem('wc-enoent-reload');
      term?.writeln('\x1b[32m✔ container ready\x1b[0m');
      await startShell();
    } catch (err) {
      const msg = err?.message || String(err);
      const isEnoent = /ENOENT|no such file/i.test(msg);
      if (isEnoent) {
        // ENOENT means WebContainers' module state (cachedServerPromise, etc.) is
        // corrupted from the failed boot. That state is JS-memory-only and cannot
        // be reset without a full page reload. Strategy:
        //   1. Clear persistent storage (OPFS / SW / IDB).
        //   2. Auto-reload. A sessionStorage flag prevents infinite reload loops —
        //      if ENOENT persists after a reload we surface the manual button.
        term?.writeln(`\x1b[33m▶ boot failed (${msg}) — clearing WebContainers cache…\x1b[0m`);
        await clearWebContainerOPFS();

        const alreadyReloaded = sessionStorage.getItem('wc-enoent-reload') === '1';
        if (alreadyReloaded) {
          // We already reloaded once and still ENOENT — show manual button.
          term?.writeln('\x1b[33m✔ cache cleared — tap "Reload Page" above to retry\x1b[0m');
          term?.writeln(`\x1b[90m# error: ${msg}\x1b[0m`);
          setReloadRequired(true);
        } else {
          sessionStorage.setItem('wc-enoent-reload', '1');
          term?.writeln('\x1b[33m✔ cache cleared — reloading page…\x1b[0m');
          // Short delay so the user can read the message before reload.
          setTimeout(() => window.location.reload(), 1200);
        }
        return;
      }
      setBootError(msg);
      term?.writeln(`\x1b[31m✖ boot failed: ${msg}\x1b[0m`);
      logger.error('terminal', 'boot failed', err);
    }
  }, [files, startShell, clearWebContainerOPFS]);

  const handleClearAndReboot = useCallback(async () => {
    // After ENOENT, WebContainers holds corrupted in-memory state that persists
    // until page reload. Clear storage first, then reload — don't attempt reboot.
    const term = termRef.current;
    term?.writeln('\x1b[33m▶ clearing WebContainer cache…\x1b[0m');
    processRef.current = null;
    writerRef.current = null;
    setProcessRunning(false);
    await clearWebContainerOPFS();
    term?.writeln('\x1b[33m✔ cache cleared — reloading page…\x1b[0m');
    window.location.reload();
  }, [clearWebContainerOPFS]);

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

  // ── Imperative API for programmatic command injection ─────────────────
  useImperativeHandle(ref, () => ({
    /** Send a command to the live jsh shell (appends \n). Returns true if dispatched. */
    sendCommand(cmd) {
      const writer = writerRef.current;
      if (writer) {
        writer.write(cmd + '\n').catch(() => {});
        return true;
      }
      // Shell not started yet — show a hint in the terminal
      termRef.current?.writeln(`\x1b[33m⚠ Runtime not ready — click "Boot container" first, then the agent will retry.\x1b[0m`);
      termRef.current?.writeln(`\x1b[90m# Pending command: ${cmd}\x1b[0m`);
      return false;
    },
    isReady() {
      return !!writerRef.current;
    },
  }), []);

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

  const handleSyncFiles = useCallback(async () => {
    const term = termRef.current;
    term?.writeln('\x1b[36m▶ syncing files to container…\x1b[0m');
    try {
      await bridge.syncFiles(files);
      term?.writeln(`\x1b[32m✔ synced ${Object.keys(files).length} files — run your commands now\x1b[0m`);
    } catch (err) {
      term?.writeln(`\x1b[31m✖ sync failed: ${err?.message || err}\x1b[0m`);
    }
  }, [files]);

  const isolated = typeof window !== 'undefined' && window.crossOriginIsolated;
  // Prefer the baked-in production URL so the link bypasses the Replit dev
  // proxy, which strips COOP/COEP and keeps crossOriginIsolated false.
  const appUrl = import.meta.env.VITE_APP_URL || (typeof window !== 'undefined' ? window.location.href : '');

  return (
    <div className="flex flex-col h-full bg-[#0b1020] text-slate-200">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 bg-slate-900/60">
        <span className="text-xs font-medium text-slate-300">
          Terminal · {bootStateLabel(bootState)}
        </span>
        <span className="flex-1" />
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
          <>
            <button
              onClick={handleBoot}
              disabled={!isolated || bootState === 'booting' || reloadRequired}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:cursor-not-allowed"
              title={reloadRequired ? 'Page reload required — tap Reload Page' : !isolated ? 'Open the app in a new browser tab to enable the terminal' : 'Boot the WebContainer'}
            >
              {bootState === 'booting' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Power className="w-3 h-3" />}
              Boot container
            </button>
            {reloadRequired && (
              <button
                onClick={() => { clearWebContainerOPFS().then(() => window.location.reload()); }}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-amber-600 hover:bg-amber-500 font-semibold"
                title="Clear WebContainer cache and reload the page — required to recover from ENOENT"
              >
                <RefreshCw className="w-3 h-3" /> Reload Page
              </button>
            )}
            {bootError && !reloadRequired && /ENOENT|no such file/i.test(bootError) && (
              <button
                onClick={handleClearAndReboot}
                disabled={!isolated || bootState === 'booting'}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-rose-700 hover:bg-rose-600 disabled:opacity-40"
                title="Clear corrupted WebContainer cache and reload"
              >
                <RefreshCw className="w-3 h-3" /> Clear &amp; Reload
              </button>
            )}
          </>
        )}
        {bootState === 'ready' && (
          <>
            <button
              onClick={handleSyncFiles}
              title="Push current editor files into the running container (no reboot)"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500"
            >
              <UploadCloud className="w-3 h-3" /> Sync Files
            </button>
            {!processRunning && (
              <button
                onClick={startShell}
                title="Start a new shell without rebooting the container (useful after a shell crash)"
                className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-cyan-700 hover:bg-cyan-600 animate-pulse"
              >
                <RefreshCw className="w-3 h-3" /> New Shell
              </button>
            )}
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

      {/* Not isolated banner */}
      {!isolated && (
        <div className="px-4 py-3 bg-amber-950/50 border-b border-amber-800/50 text-xs text-amber-200 space-y-2">
          <p className="font-semibold text-amber-300">⚠ Terminal requires a new browser tab</p>
          <p className="text-amber-200/80 leading-relaxed">
            The in-browser terminal (WebContainers) needs cross-origin isolation, which only works when the app is open as a <strong>top-level browser tab</strong> — not inside the Replit preview iframe.
          </p>
          <div className="flex items-center gap-2 pt-0.5">
            <a
              href={appUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded font-medium transition-colors"
            >
              Open published app →
            </a>
            <span className="text-amber-400/60">then click the RUNTIME tab and Boot container</span>
          </div>
          <p className="text-amber-400/50 text-[10px]">
            Also ensure your Replit app URL is registered at webcontainers.io under your API key's allowed origins.
          </p>
        </div>
      )}

      {/* Safari background-kill warning — shown when a process is running */}
      {isolated && processRunning && (
        <div className="flex items-start gap-2 px-3 py-2 bg-yellow-950/40 border-b border-yellow-800/40 text-[10px] text-yellow-300/80">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-yellow-500/70" />
          <span>
            <strong className="text-yellow-300">Keep this tab open.</strong>
            {' '}Safari kills WebContainer WASM when you switch away.
            If the shell dies, EpiCodeSpace will auto-restart it when you return.
          </span>
        </div>
      )}

      {reloadRequired && (
        <div className="px-3 py-2 text-xs text-amber-300 bg-amber-950/40 border-b border-amber-900 flex items-center gap-2">
          <RefreshCw className="w-3 h-3 shrink-0" />
          Boot failed — tap <strong className="text-amber-200">Reload Page</strong> above to recover.
        </div>
      )}
      {bootError && !reloadRequired && (
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
});

export default WebContainerTerminal;

function bootStateLabel(s) {
  switch (s) {
    case 'idle': return 'idle';
    case 'booting': return 'booting…';
    case 'ready': return 'ready';
    case 'dead': return 'error';
    default: return s;
  }
}
