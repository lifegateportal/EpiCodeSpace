/**
 * CodeEditor — Monaco wrapper for EpiCodeSpace.
 *
 * Loaded lazily so Monaco's ~2 MB of assets never block the first paint.
 * The parent binds `value` to the active file's content and `onChange` to
 * `patchFile`. Monaco owns its own scrolling, gutter, minimap, and find
 * widget, so the surrounding UI must NOT supply a second scroll container.
 *
 * Imperative handle (`ref.current`):
 *   { value, selectionStart, selectionEnd, focus(), select() }
 *
 * These five are what `editorCut` / `editorCopy` / `editorPaste` /
 * `editorSelectAll` in the monolith were poking on the old textarea, so
 * shimming them keeps those call sites untouched. If a caller tries to
 * *write* to `.value` it won't stick — clipboard handlers are already
 * migrated to call `patchFile` instead.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { Loader2 } from 'lucide-react';

// ─── Theme ───────────────────────────────────────────────────────────────
// Deep charcoal + neon-blue SaaS vibe. Defined once, installed on first
// mount via `loader.init()` so every instance shares a single definition.

const THEME_NAME = 'epicode-charcoal';

const THEME = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '',                  foreground: 'e6e9f0' },
    { token: 'comment',           foreground: '5a6170', fontStyle: 'italic' },
    { token: 'keyword',           foreground: '7dd3fc' },           // neon blue
    { token: 'keyword.control',   foreground: '7dd3fc' },
    { token: 'string',            foreground: 'a5f3d0' },           // mint
    { token: 'number',            foreground: 'fbbf77' },           // amber
    { token: 'type',              foreground: 'c4b5fd' },           // pale violet
    { token: 'function',          foreground: '93c5fd' },
    { token: 'variable',          foreground: 'e6e9f0' },
    { token: 'tag',               foreground: '7dd3fc' },
    { token: 'attribute.name',    foreground: 'c4b5fd' },
    { token: 'attribute.value',   foreground: 'a5f3d0' },
    { token: 'delimiter',         foreground: '8892a6' },
    { token: 'constant',          foreground: 'fbbf77' },
  ],
  colors: {
    'editor.background':                 '#0b1020',
    'editor.foreground':                 '#e6e9f0',
    'editorCursor.foreground':           '#22d3ee',     // neon cyan caret
    'editor.lineHighlightBackground':    '#121934',
    'editor.lineHighlightBorder':        '#00000000',
    'editor.selectionBackground':        '#22d3ee33',   // neon blue @ 20%
    'editor.selectionHighlightBackground': '#22d3ee1c',
    'editor.inactiveSelectionBackground': '#22d3ee1a',
    'editor.wordHighlightBackground':    '#22d3ee1a',
    'editor.findMatchBackground':        '#f59e0b55',
    'editor.findMatchHighlightBackground': '#f59e0b2a',
    'editorLineNumber.foreground':       '#3a4360',
    'editorLineNumber.activeForeground': '#7dd3fc',
    'editorIndentGuide.background':      '#1a2340',
    'editorIndentGuide.activeBackground':'#2a365c',
    'editorGutter.background':           '#0b1020',
    'editorWidget.background':           '#121934',
    'editorWidget.border':               '#22d3ee33',
    'editorSuggestWidget.background':    '#121934',
    'editorSuggestWidget.border':        '#22d3ee33',
    'editorSuggestWidget.selectedBackground': '#22d3ee22',
    'scrollbar.shadow':                  '#00000000',
    'scrollbarSlider.background':        '#22d3ee22',
    'scrollbarSlider.hoverBackground':   '#22d3ee44',
    'scrollbarSlider.activeBackground':  '#22d3ee66',
    'focusBorder':                       '#00000000',
  },
};

let themeInstalled = false;
loader.init().then((monaco) => {
  if (themeInstalled) return;
  monaco.editor.defineTheme(THEME_NAME, THEME);
  themeInstalled = true;
}).catch(() => { /* loader errors surface through Editor's <Loading> */ });

// ─── Language map ────────────────────────────────────────────────────────
// Monaco's own identifiers. Anything not listed falls back to 'plaintext'
// so we never trigger its heavy TypeScript worker unnecessarily.

const EXT_TO_MONACO = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', svg: 'html',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown',
  py: 'python',
  yml: 'yaml', yaml: 'yaml',
  sh: 'shell', bash: 'shell',
  sql: 'sql',
  xml: 'xml',
  dockerfile: 'dockerfile',
};

