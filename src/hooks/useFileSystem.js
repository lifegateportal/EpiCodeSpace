import { useCallback, useEffect, useReducer, useRef } from 'react';
import { loadFS, saveFS } from '../lib/storage.js';
import { logger } from '../lib/logger.js';

/**
 * Amendment #5 — State management.
 * Encapsulates all filesystem mutations behind a reducer so that mutations are
 * predictable, testable, and debuggable. Persists to localStorage (debounced).
 *
 * This hook is the single source of truth for the virtual filesystem; other
 * layers (editor, explorer, AI tools) should call its action methods instead
 * of mutating state directly.
 */

const EXT_TO_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  css: 'css', scss: 'css',
  html: 'html', htm: 'html',
  json: 'json', md: 'markdown',
  py: 'python', yml: 'yaml', yaml: 'yaml',
};

function languageFor(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  return EXT_TO_LANG[ext] || 'text';
}

function reducer(state, action) {
  switch (action.type) {
    case 'set':
      return action.files;
    case 'write': {
      const { path, content, language } = action;
      const name = path.split('/').pop();
      return { ...state, [path]: { name, language: language || languageFor(path), content } };
    }
    case 'patch': {
      const { path, content } = action;
      if (!state[path]) return state;
      return { ...state, [path]: { ...state[path], content } };
    }
    case 'rename': {
      const { oldPath, newPath } = action;
      if (!state[oldPath] || state[newPath] || oldPath === newPath) return state;
      const next = { ...state };
      next[newPath] = { ...next[oldPath], name: newPath.split('/').pop() };
      delete next[oldPath];
      return next;
    }
    case 'delete': {
      const next = { ...state };
      delete next[action.path];
      return next;
    }
    case 'deletePrefix': {
      const next = { ...state };
      Object.keys(next).forEach(p => { if (p === action.prefix || p.startsWith(action.prefix + '/')) delete next[p]; });
      return next;
    }
    default:
      logger.warn('useFileSystem', `Unknown action: ${action?.type}`);
      return state;
  }
}

export function useFileSystem() {
  const [fileSystem, dispatch] = useReducer(reducer, undefined, loadFS);
  const fsRef = useRef(fileSystem);
  fsRef.current = fileSystem;

  // Debounced persistence — avoids thrashing localStorage on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      try { saveFS(fileSystem); }
      catch (err) { logger.error('useFileSystem', 'Persist failed', err); }
    }, 400);
    return () => clearTimeout(t);
  }, [fileSystem]);

  const replaceAll = useCallback((files) => dispatch({ type: 'set', files: files || {} }), []);
  const writeFile = useCallback((path, content = '', language) => dispatch({ type: 'write', path, content, language }), []);
  const patchFile = useCallback((path, content) => dispatch({ type: 'patch', path, content }), []);
  const renameFile = useCallback((oldPath, newPath) => dispatch({ type: 'rename', oldPath, newPath }), []);
  const deleteFile = useCallback((path) => dispatch({ type: 'delete', path }), []);
  const deletePrefix = useCallback((prefix) => dispatch({ type: 'deletePrefix', prefix }), []);

  return {
    fileSystem,
    // Read-only accessor that always returns the latest (useful in callbacks
    // that otherwise close over stale state)
    getLatest: () => fsRef.current,
    replaceAll,
    writeFile,
    patchFile,
    renameFile,
    deleteFile,
    deletePrefix,
    dispatch,
  };
}

export { languageFor };
export default useFileSystem;
