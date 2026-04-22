import React, { useEffect, useState, useCallback } from 'react';
import { Zap, Loader2, AlertTriangle, Circle, RefreshCw } from 'lucide-react';
import { lspBridge } from '../lib/lsp/TsLspBridge.ts';
import { bridge as wcBridge } from '../lib/runtime/WebContainerBridge.ts';

const isSafariOrWebKit = typeof window !== 'undefined' &&
  /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

/**
 * Compact status-bar pill showing the TypeScript LSP connection state.
 * Click to start / restart. Gracefully degraded — if anything about the
 * LSP stack throws it only affects this pill, never the editor.
 */
export default function LspStatusBadge() {
  const [state, setState] = useState(lspBridge.state);
  const [error, setError] = useState(lspBridge.lastError);
  const [wcState, setWcState] = useState(wcBridge.state);

  useEffect(() => lspBridge.onState((s) => {
    setState(s);
    setError(lspBridge.lastError);
  }), []);
  useEffect(() => wcBridge.onState(setWcState), []);

  const click = useCallback(async () => {
    try {
      if (state === 'error' || state === 'disconnected' || state === 'idle') {
        await lspBridge.start();
      } else if (state === 'ready') {
        await lspBridge.restart();
      }
    } catch (err) {
      // start()/restart() already route failures through setState; we
      // just don't want the click handler to bubble an unhandled reject.
      console.warn('[lsp] click handler', err);
    }
  }, [state]);

  const disabled = wcState !== 'ready' && state === 'idle';

  // On Safari/WebKit the LSP npm install doesn't work. Show a static
  // "built-in" pill that informs but doesn't confuse with "error".
  if (isSafariOrWebKit) {
    return (
      <div
        title="Monaco built-in TypeScript is active (full LSP requires Chrome/Edge)"
        className="hidden sm:flex items-center gap-1 px-2 h-full border-l border-fuchsia-500/10 text-cyan-300/70 cursor-default"
      >
        <Zap size={12} />
        <span className="hidden md:inline">TS: built-in</span>
      </div>
    );
  }

  const { icon, label, cls, title } = presentation(state, wcState, error);

  return (
    <button
      type="button"
      onClick={click}
      disabled={disabled}
      title={title}
      className={`hidden sm:flex items-center gap-1 px-2 h-full border-l border-fuchsia-500/10 transition-colors ${cls} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-[#25104a]'}`}
    >
      {icon}
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

function presentation(state, wcState, error) {
  if (wcState !== 'ready' && state === 'idle') {
    return {
      icon: <Circle size={10} />,
      label: 'LSP: offline',
      cls: 'text-purple-400/60',
      title: 'Boot the WebContainer to enable the TypeScript language server.',
    };
  }
  switch (state) {
    case 'idle':
      return {
        icon: <Zap size={12} />,
        label: 'LSP: start',
        cls: 'text-cyan-300',
        title: 'Click to start the TypeScript language server inside the WebContainer.',
      };
    case 'installing':
      return {
        icon: <Loader2 size={12} className="animate-spin" />,
        label: 'LSP: installing',
        cls: 'text-amber-300',
        title: 'Installing typescript-language-server via npm inside the container…',
      };
    case 'starting':
      return {
        icon: <Loader2 size={12} className="animate-spin" />,
        label: 'LSP: starting',
        cls: 'text-cyan-300',
        title: 'Initializing the TypeScript language server…',
      };
    case 'ready':
      return {
        icon: <Zap size={12} className="drop-shadow-[0_0_3px_rgba(34,211,238,0.8)]" />,
        label: 'LSP: ready',
        cls: 'text-cyan-200',
        title: 'TypeScript language server is running. Click to restart.',
      };
    case 'disconnected':
      return {
        icon: <AlertTriangle size={12} />,
        label: 'LSP: disconnected',
        cls: 'text-amber-300',
        title: `Server exited${error ? ` (${error})` : ''}. Click to reconnect.`,
      };
    case 'error':
    default:
      return {
        icon: <RefreshCw size={12} />,
        label: 'LSP: error',
        cls: 'text-rose-300',
        title: error ? `LSP error: ${error}. Click to retry.` : 'LSP error. Click to retry.',
      };
  }
}
