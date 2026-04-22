// Monaco ↔ LSP adapter.
//
// Registers Monaco language providers (completion, hover, definition,
// signature help) and translates each Monaco request into an LSP request
// over the TsLspBridge connection. Also syncs document open/change/close
// notifications so the server sees the same content Monaco does.
//
// Every provider is wrapped in try/catch so a dead LSP connection
// silently returns null — Monaco falls back to its built-in providers.

import * as lsp from 'vscode-languageserver-protocol';
import { lspBridge } from './TsLspBridge.ts';
import { logger } from '../logger.js';

type MonacoApi = typeof import('monaco-editor');
type ITextModel = import('monaco-editor').editor.ITextModel;
type Disposable = import('monaco-editor').IDisposable;

const LSP_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'typescriptreact',
  'javascriptreact',
  // Monaco uses 'typescript' as id for .tsx too via @monaco-editor/react.
  // The LSP server accepts both — we pass the model's languageId verbatim.
]);

function modelUri(model: ITextModel): string {
  // Monaco URIs look like `inmemory://model/1`. The LSP server doesn't
  // care as long as we're consistent — but rooting under file:/// makes
  // tsserver happier because it looks like a real path. We map by the
  // model's resource path.
  const p = model.uri.path.replace(/^\//, '');
  return `file:///home/epicodespace/${p || model.uri.toString()}`;
}

function posToLsp(position: { lineNumber: number; column: number }): lsp.Position {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

function lspRangeToMonaco(r: lsp.Range) {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

function lspSeverityToMonaco(monaco: MonacoApi, s: lsp.DiagnosticSeverity | undefined): number {
  switch (s) {
    case lsp.DiagnosticSeverity.Error:       return monaco.MarkerSeverity.Error;
    case lsp.DiagnosticSeverity.Warning:     return monaco.MarkerSeverity.Warning;
    case lsp.DiagnosticSeverity.Information: return monaco.MarkerSeverity.Info;
    case lsp.DiagnosticSeverity.Hint:        return monaco.MarkerSeverity.Hint;
    default:                                  return monaco.MarkerSeverity.Info;
  }
}

function lspKindToMonaco(monaco: MonacoApi, k: lsp.CompletionItemKind | undefined): number {
  const K = monaco.languages.CompletionItemKind;
  switch (k) {
    case lsp.CompletionItemKind.Method:        return K.Method;
    case lsp.CompletionItemKind.Function:      return K.Function;
    case lsp.CompletionItemKind.Constructor:   return K.Constructor;
    case lsp.CompletionItemKind.Field:         return K.Field;
    case lsp.CompletionItemKind.Variable:      return K.Variable;
    case lsp.CompletionItemKind.Class:         return K.Class;
    case lsp.CompletionItemKind.Interface:     return K.Interface;
    case lsp.CompletionItemKind.Module:        return K.Module;
    case lsp.CompletionItemKind.Property:      return K.Property;
    case lsp.CompletionItemKind.Unit:          return K.Unit;
    case lsp.CompletionItemKind.Value:         return K.Value;
    case lsp.CompletionItemKind.Enum:          return K.Enum;
    case lsp.CompletionItemKind.Keyword:       return K.Keyword;
    case lsp.CompletionItemKind.Snippet:       return K.Snippet;
    case lsp.CompletionItemKind.Color:         return K.Color;
    case lsp.CompletionItemKind.File:          return K.File;
    case lsp.CompletionItemKind.Reference:     return K.Reference;
    case lsp.CompletionItemKind.Folder:        return K.Folder;
    case lsp.CompletionItemKind.EnumMember:    return K.EnumMember;
    case lsp.CompletionItemKind.Constant:      return K.Constant;
    case lsp.CompletionItemKind.Struct:        return K.Struct;
    case lsp.CompletionItemKind.Event:         return K.Event;
    case lsp.CompletionItemKind.Operator:      return K.Operator;
    case lsp.CompletionItemKind.TypeParameter: return K.TypeParameter;
    default:                                    return K.Text;
  }
}

function openModels(): Set<string> {
  // Tracked set of uris we've sent didOpen for.
  return (openModels as any)._set ?? ((openModels as any)._set = new Set<string>());
}

let installed = false;
const disposables: Disposable[] = [];

/** Install Monaco providers + wire diagnostics. Idempotent. */
export function installMonacoAdapter(monaco: MonacoApi): () => void {
  if (installed) return uninstallMonacoAdapter;
  installed = true;

  // ── Diagnostics (server → Monaco markers) ───────────────────────────
  const unsubDiag = lspBridge.onDiagnostics(({ uri, diagnostics }) => {
    try {
      // Match by resource path suffix rather than exact URI (we remap).
      const path = uri.replace(/^file:\/\/\/home\/epicodespace\//, '');
      const model = monaco.editor.getModels().find((m) => m.uri.path.replace(/^\//, '') === path);
      if (!model) return;
      const markers = diagnostics.map((d) => ({
        ...lspRangeToMonaco(d.range),
        message: d.message,
        severity: lspSeverityToMonaco(monaco, d.severity),
        source: d.source,
        code: typeof d.code === 'string' || typeof d.code === 'number' ? String(d.code) : undefined,
      }));
      monaco.editor.setModelMarkers(model, 'ts-lsp', markers);
    } catch (err) {
      logger.warn('lsp', 'diagnostic apply failed', err);
    }
  });
  disposables.push({ dispose: unsubDiag });

  // ── Document lifecycle (Monaco → server) ────────────────────────────
  const tracked = openModels();

  const ensureOpen = async (model: ITextModel) => {
    if (!LSP_LANGUAGES.has(model.getLanguageId())) return false;
    const conn = lspBridge.connection;
    if (!conn) return false;
    const uri = modelUri(model);
    if (tracked.has(uri)) return true;
    try {
      await conn.sendNotification(lsp.DidOpenTextDocumentNotification.type, {
        textDocument: {
          uri,
          languageId: model.getLanguageId(),
          version: model.getVersionId(),
          text: model.getValue(),
        },
      });
      tracked.add(uri);
      return true;
    } catch (err) {
      logger.warn('lsp', 'didOpen failed', err);
      return false;
    }
  };

  const closeModel = async (model: ITextModel) => {
    const conn = lspBridge.connection;
    const uri = modelUri(model);
    if (!tracked.has(uri)) return;
    tracked.delete(uri);
    if (!conn) return;
    try {
      await conn.sendNotification(lsp.DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      });
    } catch (err) {
      logger.warn('lsp', 'didClose failed', err);
    }
  };

  const onModelAdded = monaco.editor.onDidCreateModel((model) => {
    void ensureOpen(model);
    const changeSub = model.onDidChangeContent(() => {
      const conn = lspBridge.connection;
      if (!conn) return;
      if (!tracked.has(modelUri(model))) { void ensureOpen(model); return; }
      conn.sendNotification(lsp.DidChangeTextDocumentNotification.type, {
        textDocument: { uri: modelUri(model), version: model.getVersionId() },
        // Full-sync keeps things simple and iPad-cheap.
        contentChanges: [{ text: model.getValue() }],
      }).catch((err) => logger.warn('lsp', 'didChange failed', err));
    });
    const disposeSub = model.onWillDispose(() => { void closeModel(model); });
    disposables.push(changeSub, disposeSub);
  });
  disposables.push(onModelAdded);

  // Open models that already exist.
  for (const model of monaco.editor.getModels()) void ensureOpen(model);

  // When LSP reaches 'ready', re-open whatever's active.
  const unsubState = lspBridge.onState((s) => {
    if (s === 'ready') {
      // Clear tracked set — server process is fresh.
      (openModels as any)._set = new Set<string>();
      for (const model of monaco.editor.getModels()) void ensureOpen(model);
    } else if (s === 'disconnected' || s === 'error' || s === 'idle') {
      // Clear markers so stale squigglies don't linger.
      for (const model of monaco.editor.getModels()) {
        try { monaco.editor.setModelMarkers(model, 'ts-lsp', []); } catch { /* noop */ }
      }
      (openModels as any)._set = new Set<string>();
    }
  });
  disposables.push({ dispose: unsubState });

  // ── Providers (Monaco → server requests) ────────────────────────────
  const langSelector = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'];

  const completion = monaco.languages.registerCompletionItemProvider(langSelector, {
    triggerCharacters: ['.', '"', "'", '`', '/', '@', '<', '#', ' '],
    async provideCompletionItems(model, position) {
      try {
        const conn = lspBridge.connection;
        if (!conn || lspBridge.state !== 'ready') return { suggestions: [] };
        if (!(await ensureOpen(model))) return { suggestions: [] };
        const result = (await conn.sendRequest(lsp.CompletionRequest.type, {
          textDocument: { uri: modelUri(model) },
          position: posToLsp(position),
        })) as lsp.CompletionList | lsp.CompletionItem[] | null;
        if (!result) return { suggestions: [] };
        const items = Array.isArray(result) ? result : result.items;
        const word = model.getWordUntilPosition(position);
        const defaultRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const suggestions = items.map((it) => {
          const range = it.textEdit && 'range' in it.textEdit
            ? lspRangeToMonaco(it.textEdit.range)
            : defaultRange;
          const insertText = (it.textEdit && 'newText' in it.textEdit)
            ? it.textEdit.newText
            : (it.insertText ?? it.label);
          return {
            label: typeof it.label === 'string' ? it.label : it.label.label,
            kind: lspKindToMonaco(monaco, it.kind),
            insertText,
            insertTextRules: it.insertTextFormat === lsp.InsertTextFormat.Snippet
              ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
              : undefined,
            detail: it.detail,
            documentation: typeof it.documentation === 'string'
              ? it.documentation
              : it.documentation?.value,
            sortText: it.sortText,
            filterText: it.filterText,
            range,
          };
        });
        return { suggestions, incomplete: !Array.isArray(result) && result.isIncomplete };
      } catch (err) {
        logger.warn('lsp', 'completion failed', err);
        return { suggestions: [] };
      }
    },
  });
  disposables.push(completion);

  const hover = monaco.languages.registerHoverProvider(langSelector, {
    async provideHover(model, position) {
      try {
        const conn = lspBridge.connection;
        if (!conn || lspBridge.state !== 'ready') return null;
        if (!(await ensureOpen(model))) return null;
        const r = (await conn.sendRequest(lsp.HoverRequest.type, {
          textDocument: { uri: modelUri(model) },
          position: posToLsp(position),
        })) as lsp.Hover | null;
        if (!r) return null;
        const contents = Array.isArray(r.contents) ? r.contents : [r.contents];
        return {
          range: r.range ? lspRangeToMonaco(r.range) : undefined,
          contents: contents.map((c) => ({
            value: typeof c === 'string' ? c : (c as lsp.MarkupContent).value ?? (c as any).value ?? '',
          })),
        };
      } catch (err) {
        logger.warn('lsp', 'hover failed', err);
        return null;
      }
    },
  });
  disposables.push(hover);

  const signature = monaco.languages.registerSignatureHelpProvider(langSelector, {
    signatureHelpTriggerCharacters: ['(', ','],
    async provideSignatureHelp(model, position) {
      try {
        const conn = lspBridge.connection;
        if (!conn || lspBridge.state !== 'ready') return null;
        if (!(await ensureOpen(model))) return null;
        const r = (await conn.sendRequest(lsp.SignatureHelpRequest.type, {
          textDocument: { uri: modelUri(model) },
          position: posToLsp(position),
        })) as lsp.SignatureHelp | null;
        if (!r) return null;
        return {
          value: {
            signatures: r.signatures.map((s) => ({
              label: s.label,
              documentation: typeof s.documentation === 'string' ? s.documentation : s.documentation?.value,
              parameters: (s.parameters || []).map((p) => ({
                label: p.label as any,
                documentation: typeof p.documentation === 'string' ? p.documentation : p.documentation?.value,
              })),
            })),
            activeSignature: r.activeSignature ?? 0,
            activeParameter: r.activeParameter ?? 0,
          },
          dispose() { /* noop */ },
        };
      } catch (err) {
        logger.warn('lsp', 'signatureHelp failed', err);
        return null;
      }
    },
  });
  disposables.push(signature);

  const definition = monaco.languages.registerDefinitionProvider(langSelector, {
    async provideDefinition(model, position) {
      try {
        const conn = lspBridge.connection;
        if (!conn || lspBridge.state !== 'ready') return null;
        if (!(await ensureOpen(model))) return null;
        const r = (await conn.sendRequest(lsp.DefinitionRequest.type, {
          textDocument: { uri: modelUri(model) },
          position: posToLsp(position),
        })) as lsp.Location | lsp.Location[] | null;
        if (!r) return null;
        const arr = Array.isArray(r) ? r : [r];
        return arr
          .filter((loc) => loc.uri.startsWith('file:///home/epicodespace/'))
          .map((loc) => {
            const path = loc.uri.replace(/^file:\/\/\/home\/epicodespace\//, '');
            const target = monaco.editor.getModels().find((m) => m.uri.path.replace(/^\//, '') === path);
            return {
              uri: target?.uri ?? monaco.Uri.parse(loc.uri),
              range: lspRangeToMonaco(loc.range),
            };
          });
      } catch (err) {
        logger.warn('lsp', 'definition failed', err);
        return null;
      }
    },
  });
  disposables.push(definition);

  return uninstallMonacoAdapter;
}

export function uninstallMonacoAdapter() {
  if (!installed) return;
  installed = false;
  for (const d of disposables) {
    try { d.dispose(); } catch { /* noop */ }
  }
  disposables.length = 0;
}
