/**
 * Amendment #6 — Observability
 * Structured logger. Emits to console in dev, buffers last 100 events, and
 * exposes a subscribe() API so UI panels (e.g. Debug Console) can tail it.
 * No-op in production unless EPICODESPACE_DEBUG=1 is set in localStorage.
 */
const BUFFER_SIZE = 100;
const buffer = [];
const subscribers = new Set();

const isDev = (() => {
  try { return import.meta.env?.DEV || localStorage.getItem('EPICODESPACE_DEBUG') === '1'; }
  catch { return false; }
})();

function serializeData(data) {
  if (data === undefined) return undefined;
  if (data instanceof Error) return { message: data.message, name: data.name, stack: data.stack };
  if (typeof data === 'object' && data !== null) {
    // Shallow-clone so Error objects nested inside plain objects are also captured.
    const out = {};
    for (const k of Object.keys(data)) {
      out[k] = data[k] instanceof Error ? { message: data[k].message, name: data[k].name } : data[k];
    }
    return out;
  }
  return data;
}

function emit(level, scope, message, data) {
  const entry = { level, scope, message, data: serializeData(data), ts: Date.now() };
  buffer.push(entry);
  if (buffer.length > BUFFER_SIZE) buffer.shift();
  subscribers.forEach(fn => { try { fn(entry); } catch { /* ignore subscriber errors */ } });
  if (isDev) {
    const tag = `[${scope}]`;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'info' ? console.info : console.log;
    data !== undefined ? fn(tag, message, data) : fn(tag, message);
  }
}

export const logger = {
  debug: (scope, msg, data) => emit('debug', scope, msg, data),
  info:  (scope, msg, data) => emit('info',  scope, msg, data),
  warn:  (scope, msg, data) => emit('warn',  scope, msg, data),
  error: (scope, msg, data) => emit('error', scope, msg, data),
  getBuffer: () => buffer.slice(),
  subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
  clear: () => { buffer.length = 0; },
};

export default logger;
