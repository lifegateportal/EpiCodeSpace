import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

/**
 * Amendment #6 — Observability.
 * Lightweight toast system + confirm dialog. Replaces the native `alert()` and
 * `window.confirm()` calls so messaging stays inside the app chrome, is
 * accessible (aria-live region, role="status"), and is testable.
 */

const ToastContext = createContext(null);

let idSeed = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [confirmState, setConfirmState] = useState(null);
  const resolverRef = useRef(null);

  const remove = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const push = useCallback((toast) => {
    const id = ++idSeed;
    const duration = toast.duration ?? 4000;
    setToasts(prev => [...prev, { id, ...toast }]);
    if (duration > 0) setTimeout(() => remove(id), duration);
    return id;
  }, [remove]);

  const api = {
    info:    (msg, opts) => push({ type: 'info',    message: msg, ...opts }),
    success: (msg, opts) => push({ type: 'success', message: msg, ...opts }),
    error:   (msg, opts) => push({ type: 'error',   message: msg, duration: 7000, ...opts }),
    warn:    (msg, opts) => push({ type: 'warn',    message: msg, ...opts }),
    confirm: (message, opts = {}) => new Promise((resolve) => {
      resolverRef.current = resolve;
      setConfirmState({ message, title: opts.title || 'Confirm', danger: !!opts.danger, confirmLabel: opts.confirmLabel || 'OK', cancelLabel: opts.cancelLabel || 'Cancel' });
    }),
  };

  const handleConfirm = (ok) => {
    setConfirmState(null);
    resolverRef.current?.(ok);
    resolverRef.current = null;
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster toasts={toasts} onDismiss={remove} />
      {confirmState && <ConfirmDialog state={confirmState} onResolve={handleConfirm} />}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

function Toaster({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      className="fixed z-[200] flex flex-col gap-2 pointer-events-none"
      style={{
        bottom: 'max(1rem, var(--sab))',
        right: 'max(1rem, var(--sar))',
        maxWidth: 'calc(100vw - 2rem)',
      }}
    >
      {toasts.map(t => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto flex items-start gap-2.5 min-w-[240px] max-w-sm px-3 py-2.5 rounded-lg shadow-xl border backdrop-blur
            ${t.type === 'success' ? 'bg-green-500/15 border-green-500/40 text-green-100' :
              t.type === 'error'   ? 'bg-red-500/15 border-red-500/40 text-red-100' :
              t.type === 'warn'    ? 'bg-yellow-500/15 border-yellow-500/40 text-yellow-100' :
                                     'bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-100'}`}
        >
          <span className="shrink-0 mt-0.5">
            {t.type === 'success' ? <CheckCircle2 size={14} className="text-green-400"/> :
             t.type === 'error'   ? <AlertCircle size={14} className="text-red-400"/> :
             t.type === 'warn'    ? <AlertCircle size={14} className="text-yellow-400"/> :
                                    <Info size={14} className="text-fuchsia-300"/>}
          </span>
          <div className="flex-1 text-[12px] leading-relaxed">
            {t.title && <div className="font-semibold mb-0.5">{t.title}</div>}
            <div className="whitespace-pre-wrap break-words">{t.message}</div>
          </div>
          <button
            aria-label="Dismiss notification"
            onClick={() => onDismiss(t.id)}
            className="shrink-0 text-current/60 hover:text-current transition-opacity"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

function ConfirmDialog({ state, onResolve }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onKeyDown={(e) => { if (e.key === 'Escape') onResolve(false); }}
    >
      <div
        tabIndex={-1}
        ref={(el) => el?.focus()}
        className="bg-[#15092a] border border-fuchsia-500/30 rounded-xl shadow-[0_0_40px_rgba(192,38,211,0.25)] p-6 w-[360px] max-w-[90vw] focus:outline-none"
      >
        <h2 id="confirm-title" className="text-sm font-semibold text-purple-100 mb-2">{state.title}</h2>
        <p className="text-xs text-purple-300/80 mb-5 leading-relaxed whitespace-pre-wrap break-words">{state.message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => onResolve(false)}
            className="text-xs text-purple-300 hover:text-purple-100 bg-white/5 hover:bg-white/10 border border-white/10 rounded-md px-3 py-1.5 transition-colors"
          >
            {state.cancelLabel}
          </button>
          <button
            autoFocus
            onClick={() => onResolve(true)}
            className={`text-xs text-white rounded-md px-3 py-1.5 transition-colors ${state.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-fuchsia-600 hover:bg-fuchsia-500'}`}
          >
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