function detectLanguage(path) {
  if (!path) return 'plaintext';
  const name = path.split('/').pop().toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  const ext = name.split('.').pop();
  return EXT_TO_MONACO[ext] || 'plaintext';
}

// ─── Component ───────────────────────────────────────────────────────────

function Fallback() {
  return (
    <div className="flex-1 flex items-center justify-center bg-[#0b1020] text-fuchsia-300/70 text-xs gap-2">
      <Loader2 size={14} className="animate-spin" />
      Loading editor…
    </div>
  );
}

const CodeEditor = forwardRef(function CodeEditor(
  {
    path,
    value,
    onChange,
    onCursorChange,
    fontSize = 13,
    wordWrap = false,
    readOnly = false,
  },
  ref,
) {
  const editorRef = useRef(null);
  const monacoRef = useRef(null);

  // Shim the old textarea API so existing `editorCut/Copy/Paste/SelectAll`
  // call sites keep working without bespoke Monaco code paths.
  useImperativeHandle(ref, () => ({
    get value() {
      return editorRef.current?.getValue() ?? '';
    },
    get selectionStart() {
      const ed = editorRef.current;
      if (!ed) return 0;
      const model = ed.getModel();
      const sel = ed.getSelection();
      return model && sel ? model.getOffsetAt(sel.getStartPosition()) : 0;
    },
    get selectionEnd() {
      const ed = editorRef.current;
      if (!ed) return 0;
      const model = ed.getModel();
      const sel = ed.getSelection();
      return model && sel ? model.getOffsetAt(sel.getEndPosition()) : 0;
    },
    focus() { editorRef.current?.focus(); },
    select() {
      const ed = editorRef.current;
      const model = ed?.getModel();
      if (!ed || !model) return;
      ed.setSelection(model.getFullModelRange());
    },
    getMonaco() { return editorRef.current; },
  }), []);

  const handleMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    // Theme is installed lazily by `loader.init()` above, but on a cold
    // tab the editor may mount before that promise resolves. Re-apply
    // here to catch that race.
    try { monaco.editor.defineTheme(THEME_NAME, THEME); } catch { /* already defined */ }
    monaco.editor.setTheme(THEME_NAME);

    // Install the LSP adapter. Fails soft: if the module or provider
    // registration throws, the editor keeps working with Monaco's
    // built-in TS/JS services.
    import('../lib/lsp/monacoAdapter.ts')
      .then(({ installMonacoAdapter }) => {
        try { installMonacoAdapter(monaco); }
        catch (err) { console.warn('[lsp] adapter install threw', err); }
      })
      .catch((err) => console.warn('[lsp] adapter import failed', err));

    if (onCursorChange) {
      editor.onDidChangeCursorPosition(() => {
        const pos = editor.getPosition();
        if (pos) onCursorChange({ line: pos.lineNumber, col: pos.column });
      });
    }
  }, [onCursorChange]);

  // Update readonly state without remounting the editor.
  useEffect(() => {
    editorRef.current?.updateOptions?.({ readOnly });
  }, [readOnly]);

  const language = detectLanguage(path);

  return (
    <div className="flex-1 min-w-0 min-h-0 overflow-hidden bg-[#0b1020]">
      <Editor
        path={path || 'untitled'}
        language={language}
        value={value ?? ''}
        theme={THEME_NAME}
        loading={<Fallback />}
        onChange={(v) => onChange?.(v ?? '')}
        onMount={handleMount}
        options={{
          fontSize,
          wordWrap: wordWrap ? 'on' : 'off',
          minimap: { enabled: false },                 // iPad real-estate
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          automaticLayout: true,                        // re-measures on container resize
          tabSize: 2,
          insertSpaces: true,
          renderWhitespace: 'selection',
          renderLineHighlight: 'line',
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          fontLigatures: true,
          fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
          lineNumbers: 'on',
          folding: true,
          showFoldingControls: 'mouseover',
          padding: { top: 12, bottom: 12 },
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
            useShadows: false,
            alwaysConsumeMouseWheel: false,            // lets iPad scroll page when at edge
          },
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          overviewRulerBorder: false,
          guides: { indentation: true, bracketPairs: true },
          bracketPairColorization: { enabled: true },
          suggestFontSize: 12,
          quickSuggestions: { other: true, comments: false, strings: false },
          readOnly,
        }}
      />
    </div>
  );
});

export default CodeEditor;
export { detectLanguage };
