import React, { useState, useEffect, useRef, useMemo, useCallback, useDeferredValue, Suspense, lazy, Component } from 'react';
import {
  Folder, File, Terminal, Menu, X, Play, Cpu,
  Send, Code2, ChevronRight, Settings, Sparkles, Plus,
  Layout, GitBranch, AlertCircle, CheckCircle2, MessageSquare,
  ChevronDown, Paperclip, Loader2, GitCommit,
  Save, FilePlus, FolderOpen, Scissors, Copy, Clipboard, ClipboardPaste,
  Undo2, Redo2, Search, ZoomIn, ZoomOut,
  Bug, Square, CheckSquare, HelpCircle, BookOpen, Info,
  Zap, ListChecks, FileEdit, FileMinus, Eye,
  Wifi, WifiOff, Trash2, Globe, TerminalSquare,
  RotateCcw, ExternalLink, MonitorPlay
} from 'lucide-react';

// ─── Extracted modules (Amendment #6 — split monolith) ────────────────────────
import CodeBlock from './components/CodeBlock.jsx';
// Amendment #4 — Performance: lazy-load heavy panels only when needed.
const MarkdownContent = lazy(() => import('./components/MarkdownContent.jsx'));
const CodeEditor = lazy(() => import('./components/CodeEditor.jsx'));
const WebContainerTerminal = lazy(() => import('./components/WebContainerTerminal.jsx'));
const LspStatusBadge = lazy(() => import('./components/LspStatusBadge.jsx'));
import FileExplorer from './components/FileExplorer.jsx';
import PanelErrorBoundary from './components/ErrorBoundary.jsx';
import { useToast } from './components/Toaster.jsx';
import { logger } from './lib/logger.js';
import {
  STORAGE_KEY, CONVOS_KEY, PREFS_KEY, PANELS_KEY, AGENT_KEY, MODELS_KEY, MODE_KEY,
  loadJSON, storeJSON,
} from './lib/storage.js';
import { AGENT_REGISTRY, defaultModelFor, isValidModelFor } from './lib/agentRegistry.js';
import { AUTO_MODEL_ID, resolveAutoRoute, autoFetch } from './lib/modelRouter.ts';
import { MAX_INLINE_READ_BYTES } from './lib/fs/types.ts';
import { useFileSystem, isOpfsEnabled } from './hooks/useFileSystem.js';

/* ─── OPFS Toggle (advanced storage) ─────────────────────────────────────────
 * Tapping the toggle is a direct user gesture, which is what Safari requires
 * for `navigator.storage.persist()` to succeed. We do both in the same click
 * handler: flip the feature flag and request persistence, then ask the user
 * to reload so `useFileSystem` can boot the worker and run the migration.
 */
function OpfsToggle({ onNotify }) {
  const [on, setOn] = React.useState(() => { try { return isOpfsEnabled(); } catch { return false; } });
  const [persisted, setPersisted] = React.useState(null);

  // Best-effort read of the current persistence status for the tooltip.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await navigator.storage?.persisted?.();
        if (!cancelled) setPersisted(!!p);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleToggle = async () => {
    const next = !on;
    setOn(next);
    try {
      if (next) {
        localStorage.setItem('EPICODESPACE_USE_OPFS', '1');
        // Must run in the same turn as the click. Safari denies this when
        // invoked later (e.g. after `await`-chains with no prior gesture).
        let granted = false;
        try { granted = await navigator.storage?.persist?.() ?? false; } catch { granted = false; }
        setPersisted(granted);
        onNotify?.({
          kind: 'info',
          message: granted
            ? 'OPFS enabled + storage marked persistent. Reload to migrate your workspace.'
            : 'OPFS enabled. The browser declined to mark storage persistent — your files may be evicted under pressure. Reload to migrate.',
        });
      } else {
        localStorage.removeItem('EPICODESPACE_USE_OPFS');
        onNotify?.({ kind: 'info', message: 'OPFS disabled. Reload to return to localStorage mode.' });
      }
    } catch (err) {
      onNotify?.({ kind: 'error', message: `Toggle failed: ${err?.message || err}` });
    }
  };

  const title = on
    ? `Advanced storage ON${persisted === true ? ' · persistent' : persisted === false ? ' · not persistent' : ''} — tap to disable`
    : 'Advanced storage OFF — tap to enable OPFS + persistent storage';

  return (
    <button
      type="button"
      onClick={handleToggle}
      role="switch"
      aria-checked={on}
      aria-label="Toggle OPFS advanced storage"
      title={title}
      className={`px-2 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider transition-colors border ${
        on
          ? 'bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-500/40 hover:bg-fuchsia-500/30'
          : 'bg-transparent text-purple-400/70 border-purple-500/20 hover:bg-[#25104a] hover:text-purple-200'
      }`}
    >
      OPFS {on ? 'ON' : 'OFF'}
    </button>
  );
}

/* ─── Error Boundary ────────────────────────────────────────────────────────── */
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ background: '#0a0412', color: '#e879f9', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', fontFamily: 'monospace' }}>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>⚡ EpiCodeSpace crashed</h1>
          <pre style={{ background: '#1a0b35', padding: '1.5rem', borderRadius: '0.75rem', maxWidth: '90vw', overflow: 'auto', fontSize: '0.85rem', color: '#f87171', border: '1px solid rgba(232,121,249,0.3)' }}>{this.state.error?.message}\n{this.state.error?.stack}</pre>
          <button onClick={() => { try { localStorage.clear(); } catch {} this.setState({ error: null }); window.location.reload(); }} style={{ marginTop: '1.5rem', padding: '0.75rem 2rem', background: '#a21caf', color: 'white', border: 'none', borderRadius: '0.5rem', cursor: 'pointer', fontSize: '0.9rem' }}>Clear Data &amp; Reload</button>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: '0.75rem', padding: '0.5rem 1.5rem', background: 'transparent', color: '#c084fc', border: '1px solid #c084fc', borderRadius: '0.5rem', cursor: 'pointer', fontSize: '0.85rem' }}>Try Again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ─── Agent Tools (function calling) ─────────────────────────────────────── */
function createAgentTools(fileSystem, activeFile) {
  return {
    readFile: {
      name: 'readFile',
      description: 'Read file contents',
      execute: (path) => {
        const f = fileSystem[path];
        return f ? { ok: true, content: f.content, language: f.language } : { ok: false, error: `File '${path}' not found` };
      },
    },
    listFiles: {
      name: 'listFiles',
      description: 'List all files in workspace',
      execute: () => ({ ok: true, files: Object.keys(fileSystem) }),
    },
    searchCode: {
      name: 'searchCode',
      description: 'Search for pattern across all files',
      execute: (pattern) => {
        const results = [];
        Object.entries(fileSystem).forEach(([path, f]) => {
          (f.content ?? '').split('\n').forEach((line, i) => {
            if (line.toLowerCase().includes(pattern.toLowerCase())) {
              results.push({ file: path, line: i + 1, text: line.trim() });
            }
          });
        });
        return { ok: true, matches: results.length, results: results.slice(0, 15) };
      },
    },
    analyzeFile: {
      name: 'analyzeFile',
      description: 'Static analysis and debug of a file',
      execute: (path) => {
        const f = fileSystem[path || activeFile];
        if (!f) return { ok: false, error: 'File not found' };
        const lines = (f.content ?? '').split('\n');
        const issues = [];
        const lang = f.language || 'text';

        lines.forEach((line, i) => {
          const n = i + 1;
          const t = line.trim();

          // ── Code quality ──────────────────────────────────────────
          if (/console\.(log|warn|error|info|debug)/.test(t))
            issues.push({ line: n, type: 'warning', category: 'quality', msg: 'Console statement left in code' });
          if (/==(?!=)/.test(t) && !/==>|!==/.test(t))
            issues.push({ line: n, type: 'warning', category: 'quality', msg: 'Loose equality (==) — use ===' });
          if (/\bvar\b/.test(t))
            issues.push({ line: n, type: 'warning', category: 'quality', msg: 'var declaration — use const or let' });
          if (/\bdebugger\b/.test(t))
            issues.push({ line: n, type: 'error', category: 'debug', msg: 'debugger statement — remove before shipping' });
          if (/TODO|FIXME|HACK|XXX/.test(t))
            issues.push({ line: n, type: 'info', category: 'quality', msg: `Marker: ${t.match(/TODO|FIXME|HACK|XXX/)[0]}` });

          // ── Async / Promise bugs ──────────────────────────────────
          if (/\.then\(|\.catch\(|new Promise/.test(t) && !/await/.test(t) && /async/.test(lines.slice(Math.max(0, i-5), i).join('')))
            issues.push({ line: n, type: 'info', category: 'async', msg: '.then()/.catch() inside async fn — consider await instead' });
          if (/async\s+\w+.*=>/.test(t) && !/catch|try/.test(lines.slice(i, i + 10).join('')))
            issues.push({ line: n, type: 'warning', category: 'async', msg: 'Async arrow fn without error handling (try/catch)' });
          if (/await\s+\w+/.test(t) && !/try/.test(lines.slice(Math.max(0, i-3), i).join('')) && !/\.catch/.test(lines.slice(i, i+3).join('')))
            issues.push({ line: n, type: 'info', category: 'async', msg: 'await without surrounding try/catch' });
          if (/Promise\.all\(/.test(t) && !/catch|try/.test(lines.slice(i, i+5).join('')))
            issues.push({ line: n, type: 'warning', category: 'async', msg: 'Promise.all() without .catch() — one rejection will silently swallow others' });

          // ── React-specific ────────────────────────────────────────
          if (/useEffect\s*\(/.test(t) && !/\[\s*\]/.test(lines.slice(i, i + 6).join('')))
            issues.push({ line: n, type: 'warning', category: 'react', msg: 'useEffect with no dependency array — runs on every render' });
          if (/setState.*setState/.test(t) || (/set[A-Z]\w+\(/.test(t) && (t.match(/set[A-Z]\w+\(/g) || []).length > 1))
            issues.push({ line: n, type: 'info', category: 'react', msg: 'Multiple setState calls on one line — consider batching' });
          if (/\.map\([^)]+\)(?!\s*\.\w)/.test(t) && !/key=/.test(lines.slice(i, i+3).join('')))
            issues.push({ line: n, type: 'warning', category: 'react', msg: '.map() rendering without key prop detected nearby' });
          if (/dangerouslySetInnerHTML/.test(t))
            issues.push({ line: n, type: 'error', category: 'security', msg: 'dangerouslySetInnerHTML — XSS risk. Sanitize input or use textContent' });

          // ── Null / undefined safety ───────────────────────────────
          if (/\w+\.\w+\.\w+/.test(t) && !/\?\./.test(t) && !/typeof/.test(t))
            issues.push({ line: n, type: 'info', category: 'safety', msg: 'Deep property access without optional chaining (?.)' });
          if (/catch\s*\(\s*\)\s*\{/.test(t) || /catch\s*\(\w+\)\s*\{\s*\}/.test(t))
            issues.push({ line: n, type: 'warning', category: 'safety', msg: 'Empty catch block — errors silently swallowed' });

          // ── Security ──────────────────────────────────────────────
          if (/eval\(/.test(t))
            issues.push({ line: n, type: 'error', category: 'security', msg: 'eval() is dangerous and disallowed by CSP' });
          if (/innerHTML\s*=/.test(t) && !/sanitize/.test(t))
            issues.push({ line: n, type: 'error', category: 'security', msg: 'innerHTML assignment — XSS risk. Use textContent or sanitizer' });
          if (/localStorage\.(setItem|getItem)/.test(t) && /password|token|secret|key/i.test(t))
            issues.push({ line: n, type: 'error', category: 'security', msg: 'Sensitive data stored in localStorage — use secure httpOnly cookies' });

          // ── Performance ───────────────────────────────────────────
          if (/JSON\.parse\(JSON\.stringify/.test(t))
            issues.push({ line: n, type: 'info', category: 'perf', msg: 'JSON deep clone is slow — use structuredClone() instead' });
          if (/setTimeout\(.*0\)/.test(t))
            issues.push({ line: n, type: 'info', category: 'perf', msg: 'setTimeout(fn, 0) — consider queueMicrotask or requestAnimationFrame' });
        });

        // ── Stack trace / error paste detector ────────────────────
        const content = f.content ?? '';
        const stackPatterns = [
          { re: /TypeError:\s.+/, label: 'TypeError' },
          { re: /ReferenceError:\s.+/, label: 'ReferenceError' },
          { re: /SyntaxError:\s.+/, label: 'SyntaxError' },
          { re: /RangeError:\s.+/, label: 'RangeError' },
          { re: /Uncaught\s+\w+Error:\s.+/, label: 'Uncaught Error' },
          { re: /at\s+\w+\s+\(.+:\d+:\d+\)/, label: 'Stack frame' },
          { re: /Error:\s+Cannot\s+(read|set)\s+propert/, label: 'Cannot read/set property' },
          { re: /Module not found:\s.+/, label: 'Module not found' },
          { re: /Failed to fetch|NetworkError|CORS/, label: 'Network/CORS error' },
        ];
        stackPatterns.forEach(({ re, label }) => {
          const m = content.match(re);
          if (m) issues.push({ line: 1, type: 'error', category: 'runtime', msg: `${label}: ${m[0].slice(0, 80)}` });
        });

        const byCategory = issues.reduce((acc, i) => { (acc[i.category] = acc[i.category] || []).push(i); return acc; }, {});

        return {
          ok: true,
          file: path || activeFile,
          language: lang,
          lines: lines.length,
          chars: content.length,
          issueCount: issues.length,
          issues,
          summary: Object.entries(byCategory).map(([cat, arr]) => `${cat}: ${arr.length}`).join(', ') || 'No issues',
        };
      },
    },
    getContext: {
      name: 'getContext',
      description: 'Get current workspace context',
      execute: () => ({
        ok: true,
        activeFile,
        totalFiles: Object.keys(fileSystem).length,
        files: Object.entries(fileSystem).map(([p, f]) => ({
          path: p, language: f.language, lines: (f.content ?? '').split('\n').length,
        })),
      }),
    },
  };
}

/* ─── Agent Response Engine ──────────────────────────────────────────────── */
function buildAgentResponse(agentId, query, tools, fileSystem, activeFile) {
  const q = query.toLowerCase();
  const ctx = tools.getContext.execute();
  const activeContent = fileSystem[activeFile]?.content || '';
  const activeLines = activeContent.split('\n').length;

  // Detect intent from query
  const intents = {
    explain: /explain|what does|how does|what is|walk me through|describe/i.test(q),
    refactor: /refactor|improve|clean up|optimize|simplify|better way/i.test(q),
    debug: /debug|fix|error|bug|issue|wrong|broken|not working|crash/i.test(q),
    generate: /generate|create|write|add|implement|build|make a|scaffold/i.test(q),
    review: /review|audit|check|scan|analyze|look at|assess/i.test(q),
    test: /test|spec|unit test|coverage|testing/i.test(q),
    search: /find|search|where|locate|grep|which file/i.test(q),
    docs: /document|docstring|jsdoc|comment|readme/i.test(q),
    architecture: /architect|design|pattern|structure|organize|plan/i.test(q),
  };

  const agent = AGENT_REGISTRY[agentId];
  const toolCalls = [];
  const steps = [];

  // --- Tool invocations based on intent ---
  if (intents.search) {
    const words = q.split(/\s+/).filter(w => w.length > 3 && !['find', 'search', 'where', 'which', 'file', 'locate', 'does', 'the'].includes(w));
    const pattern = words[words.length - 1] || 'function';
    const result = tools.searchCode.execute(pattern);
    toolCalls.push({ tool: 'searchCode', args: pattern, result });
    if (result.matches > 0) {
      steps.push(`🔍 **searchCode**("${pattern}") → ${result.matches} match(es)`);
      const matchList = result.results.slice(0, 8).map(r => `  \`${r.file}:${r.line}\` → ${r.text}`).join('\n');
      return { steps, toolCalls, response: `Found **${result.matches}** occurrences of "${pattern}":\n\n${matchList}${result.matches > 8 ? `\n  _...and ${result.matches - 8} more_` : ''}` };
    }
    steps.push(`🔍 **searchCode**("${pattern}") → 0 matches`);
    return { steps, toolCalls, response: `No matches for "${pattern}" across ${ctx.totalFiles} files.` };
  }

  if (intents.review || intents.debug) {
    const analysis = tools.analyzeFile.execute(activeFile);
    toolCalls.push({ tool: 'analyzeFile', args: activeFile, result: analysis });
    steps.push(`🔬 **analyzeFile**(${activeFile}) → ${analysis.issueCount ?? analysis.issues?.length ?? 0} issue(s) [${analysis.summary || ''}]`);
    if (analysis.ok && analysis.issues?.length > 0) {
      const categoryIcon = { quality: '🔧', async: '⚡', react: '⚛️', safety: '🛡️', security: '🔒', perf: '🚀', runtime: '💥', debug: '🐛' };
      const issueList = analysis.issues.slice(0, 15).map(i =>
        `  ${i.type === 'error' ? '🔴' : i.type === 'warning' ? '🟡' : 'ℹ️'} ${categoryIcon[i.category] || ''} Line ${i.line}: ${i.msg}`
      ).join('\n');
      const extras = analysis.issues.length > 15 ? `\n  _...and ${analysis.issues.length - 15} more_` : '';
      const advice = agentId === 'claude'
        ? `\n\n**Recommendation:** Address 🔴 errors first (security, runtime, debugger). Then 🟡 warnings. I'd fix async error handling and null safety before refactoring style issues.`
        : agentId === 'copilot'
        ? `\n\n**Quick fix available.** I can auto-fix ${analysis.issues.filter(i => i.type === 'warning').length} warning(s) and ${analysis.issues.filter(i => i.type === 'error').length} error(s). Want me to apply?`
        : agentId === 'deepseek'
        ? `\n\n**Auto-fix ready:** \`var→const\`, \`==→===\`, add optional chaining, wrap awaits in try/catch, strip console statements. Confirm to proceed.`
        : `\n\nI can fix these automatically or walk you through each one. What would you prefer?`;
      return { steps, toolCalls, response: `**Debug Analysis:** \`${activeFile}\` (${analysis.lines} lines, ${analysis.language})\n**Summary:** ${analysis.summary}\n\n${issueList}${extras}${advice}` };
    }
    steps.push(`✅ No issues found in \`${activeFile}\``);
  }

  if (intents.explain) {
    const file = tools.readFile.execute(activeFile);
    toolCalls.push({ tool: 'readFile', args: activeFile, result: { ok: true, lines: activeLines } });
    steps.push(`📖 **readFile**(${activeFile}) → ${activeLines} lines`);
    const lang = fileSystem[activeFile]?.language || 'text';
    const explanations = {
      'epicode-agent': `**\`${activeFile}\`** (${lang}, ${activeLines} lines)\n\nThis file ${lang === 'markdown' ? 'documents project configuration and business logic. Key sections cover the tech stack (Vercel, Firebase, Modal), subscription tiers, and credit system.' : lang === 'css' ? 'defines the base styles using Tailwind CSS directives and custom properties.' : `defines a ${lang === 'typescript' ? 'TypeScript' : 'JavaScript'} module. It exports ${activeContent.includes('export default') ? 'a default component/function' : 'named exports'} and contains ${activeLines} lines of logic.`}\n\nWant me to break down any specific section?`,
      'copilot': `Here's a breakdown of \`${activeFile}\`:\n\n• **Language:** ${lang}\n• **Lines:** ${activeLines}\n• **Exports:** ${activeContent.match(/export/g)?.length || 0}\n• **Imports:** ${activeContent.match(/import/g)?.length || 0}\n\n${activeContent.includes('useState') ? 'This is a **stateful React component** using hooks.' : activeContent.includes('function') ? 'Contains **function declarations** — looks like a utility module.' : 'This appears to be a **configuration/content** file.'}\n\nI can generate inline comments or a JSDoc summary. Just say the word.`,
      'claude': `Let me walk through \`${activeFile}\` systematically.\n\n**Structure:** ${activeLines} lines of ${lang}. ${activeContent.includes('import') ? `The file imports ${(activeContent.match(/import/g) || []).length} dependencies, ` : ''}${activeContent.includes('export') ? `exports ${(activeContent.match(/export/g) || []).length} symbol(s).` : 'no exports detected.'}\n\n**Purpose:** ${lang === 'markdown' ? 'This is a project specification document outlining the tech stack, business model, and deployment architecture.' : `This ${lang} module ${activeContent.includes('return') ? 'renders UI or returns computed values' : 'defines data structures or utilities'}.`}\n\n**Key observation:** ${activeContent.length > 2000 ? 'This file is fairly large — consider breaking it into smaller modules if complexity grows.' : 'File size is manageable. Good modularity.'}\n\nWould you like me to analyze the control flow or data dependencies?`,
      'gemini': `**Analysis of \`${activeFile}\`:**\n\n📊 **Metrics:** ${activeLines} lines | ${activeContent.length} chars | ${lang}\n\nThis file ${activeContent.includes('React') ? 'is a React component' : activeContent.includes('function') ? 'contains utility functions' : 'holds configuration data'}. ${activeContent.includes('async') ? 'It uses async patterns — ensure proper error handling.' : ''}\n\n${lang === 'markdown' ? 'The markdown outlines a SaaS architecture with Vercel + Firebase + Modal + Stripe.' : `The main logic ${activeContent.includes('useState') ? 'is stateful (React hooks detected)' : 'is stateless'}.`}`,
      'deepseek': `\`\`\`analysis\nFile: ${activeFile}\nLang: ${lang}\nLines: ${activeLines}\nSize: ${activeContent.length} bytes\nImports: ${(activeContent.match(/import/g) || []).length}\nExports: ${(activeContent.match(/export/g) || []).length}\nFunctions: ${(activeContent.match(/function\s/g) || []).length}\nArrow fns: ${(activeContent.match(/=>/g) || []).length}\n\`\`\`\n\n${activeContent.includes('useState') ? 'Detected React hooks pattern. State variables found: ' + (activeContent.match(/useState/g) || []).length : 'No React hooks detected.'}\n\nShall I generate type annotations or refactor suggestions?`,
    };
    return { steps, toolCalls, response: explanations[agentId] || explanations['epicode-agent'] };
  }

  if (intents.generate || intents.test) {
    const ctxResult = tools.getContext.execute();
    toolCalls.push({ tool: 'getContext', result: ctxResult });
    steps.push(`📋 **getContext**() → ${ctxResult.totalFiles} files`);
    if (intents.test) {
      const testCode = `import { describe, it, expect } from 'vitest';\n\ndescribe('${activeFile}', () => {\n  it('should exist and be importable', () => {\n    expect(true).toBe(true);\n  });\n\n  it('should render without crashing', () => {\n    // TODO: Add component render test\n    expect(true).toBeTruthy();\n  });\n\n  it('should handle edge cases', () => {\n    // TODO: Add edge case tests\n  });\n});`;
      return { steps, toolCalls, response: `Here's a test scaffold for \`${activeFile}\`:\n\n\`\`\`javascript\n${testCode}\n\`\`\`\n\nI've generated 3 test cases. Want me to write this to \`${activeFile.replace(/\.(jsx?|tsx?)$/, '.test$&')}\`?` };
    }
    const generators = {
      'epicode-agent': `Based on your workspace (${ctxResult.totalFiles} files), here's what I'd generate:\n\n\`\`\`javascript\n// Generated by EpiCode Agent\nexport function ${q.match(/(?:create|make|build|add|write)\s+(?:a\s+)?(\w+)/i)?.[1] || 'newModule'}() {\n  // TODO: Implement\n  return null;\n}\n\`\`\`\n\nShall I expand this with full implementation based on your project context?`,
      'copilot': `**Copilot suggestion:**\n\n\`\`\`javascript\n// ✨ Generated from context of ${ctxResult.totalFiles} workspace files\nconst ${q.match(/(?:create|make|build|add|write)\s+(?:a\s+)?(\w+)/i)?.[1] || 'handler'} = async (params) => {\n  try {\n    const result = await processRequest(params);\n    return { success: true, data: result };\n  } catch (error) {\n    console.error('Operation failed:', error);\n    return { success: false, error: error.message };\n  }\n};\n\`\`\`\n\nTab to accept, or ask me to refine.`,
      'claude': `Let me think about the best approach.\n\n**Design considerations:**\n1. Error handling at boundaries\n2. Type safety\n3. Testability\n\n\`\`\`typescript\ninterface ${(q.match(/(?:create|make|build|add|write)\s+(?:a\s+)?(\w+)/i)?.[1] || 'Module')}Config {\n  // Define your options here\n  enabled: boolean;\n  retries?: number;\n}\n\nexport function create${(q.match(/(?:create|make|build|add|write)\s+(?:a\s+)?(\w+)/i)?.[1] || 'Module')}(config: ${(q.match(/(?:create|make|build|add|write)\s+(?:a\s+)?(\w+)/i)?.[1] || 'Module')}Config) {\n  if (!config.enabled) return null;\n  // Implementation here\n}\n\`\`\`\n\nThis follows the factory pattern. Want me to flesh out the implementation?`,
      'deepseek': `\`\`\`javascript\n/**\n * Auto-generated by DeepSeek Coder V2\n * Context: ${ctxResult.totalFiles} files in workspace\n */\nexport default function ${q.match(/(?:create|make|build|add|write)\s+(?:a\s+)?(\w+)/i)?.[1] || 'generated'}(input) {\n  // Type: ${typeof input === 'string' ? 'string' : 'unknown'}\n  const processed = input;\n  return processed;\n}\n\`\`\`\n\nCompact and ready. Need types or tests?`,
      'gemini': `**Here's my approach:**\n\n1. First, I'll scaffold the structure\n2. Then wire it into your existing modules\n\n\`\`\`javascript\n// 🌟 Gemini-generated scaffold\nimport React from 'react';\n\nexport default function ${q.match(/(?:create|make|build|add|write)\s+(?:a\s+)?(\w+)/i)?.[1] || 'NewComponent'}({ data }) {\n  return (\n    <div className="p-4">\n      <h2>{data?.title || 'New Component'}</h2>\n      {/* Add your content here */}\n    </div>\n  );\n}\n\`\`\`\n\nThis integrates with your Tailwind setup. Want me to add state management?`,
    };
    return { steps, toolCalls, response: generators[agentId] || generators['epicode-agent'] };
  }

  if (intents.refactor) {
    const analysis = tools.analyzeFile.execute(activeFile);
    toolCalls.push({ tool: 'analyzeFile', args: activeFile, result: analysis });
    steps.push(`🔬 **analyzeFile**(${activeFile}) → ${analysis.lines} lines, ${analysis.issues?.length || 0} issues`);
    return { steps, toolCalls, response: `**Refactoring plan for \`${activeFile}\`:**\n\n1. ${analysis.issues?.some(i => i.msg.includes('var')) ? '✅ Convert `var` → `const`/`let`' : '◻️ Variables already use modern declarations'}\n2. ${analysis.issues?.some(i => i.msg.includes('equality')) ? '✅ Fix loose equality `==` → `===`' : '◻️ Strict equality in use'}\n3. ${analysis.issues?.some(i => i.msg.includes('Console')) ? '✅ Remove console statements' : '◻️ No console statements'}\n4. ${analysis.lines > 100 ? '✅ Consider extracting functions (file is ' + analysis.lines + ' lines)' : '◻️ File length is fine'}\n5. ${activeContent.includes('any') ? '✅ Replace `any` types with proper interfaces' : '◻️ No `any` types detected'}\n\nWant me to apply these changes now?` };
  }

  if (intents.architecture) {
    const ctxResult = tools.getContext.execute();
    toolCalls.push({ tool: 'getContext', result: ctxResult });
    steps.push(`📋 **getContext**() → ${ctxResult.totalFiles} files`);
    const fileBreakdown = ctxResult.files.map(f => `  \`${f.path}\` (${f.language}, ${f.lines} lines)`).join('\n');
    return { steps, toolCalls, response: `**Workspace Architecture Overview:**\n\n📁 **${ctxResult.totalFiles} files:**\n${fileBreakdown}\n\n**Observations:**\n• ${ctxResult.files.some(f => f.language === 'typescript') ? 'TypeScript is in use — good for type safety' : 'Consider adding TypeScript for better DX'}\n• ${ctxResult.files.some(f => f.path.includes('hooks/')) ? 'Custom hooks pattern detected — well-organized' : 'Consider extracting reusable logic into hooks'}\n• Total codebase: ~${ctxResult.files.reduce((a, f) => a + f.lines, 0)} lines\n\nWant me to suggest a restructuring plan?` };
  }

  // Fallback: general conversation with context awareness
  const ctxResult = tools.getContext.execute();
  toolCalls.push({ tool: 'getContext', result: ctxResult });
  steps.push(`📋 **getContext**() → ${ctxResult.totalFiles} files, active: ${activeFile}`);

  const fallbacks = {
    'epicode-agent': `I've reviewed your workspace (${ctxResult.totalFiles} files, active: \`${activeFile}\`). Regarding "${query}":\n\nI can help with that. Here's what I'd suggest:\n\n1. Let me scan the relevant files for context\n2. I'll draft the implementation\n3. You review and I'll apply\n\nWant me to start with a specific file, or should I work across the whole project?`,
    'copilot': `**Copilot** — Working from \`${activeFile}\` (${activeLines} lines)\n\nI understand you want to: "${query}"\n\nBased on the project context (${ctxResult.totalFiles} files), I can:\n• Generate code inline\n• Suggest completions\n• Write tests\n\nRefine your ask and I'll produce code directly.`,
    'claude': `Let me think about this carefully.\n\n**Context:** ${ctxResult.totalFiles} files in workspace. Currently editing \`${activeFile}\` (${activeLines} lines, ${fileSystem[activeFile]?.language}).\n\n**On "${query}":** This is a nuanced question. The approach depends on your constraints — performance requirements, maintainability goals, and whether this is user-facing. Could you clarify which aspect matters most? I'll tailor my response accordingly.`,
    'gemini': `**Gemini 2.5 Pro** analyzing your request...\n\n📊 Workspace: ${ctxResult.totalFiles} files | Active: \`${activeFile}\`\n\nFor "${query}", I recommend a multi-step approach:\n\n**Step 1:** Audit current implementation\n**Step 2:** Identify optimization targets\n**Step 3:** Apply changes incrementally\n\nShall I begin with Step 1?`,
    'deepseek': `\`\`\`context\nWorkspace: ${ctxResult.totalFiles} files\nActive: ${activeFile} (${activeLines} lines)\nQuery: "${query}"\n\`\`\`\n\nReady to execute. Specify:\n- \`/gen\` — generate code\n- \`/fix\` — debug & patch\n- \`/refactor\` — clean & optimize\n- \`/test\` — scaffold tests\n\nOr just describe what you need in plain English.`,
  };
  return { steps, toolCalls, response: fallbacks[agentId] || fallbacks['epicode-agent'] };
}

/* ─── ThinkingBlock — GitHub Copilot-style collapsible reasoning panel ──────── */
function ThinkingBlock({ steps = [], toolCalls = [], inProgress = false, mode }) {
  const [open, setOpen] = React.useState(inProgress); // auto-open while running

  // Re-open if we get new steps while running
  React.useEffect(() => { if (inProgress) setOpen(true); }, [inProgress, steps.length]);

  if (steps.length === 0 && toolCalls.length === 0) return null;

  // Categorise each step string
  const parsedSteps = steps.map(s => {
    const isThought  = s.startsWith('💭');
    const isWarning  = s.startsWith('⚠️');
    const emoji      = s.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/u)?.[0] ?? '•';
    const text       = s.replace(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)\s*/u, '').trim();
    return { emoji, text, isThought, isWarning };
  });

  const writeCount   = toolCalls.filter(tc => tc.tool === 'writeFile' || tc.tool === 'editFile').length;
  const readCount    = toolCalls.filter(tc => tc.tool === 'readFile').length;
  const searchCount  = toolCalls.filter(tc => tc.tool === 'searchCode').length;
  const cmdCount     = toolCalls.filter(tc => tc.tool === 'runCommand').length;

  const summaryParts = [];
  if (writeCount)  summaryParts.push(`${writeCount} file${writeCount > 1 ? 's' : ''} written`);
  if (readCount)   summaryParts.push(`${readCount} read`);
  if (searchCount) summaryParts.push(`${searchCount} search${searchCount > 1 ? 'es' : ''}`);
  if (cmdCount)    summaryParts.push(`${cmdCount} command${cmdCount > 1 ? 's' : ''}`);
  const summary = summaryParts.join(' · ') || `${steps.length} step${steps.length !== 1 ? 's' : ''}`;

  return (
    <div className="mb-2 rounded-lg border border-fuchsia-500/20 bg-[#0d0520] overflow-hidden">
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition-colors text-left"
      >
        {inProgress
          ? <Loader2 size={12} className="text-fuchsia-400 animate-spin shrink-0" />
          : <CheckCircle2 size={12} className="text-green-500/70 shrink-0" />}
        <span className={`text-[11px] font-semibold ${inProgress ? 'text-fuchsia-300' : 'text-purple-300/80'}`}>
          {inProgress ? 'Thinking…' : 'Thought process'}
        </span>
        {!inProgress && (
          <span className="text-[10px] text-purple-500/50 ml-1">{summary}</span>
        )}
        {mode && !inProgress && (
          <span className="ml-auto text-[9px] bg-fuchsia-500/10 text-fuchsia-400/60 px-1.5 py-0.5 rounded-full border border-fuchsia-500/20 shrink-0">{mode}</span>
        )}
        <ChevronRight
          size={12}
          className={`ml-auto shrink-0 text-purple-500/40 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          style={{ marginLeft: mode && !inProgress ? '0.25rem' : 'auto' }}
        />
      </button>

      {/* Expandable body */}
      {open && (
        <div className="border-t border-fuchsia-500/10 px-3 py-2 space-y-1.5">
          {parsedSteps.map((s, i) => (
            <div key={i} className={`flex items-start gap-2 ${s.isThought ? 'py-1.5 px-2 rounded-md bg-purple-500/5 border-l-2 border-fuchsia-500/30' : ''}`}>
              <span className="text-[12px] shrink-0 mt-0.5">{s.emoji}</span>
              <span
                className={`text-[11px] leading-snug ${s.isThought ? 'text-purple-200/80 italic' : s.isWarning ? 'text-amber-400/80' : 'text-purple-400/70'}`}
                dangerouslySetInnerHTML={{ __html: s.text.replace(/\*\*(.*?)\*\*/g, '<strong class="text-purple-200/90 not-italic">$1</strong>').replace(/`([^`]+)`/g, '<code class="text-fuchsia-300/80 bg-fuchsia-500/10 px-1 rounded text-[10px] not-italic">$1</code>') }}
              />
            </div>
          ))}
          {/* Tool calls detail */}
          {toolCalls.length > 0 && (
            <div className="pt-1.5 mt-1.5 border-t border-white/5 flex flex-wrap gap-1">
              {toolCalls.map((tc, ti) => {
                const isWrite = tc.tool === 'writeFile' || tc.tool === 'editFile';
                const isDel   = tc.tool === 'deleteFile';
                const isSrch  = tc.tool === 'searchCode';
                const isCmd   = tc.tool === 'runCommand';
                const label   = tc.args?.path
                  ? tc.args.path.split('/').pop()
                  : tc.args?.command ? tc.args.command.slice(0, 28)
                  : tc.args?.pattern ? `"${tc.args.pattern}"` : '';
                const icon = tc.tool === 'writeFile' ? '📝'
                  : tc.tool === 'editFile' ? '✏️'
                  : tc.tool === 'deleteFile' ? '🗑️'
                  : tc.tool === 'readFile' ? '📖'
                  : tc.tool === 'runCommand' ? '💻'
                  : tc.tool === 'searchCode' ? '🔍'
                  : '📋';
                return (
                  <span
                    key={ti}
                    title={`${tc.tool}(${tc.args?.path || tc.args?.command || ''})`}
                    className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md font-mono border ${
                      isWrite ? 'bg-emerald-500/10 text-emerald-400/80 border-emerald-500/20'
                      : isDel  ? 'bg-red-500/10 text-red-400/70 border-red-500/20'
                      : isSrch ? 'bg-amber-500/10 text-amber-400/70 border-amber-500/20'
                      : isCmd  ? 'bg-sky-500/10 text-sky-400/70 border-sky-500/20'
                      : 'bg-white/5 text-purple-400/50 border-white/10'
                    }`}
                  >
                    {icon} {label || tc.tool}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── New Project Dialog ────────────────────────────────────────────────────── */
const NEW_PROJECT_TEMPLATES = [
  { id: 'react', label: '⚛️ React',        desc: 'Vite + React 18' },
  { id: 'node',  label: '🟢 Node.js',      desc: 'HTTP server' },
  { id: 'html',  label: '🌐 HTML/CSS/JS',  desc: 'Vanilla web' },
  { id: 'empty', label: '📄 Empty',        desc: 'Blank workspace' },
];

function NewProjectDialog({ initialTemplate = 'react', onConfirm, onCancel }) {
  const [name, setName]         = React.useState('');
  const [template, setTemplate] = React.useState(initialTemplate);
  const inputRef = React.useRef(null);

  React.useEffect(() => { inputRef.current?.focus(); }, []);

  const placeholder = template === 'empty' ? 'my-project' : `my-${template}-app`;

  const confirm = () => {
    const resolved = name.trim() || placeholder;
    onConfirm(template, resolved);
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-project-title"
    >
      <div
        className="bg-[#15092a] border border-fuchsia-500/30 rounded-xl shadow-[0_0_40px_rgba(192,38,211,0.25)] p-6 w-full max-w-sm"
        onClick={e => e.stopPropagation()}
      >
        <h2 id="new-project-title" className="text-purple-100 font-semibold text-base mb-5">New Project</h2>

        {/* Name */}
        <label className="text-xs text-purple-400 block mb-1">Project name</label>
        <input
          ref={inputRef}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-purple-100 placeholder-purple-500/40 focus:outline-none focus:ring-1 focus:ring-fuchsia-500/50 mb-5"
          onKeyDown={e => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') onCancel(); }}
        />

        {/* Template picker */}
        <div className="text-xs text-purple-400 mb-2">Template</div>
        <div className="grid grid-cols-2 gap-2 mb-6">
          {NEW_PROJECT_TEMPLATES.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTemplate(t.id)}
              className={`rounded-lg px-3 py-2 text-left border transition-colors ${
                template === t.id
                  ? 'bg-fuchsia-500/20 border-fuchsia-500/50 text-fuchsia-200'
                  : 'bg-white/5 border-white/10 text-purple-300 hover:bg-white/10 hover:text-purple-100'
              }`}
            >
              <div className="text-[12px] font-medium">{t.label}</div>
              <div className="text-[10px] text-purple-500/70 mt-0.5">{t.desc}</div>
            </button>
          ))}
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2 rounded-lg text-sm border border-white/10 text-purple-400 hover:bg-white/5 transition-colors"
          >Cancel</button>
          <button
            type="button"
            onClick={confirm}
            className="flex-1 py-2 rounded-lg text-sm bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-medium transition-colors"
          >Create</button>
        </div>
      </div>
    </div>
  );
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function toolCallSignature(name, args) {
  return `${name}:${stableStringify(args ?? {})}`;
}

const IMAGE_MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

const IMAGE_EXT_TO_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

function fileExt(name) {
  const idx = (name || '').lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function isImageFile(file) {
  if (!file) return false;
  if (typeof file.type === 'string' && file.type.startsWith('image/')) return true;
  const ext = fileExt(file.name);
  return !!IMAGE_EXT_TO_MIME[ext];
}

function imageExtFromFile(file) {
  if (file?.type && IMAGE_MIME_TO_EXT[file.type]) return IMAGE_MIME_TO_EXT[file.type];
  const ext = fileExt(file?.name);
  if (IMAGE_EXT_TO_MIME[ext]) return ext === 'jpeg' ? 'jpg' : ext;
  return 'png';
}

function imageMimeFromFile(file) {
  if (file?.type && file.type.startsWith('image/')) return file.type;
  const ext = fileExt(file?.name);
  return IMAGE_EXT_TO_MIME[ext] || 'image/png';
}

function sanitizeFileName(name, fallback = 'image') {
  const safe = (name || fallback)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe || fallback;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/** Resize an image file to ≤ maxDim px on the longest side, export as JPEG 0.8. */
function resizeImageToDataUrl(file, maxDim = 1024) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.onload = () => {
        const { naturalWidth: w, naturalHeight: h } = img;
        const scale = (w > maxDim || h > maxDim) ? maxDim / Math.max(w, h) : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function arrayBufferFromFile(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

function extractImageFileFromDataTransfer(dt) {
  if (!dt) return null;
  const fromItems = Array.from(dt.items || []).find((item) => item.kind === 'file' && (item.type?.startsWith('image/') || isImageFile(item.getAsFile?.())));
  if (fromItems) return fromItems.getAsFile();
  const fromFiles = Array.from(dt.files || []).find((file) => isImageFile(file));
  return fromFiles || null;
}

function toModelUserContent(text, image, agentId) {
  if (!image) return text;
  const safeText = text || 'Describe this image.';
  if (agentId === 'claude') {
    return [
      { type: 'text', text: safeText },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mime,
          data: image.base64,
        },
      },
    ];
  }
  if (agentId === 'epicode-agent' || agentId === 'copilot') {
    return [
      { type: 'text', text: safeText },
      { type: 'image_url', image_url: { url: image.dataUrl } },
    ];
  }
  return safeText;
}

/* ─── Main Component ────────────────────────────────────────────────────────── */
function EpiCodeSpaceApp() {
  // ── Observability (Amendment #6) ──────────────────────────────────────────
  const toast = useToast();

  // ── File system (OPFS-aware hook) ─────────────────────────────────────────
  const {
    fileSystem,
    mode: fsMode,            // 'memory' | 'opfs-pending' | 'opfs'
    isReady: fsReady,
    initError: fsInitError,
    getLatest,
    replaceAll,
    writeFile,
    writeBinaryFile,
    patchFile,
    renameFile: hookRenameFile,
    deleteFile: hookDeleteFile,
    onMutation,
  } = useFileSystem();
  const [projectName, setProjectName] = useState(() => loadJSON('epicodespace_project_v1', 'My Project'));
  const firstFile = Object.keys(fileSystem)[0] || null;
  const [activeFile, setActiveFile] = useState(firstFile);
  const [openTabs, setOpenTabs] = useState(firstFile ? [firstFile] : []);
  const [untitledCount, setUntitledCount] = useState(1);
  const [renamingFile, setRenamingFile] = useState(null);
  const [newProjectDialog, setNewProjectDialog] = useState(null); // null | { template: string }
  const [renameValue, setRenameValue] = useState('');

  // ── Panels ────────────────────────────────────────────────────────────────
  const savedPanels = loadJSON(PANELS_KEY, { sidebarOpen: true, rightSidebarOpen: true, terminalState: 'open' });
  const [sidebarOpen, setSidebarOpen] = useState(savedPanels.sidebarOpen);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(savedPanels.rightSidebarOpen);
  const [terminalState, setTerminalState] = useState(savedPanels.terminalState);
  const [activeTerminalTab, setActiveTerminalTab] = useState('terminal');
  const [previewKey, setPreviewKey] = useState(0);

  // ── Terminal ──────────────────────────────────────────────────────────────
  const [terminalLines, setTerminalLines] = useState(['ubuntu@epicode:~/workspace (main) $ ']);
  const [terminalInput, setTerminalInput] = useState('');
  const [outputLog, setOutputLog] = useState(['EpiCodeSpace output panel ready.']);
  const [debugConsoleLines, setDebugConsoleLines] = useState([{ type: 'info', text: 'Debug console attached.', ts: Date.now() }]);
  const [ports, setPorts] = useState([
    { port: 5173, protocol: 'https', state: 'running', label: 'Vite Dev Server', visibility: 'private', pid: 1024 },
  ]);
  const [chatTodos, setChatTodos] = useState([]);

  // ── Chat ──────────────────────────────────────────────────────────────────
  // Circuit-breaker limits: pause after this many consecutive tool rounds
  // and lock input once the session crosses the token ceiling.
  const MAX_TOOL_ROUNDS = 6;
  const TOKEN_CEILING = 50_000;

  const [chatInput, setChatInput] = useState('');
  const [chatImage, setChatImage] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isTyping, setIsTyping] = useState(false);
  const [sessionTokens, setSessionTokens] = useState(0);
  const [steerInput, setSteerInput] = useState('');
  const [isSteerOpen, setIsSteerOpen] = useState(false);
  const steerInputRef = useRef(null);
  const [chatMode, setChatMode] = useState(() => loadJSON(MODE_KEY, 'agent'));
  const savedConvos = loadJSON(CONVOS_KEY, [{ id: 1, name: 'Chat 1', messages: [], agent: 'epicode-agent', createdAt: Date.now() }]);
  const [activeAgent, setActiveAgent] = useState(() => loadJSON(AGENT_KEY, 'epicode-agent'));
  // Per-agent model selection (map agentId → modelId). Validated on load so
  // stale entries from a previous catalogue don't break the API call.
  const [activeModels, setActiveModels] = useState(() => {
    const raw = loadJSON(MODELS_KEY, {});
    const cleaned = {};
    for (const a of Object.keys(AGENT_REGISTRY)) {
      const saved = raw?.[a];
      cleaned[a] = (typeof saved === 'string' && (saved === AUTO_MODEL_ID || isValidModelFor(a, saved))) ? saved : defaultModelFor(a);
    }
    return cleaned;
  });
  const activeModel = activeModels[activeAgent] || defaultModelFor(activeAgent);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [agentPickerSubmenu, setAgentPickerSubmenu] = useState(null); // agentId whose model list is expanded
  const [showConversations, setShowConversations] = useState(false);
  const [convoSearch, setConvoSearch] = useState('');
  const [renamingConvo, setRenamingConvo] = useState(null);
  const [renameConvoValue, setRenameConvoValue] = useState('');
  const [conversations, setConversations] = useState(savedConvos);
  const [activeConvoId, setActiveConvoId] = useState(savedConvos[0]?.id ?? 1);
  const convoCountRef = useRef(Math.max(...savedConvos.map(c => c.id), 1));

  // ── Resizing ──────────────────────────────────────────────────────────────
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const isTablet = typeof window !== 'undefined' && window.innerWidth >= 768 && window.innerWidth < 1024;
  const [leftWidth, setLeftWidth] = useState(isMobile ? 280 : 240);
  const [rightWidth, setRightWidth] = useState(isMobile ? window.innerWidth : isTablet ? 300 : 320);
  const [termHeight, setTermHeight] = useState(isMobile ? 200 : 256);
  const [isDragging, setIsDragging] = useState(null);
  const [screenWidth, setScreenWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200);

  // ── Editor extras ─────────────────────────────────────────────────────────
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const savedPrefs = loadJSON(PREFS_KEY, { fontSize: 13, wordWrap: false });
  const [fontSize, setFontSize] = useState(savedPrefs.fontSize);
  const [wordWrap, setWordWrap] = useState(savedPrefs.wordWrap);
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [savedIndicator, setSavedIndicator] = useState(false);
  const [activeMenu, setActiveMenu] = useState(null);
  const [showAbout, setShowAbout] = useState(false);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [wcServerUrl, setWcServerUrl] = useState('');
  const setPreviewUrl = setWcServerUrl; // alias used by WebContainerTerminal

  // ── Refs ──────────────────────────────────────────────────────────────────
  const chatEndRef = useRef(null);
  const editorRef = useRef(null);
  const menuBarRef = useRef(null);
  const termInputRef = useRef(null);
  const handleSaveRef = useRef(null);
  const handleNewFileRef = useRef(null);
  const handleTerminalCommandRef = useRef(null);
  // AbortController for the active chat fetch loop — aborted on new submission or unmount
  const chatAbortRef = useRef(null);

  // ── Track screen width ────────────────────────────────────────────────────
  useEffect(() => {
    const onResize = () => setScreenWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── Wire logger → DEBUG CONSOLE panel ────────────────────────────────────
  useEffect(() => {
    // Pre-fill with any entries already in the buffer (e.g. from module init).
    const existing = logger.getBuffer().map(e => ({ type: e.level, text: `[${e.scope}] ${e.message}${e.data !== undefined ? ' ' + JSON.stringify(e.data) : ''}`, ts: e.ts }));
    if (existing.length) setDebugConsoleLines(prev => [...prev, ...existing]);
    // Subscribe to live entries.
    return logger.subscribe((e) => {
      setDebugConsoleLines(prev => [...prev, { type: e.level, text: `[${e.scope}] ${e.message}${e.data !== undefined ? ' ' + JSON.stringify(e.data) : ''}`, ts: e.ts }]);
    });
  }, []);
  const sm = screenWidth < 768;
  const md = screenWidth >= 768 && screenWidth < 1024;

  // ── WebContainer outbound sync: mirror file edits into the live container.
  useEffect(() => {
    if (!onMutation) return;
    let cancelled = false;
    let unsub = null;
    (async () => {
      try {
        const mod = await import('./lib/runtime/syncOutbound.ts');
        if (cancelled) return;
        unsub = onMutation(mod.applyMutation);
      } catch (err) {
        logger.warn('runtime', 'outbound sync not loaded', err);
      }
    })();
    return () => { cancelled = true; unsub?.(); };
  }, [onMutation]);

  // ── Persistence is now owned by useFileSystem (localStorage debounced in
  //    memory mode, per-path diff sync in OPFS mode). Keep tabs / active file
  //    in sync when the underlying FS snapshot replaces wholesale (e.g. right
  //    after OPFS init loads the on-disk tree, or after importing a project).
  useEffect(() => {
    setOpenTabs(prev => {
      const next = prev.filter(t => fileSystem[t]);
      return next.length === prev.length ? prev : next;
    });
    setActiveFile(cur => (cur && !fileSystem[cur]) ? (Object.keys(fileSystem)[0] || null) : cur);
  }, [fileSystem]);

  // Surface OPFS init failures once so the user knows why we silently fell
  // back to memory mode.
  const didReportInitErr = useRef(false);
  useEffect(() => {
    if (fsInitError && !didReportInitErr.current) {
      didReportInitErr.current = true;
      toast?.error?.(`OPFS init failed (${fsInitError.code}): ${fsInitError.message}. Running in localStorage mode.`);
    }
  }, [fsInitError, toast]);
  useEffect(() => {
    const t = setTimeout(() => storeJSON(CONVOS_KEY, conversations), 400);
    return () => clearTimeout(t);
  }, [conversations]);
  useEffect(() => { storeJSON(AGENT_KEY, activeAgent); }, [activeAgent]);
  useEffect(() => { storeJSON(MODELS_KEY, activeModels); }, [activeModels]);
  useEffect(() => { storeJSON(MODE_KEY, chatMode); }, [chatMode]);
  useEffect(() => {
    const t = setTimeout(() => storeJSON(PREFS_KEY, { fontSize, wordWrap }), 300);
    return () => clearTimeout(t);
  }, [fontSize, wordWrap]);
  useEffect(() => {
    const t = setTimeout(() => storeJSON(PANELS_KEY, { sidebarOpen, rightSidebarOpen, terminalState }), 300);
    return () => clearTimeout(t);
  }, [sidebarOpen, rightSidebarOpen, terminalState]);

  // ── Chat auto-scroll ─────────────────────────────────────────────────────
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, isTyping]);

  // ── Resizing logic (mouse + touch) ────────────────────────────────────────
  useEffect(() => {
    if (!isDragging) return;
    const getXY = (e) => e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };
    const onMove = (e) => {
      const { x, y } = getXY(e);
      if (isDragging === 'left') setLeftWidth(Math.max(160, Math.min(sm ? screenWidth * 0.85 : 600, x)));
      else if (isDragging === 'right') setRightWidth(Math.max(250, Math.min(sm ? screenWidth : 800, window.innerWidth - x)));
      else if (isDragging === 'terminal') setTermHeight(Math.max(80, Math.min(window.innerHeight - 150, window.innerHeight - y - 24)));
    };
    const onUp = () => setIsDragging(null);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    };
  }, [isDragging, sm, screenWidth]);

  // ── Close menu/picker on outside click ─────────────────────────────────
  useEffect(() => {
    const h = (e) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target)) setActiveMenu(null);
      // Close agent picker if click outside chat panel
      if (showAgentPicker && !e.target.closest('[data-agent-picker]')) setShowAgentPicker(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showAgentPicker]);

  // ── Cursor tracking ──────────────────────────────────────────────────────
  // Monaco pushes structured positions to us via its own event, but we keep
  // a fallback signature for any non-Monaco fallback UI that may still wire
  // to the old textarea-style event object.
  const handleCursorMove = useCallback((arg) => {
    if (arg && typeof arg.line === 'number') {
      setCursorPos({ line: arg.line, col: arg.col });
      return;
    }
    const ta = arg?.target;
    if (!ta || typeof ta.value !== 'string') return;
    const text = ta.value.substring(0, ta.selectionStart);
    const lines = text.split('\n');
    setCursorPos({ line: lines.length, col: lines[lines.length - 1].length + 1 });
  }, []);

  // ── Problems scanner (debounced — only runs 600ms after typing stops) ──────
  // Amendment #4 — Performance: defer the heavy scan so keystrokes feel instant.
  const [debouncedFS, setDebouncedFS] = useState(fileSystem);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFS(fileSystem), 600);
    return () => clearTimeout(t);
  }, [fileSystem]);
  const deferredFS = useDeferredValue(debouncedFS);
  const allProblems = useMemo(() => {
    const results = [];
    Object.entries(deferredFS).forEach(([path, f]) => {
      if (!f || typeof f.content !== 'string') return;
      f.content.split('\n').forEach((line, idx) => {
        if (line.trim().startsWith('//')) return;
        if (/console\.(log|warn|error|info)/.test(line)) results.push({ severity: 'warning', file: path, line: idx + 1, msg: `Avoid console.${line.match(/console\.(log|warn|error|info)/)[1]} in production code` });
        if (/TODO|FIXME|HACK/.test(line)) results.push({ severity: 'info', file: path, line: idx + 1, msg: `${line.match(/TODO|FIXME|HACK/)[0]}: ${line.trim()}` });
        if (/==(?!=)/.test(line)) results.push({ severity: 'warning', file: path, line: idx + 1, msg: 'Use === instead of ==' });
        if (/\bvar\b/.test(line)) results.push({ severity: 'warning', file: path, line: idx + 1, msg: 'Prefer const or let over var' });
        if (line.length > 120) results.push({ severity: 'info', file: path, line: idx + 1, msg: `Line exceeds 120 characters (${line.length})` });
        if (/debugger/.test(line)) results.push({ severity: 'error', file: path, line: idx + 1, msg: 'Remove debugger statement before commit' });
      });
    });
    return results;
  }, [deferredFS]);

  const errorCount = useMemo(() => allProblems.filter(p => p.severity === 'error').length, [allProblems]);
  const warningCount = useMemo(() => allProblems.filter(p => p.severity === 'warning').length, [allProblems]);
  const infoCount = useMemo(() => allProblems.filter(p => p.severity === 'info').length, [allProblems]);

  // ── Live preview document builder ───────────────────────────────────
  // Uses debouncedFS so it only rebuilds 600ms after typing stops.
  // Finds the HTML entry point then inlines linked CSS/JS from the virtual FS.
  // External CDN stylesheets are fetched and inlined asynchronously.

  // Holds the async-enriched final preview HTML (with CDN CSS inlined)
  const [previewDoc, setPreviewDoc] = useState(null);

  useEffect(() => {
    const htmlEntry = debouncedFS['index.html']
      || Object.entries(debouncedFS).find(([k]) => k.endsWith('.html'))?.[1];
    if (!htmlEntry) { setPreviewDoc(null); return; }

    let html = htmlEntry.content;

    // Only inject a minimal reset if the page doesn't already include Tailwind
    // so we don't fight Tailwind's own preflight
    const hasTailwind = /tailwindcss|tailwind\.min\.css/i.test(html);
    if (!hasTailwind) {
      const resetStyle = '<style>*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif}</style>';
      html = html.replace(/<head([^>]*)>/i, `<head$1>\n  ${resetStyle}`);
    }

    // Inline local CSS <link> tags — match by filename regardless of path prefix
    Object.entries(debouncedFS).forEach(([, f]) => {
      if (f.language !== 'css' || !f.name) return;
      const name = f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(
        new RegExp(`<link[^>]+href=["'][^"']*${name}["'][^>]*/?>`, 'gi'),
        `<style>\n${f.content}\n</style>`
      );
    });

    // Inline local JS files — both classic and module scripts, match by filename
    Object.entries(debouncedFS).forEach(([, f]) => {
      if (f.language !== 'javascript' || !f.name) return;
      const name = f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Classic scripts
      html = html.replace(
        new RegExp(`<script(?![^>]*type=["']module["'])[^>]+src=["'][^"']*${name}["'][^>]*></script>`, 'gi'),
        `<script>\n${f.content}\n</script>`
      );
      // Module scripts pointing to local files (preserve type="module" so imports work)
      html = html.replace(
        new RegExp(`<script([^>]*type=["']module["'][^>]*)\\s+src=["'][^"']*${name}["']([^>]*)></script>`, 'gi'),
        `<script$1$2>\n${f.content}\n</script>`
      );
      html = html.replace(
        new RegExp(`<script([^>]*)\\s+src=["'][^"']*${name}["']([^>]*type=["']module["'][^>]*)></script>`, 'gi'),
        `<script$1$2>\n${f.content}\n</script>`
      );
    });

    // Fetch and inline any remaining external CDN stylesheet <link> tags
    // so they work even in a sandboxed iframe with a null origin.
    const cdnLinkRe = /<link[^>]+rel=["']stylesheet["'][^>]*href=["'](https?:\/\/[^"']+)["'][^>]*\/?>|<link[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*rel=["']stylesheet["'][^>]*\/?>/gi;
    const matches = [];
    let m;
    while ((m = cdnLinkRe.exec(html)) !== null) {
      matches.push({ full: m[0], url: m[1] || m[2] });
    }

    if (matches.length === 0) {
      setPreviewDoc(html);
      return;
    }

    let cancelled = false;
    (async () => {
      let enriched = html;
      await Promise.all(matches.map(async ({ full, url }) => {
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const css = await res.text();
          enriched = enriched.replace(full, `<style>\n${css}\n</style>`);
        } catch { /* leave original link tag if fetch fails */ }
      }));
      if (!cancelled) setPreviewDoc(enriched);
    })();

    return () => { cancelled = true; };
  }, [debouncedFS, previewKey]); // previewKey forces a rebuild on manual refresh

  // ── Build output (stable) ────────────────────────────────────────────────
  const buildOutput = useMemo(() => {
    const total = Object.values(fileSystem).reduce((a, f) => a + (f?.content?.length || 0), 0);
    return [
      '> epicodespace@1.0.0 build', '> vite build', '',
      'vite v6.0.0 building for production...',
      `✓ ${Object.keys(fileSystem).length + 38} modules transformed.`,
      'dist/index.html                   0.45 kB',
      `dist/assets/index-Bqx3.css        ${(total / 1200).toFixed(2)} kB | gzip: 2.31 kB`,
      `dist/assets/index-DiYf.js       ${(total / 1000).toFixed(2)} kB | gzip: 58.21 kB`,
      '✓ built in 1.14s',
    ];
  }, [fileSystem]);

  // ── File handlers ─────────────────────────────────────────────────────────
  const handleFileClick = useCallback((path) => {
    setActiveFile(path);
    setOpenTabs(prev => prev.includes(path) ? prev : [...prev, path]);
    if (sm) setSidebarOpen(false);
  }, [sm]);

  const handleCloseTab = useCallback((path, e) => {
    e.stopPropagation();
    setOpenTabs(prev => {
      const next = prev.filter(t => t !== path);
      setActiveFile(cur => cur === path ? (next[next.length - 1] ?? Object.keys(fileSystem)[0]) : cur);
      return next;
    });
  }, [fileSystem]);

  const handleEditorChange = useCallback((e) => {
    if (!activeFile) return;
    // Kept for any residual textarea-style callers. Monaco uses a direct
    // lambda in the Suspense block below.
    const value = typeof e === 'string' ? e : e?.target?.value;
    if (typeof value === 'string') patchFile(activeFile, value);
  }, [activeFile, patchFile]);

  const handleSave = useCallback(() => {
    setSavedIndicator(true);
    setTimeout(() => setSavedIndicator(false), 2000);
  }, []);

  const handleNewFile = useCallback(() => {
    setUntitledCount(prev => {
      const newPath = `untitled-${prev}.js`;
      writeFile(newPath, '', 'javascript');
      setOpenTabs(tabs => tabs.includes(newPath) ? tabs : [...tabs, newPath]);
      setActiveFile(newPath);
      return prev + 1;
    });
  }, [writeFile]);

  // Create a file at an explicit path (used by FileExplorer for nested + duplicate)
  const handleCreateFileAt = useCallback((path, content = '', language) => {
    if (!path || typeof path !== 'string') return;
    const name = path.split('/').pop();
    const ext = name.split('.').pop()?.toLowerCase();
    const lang = language || ({
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
      ts: 'typescript', tsx: 'typescript',
      css: 'css', scss: 'css',
      html: 'html', htm: 'html',
      json: 'json', md: 'markdown',
    }[ext] || 'text');
    // Only create when missing — duplicate-file flow relies on this no-op.
    if (!getLatest()[path]) writeFile(path, content, lang);
    setOpenTabs(prev => prev.includes(path) ? prev : [...prev, path]);
    setActiveFile(path);
  }, [getLatest, writeFile]);

  // Move a file to a new path (used by drag & drop and cut/paste)
  const handleMoveFile = useCallback((oldPath, newPath) => {
    if (!oldPath || !newPath || oldPath === newPath) return;
    const snap = getLatest();
    if (!snap[oldPath] || snap[newPath]) return;
    hookRenameFile(oldPath, newPath);
    setOpenTabs(prev => prev.map(t => t === oldPath ? newPath : t));
    setActiveFile(cur => cur === oldPath ? newPath : cur);
  }, [getLatest, hookRenameFile]);

  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);
  useEffect(() => { handleNewFileRef.current = handleNewFile; }, [handleNewFile]);

  // ── Project management ────────────────────────────────────────────────────
  useEffect(() => { storeJSON('epicodespace_project_v1', projectName); }, [projectName]);

  const handleNewProject = useCallback((template, name) => {
    const templates = {
      empty: {},
      react: {
        'src/App.jsx': { name: 'App.jsx', language: 'javascript', content: "import React from 'react';\n\nexport default function App() {\n  return <div>Hello World</div>;\n}\n" },
        'src/index.jsx': { name: 'index.jsx', language: 'javascript', content: "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\n\ncreateRoot(document.getElementById('root')).render(<App />);\n" },
        'src/index.css': { name: 'index.css', language: 'css', content: "body { margin: 0; font-family: sans-serif; }\n" },
        'index.html': { name: 'index.html', language: 'html', content: '<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>React App</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/index.jsx"></script>\n  </body>\n</html>\n' },
        'vite.config.js': { name: 'vite.config.js', language: 'javascript', content: "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n" },
        'package.json': { name: 'package.json', language: 'json', content: JSON.stringify({ name: 'my-app', version: '1.0.0', type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' }, devDependencies: { '@vitejs/plugin-react': '^4.0.0', vite: '^6.0.0' } }, null, 2) + '\n' },
      },
      node: {
        'index.js': { name: 'index.js', language: 'javascript', content: "const http = require('http');\n\nconst PORT = process.env.PORT || 3000;\n\nconst server = http.createServer((req, res) => {\n  res.writeHead(200, { 'Content-Type': 'text/plain' });\n  res.end('Hello World\\n');\n});\n\nserver.listen(PORT, () => console.log(`Server running on port ${PORT}`));\n" },
        'package.json': { name: 'package.json', language: 'json', content: JSON.stringify({ name: 'my-server', version: '1.0.0', main: 'index.js', scripts: { start: 'node index.js', dev: 'node --watch index.js' } }, null, 2) + '\n' },
      },
      html: {
        'index.html': { name: 'index.html', language: 'html', content: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>My Site</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>Hello World</h1>\n  <script src="app.js"></script>\n</body>\n</html>\n' },
        'style.css': { name: 'style.css', language: 'css', content: "body {\n  margin: 0;\n  font-family: sans-serif;\n  background: #f5f5f5;\n}\n\nh1 {\n  text-align: center;\n  padding: 2rem;\n}\n" },
        'app.js': { name: 'app.js', language: 'javascript', content: "document.addEventListener('DOMContentLoaded', () => {\n  console.log('App loaded');\n});\n" },
      },
    };
    const newFS = templates[template] || templates.empty;
    replaceAll(newFS);
    const firstKey = Object.keys(newFS)[0] || null;
    setOpenTabs(firstKey ? [firstKey] : []);
    setActiveFile(firstKey);
    // Use the caller-supplied name; fall back to a safe default.
    const resolvedName = (name || '').trim() || (template === 'empty' ? 'New Project' : `${template}-app`);
    setProjectName(resolvedName);
  }, [replaceAll]);

  const handleDeleteFile = useCallback((path) => {
    hookDeleteFile(path);
    setOpenTabs(prev => prev.filter(t => t !== path));
    setActiveFile(cur => cur === path ? (Object.keys(getLatest()).find(k => k !== path) || null) : cur);
  }, [hookDeleteFile, getLatest]);

  const handleRenameFile = useCallback((oldPath, newPath) => {
    if (!newPath || newPath === oldPath) return;
    const snap = getLatest();
    if (!snap[oldPath] || snap[newPath]) return;
    hookRenameFile(oldPath, newPath);
    setOpenTabs(prev => prev.map(t => t === oldPath ? newPath : t));
    setActiveFile(cur => cur === oldPath ? newPath : cur);
    setRenamingFile(null);
  }, [getLatest, hookRenameFile]);

  const handleExportProject = useCallback(() => {
    const files = Object.entries(fileSystem);
    if (files.length === 0) return;
    // Export as JSON bundle (downloadable)
    const bundle = { name: projectName, files: fileSystem, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName.replace(/[^a-zA-Z0-9-_]/g, '_')}.epicode.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [fileSystem, projectName]);

  const handleImportProject = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.epicode.json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.files && typeof data.files === 'object') {
            // Validate: must not exceed 500 files or 5 MB total
            const fileEntries = Object.entries(data.files);
            if (fileEntries.length > 500) { toast.error('Import failed: too many files (max 500).'); return; }
            const totalSize = fileEntries.reduce((s, [, f]) => s + (typeof f?.content === 'string' ? f.content.length : 0), 0);
            if (totalSize > 5_000_000) { toast.error('Import failed: project exceeds 5 MB.'); return; }
            // Sanitize each entry
            const cleanFS = {};
            fileEntries.forEach(([k, f]) => {
              if (typeof k === 'string' && k.length <= 260 && f && typeof f.content === 'string') {
                cleanFS[k] = { name: k.split('/').pop(), language: f.language || 'text', content: f.content };
              }
            });
            replaceAll(cleanFS);
            setProjectName(data.name || file.name.replace(/\.epicode\.json$|\.json$/, ''));
            const first = Object.keys(cleanFS)[0] || null;
            setOpenTabs(first ? [first] : []);
            setActiveFile(first);
          }
        } catch { /* invalid file */ }
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

  // ── Clipboard operations ──────────────────────────────────────────────────
  const editorCut = useCallback(() => {
    const ta = editorRef.current;
    if (!ta || !activeFile) return;
    const selected = ta.value.substring(ta.selectionStart, ta.selectionEnd);
    if (!selected) return;
    navigator.clipboard?.writeText(selected).catch(() => {});
    const newVal = ta.value.substring(0, ta.selectionStart) + ta.value.substring(ta.selectionEnd);
    patchFile(activeFile, newVal);
  }, [activeFile, patchFile]);

  const editorCopy = useCallback(() => {
    const ta = editorRef.current;
    if (!ta) return;
    navigator.clipboard?.writeText(ta.value.substring(ta.selectionStart, ta.selectionEnd)).catch(() => {});
  }, []);

  const editorPaste = useCallback(() => {
    navigator.clipboard?.readText().then(text => {
      const ta = editorRef.current;
      if (!ta || !activeFile) return;
      const newVal = ta.value.substring(0, ta.selectionStart) + text + ta.value.substring(ta.selectionEnd);
      patchFile(activeFile, newVal);
    }).catch(() => {});
  }, [activeFile, patchFile]);

  const editorSelectAll = useCallback(() => { editorRef.current?.focus(); editorRef.current?.select(); }, []);

  // ── Keyboard shortcuts (stable refs) ──────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 's') { e.preventDefault(); handleSaveRef.current?.(); }
      if (ctrl && e.key === 'n') { e.preventDefault(); handleNewFileRef.current?.(); }
      if (ctrl && e.key === 'f') { e.preventDefault(); setShowFind(true); }
      if (ctrl && e.key === '`') { e.preventDefault(); setTerminalState(p => p === 'open' ? 'closed' : 'open'); }
      if (ctrl && e.shiftKey && e.key === 'E') { e.preventDefault(); setSidebarOpen(p => !p); }
      if (ctrl && e.key === '=') { e.preventDefault(); setFontSize(p => Math.min(p + 1, 28)); }
      if (ctrl && e.key === '-') { e.preventDefault(); setFontSize(p => Math.max(p - 1, 10)); }
      if (ctrl && e.key === '0') { e.preventDefault(); setFontSize(13); }
      if (e.key === 'Escape') { setShowFind(false); setFindQuery(''); setActiveMenu(null); setShowAbout(false); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // ── Patch utility: exact-match swap with ambiguity detection ───────────
  const applyPatch = (content, oldText, newText) => {
    if (!oldText) return { ok: false, error: 'oldText must not be empty' };
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) return { ok: false, error: 'oldText not found in file — the block may have already changed or the text is hallucinated. Read the file first, then retry with an exact verbatim match.' };
    if (occurrences > 1) return { ok: false, error: `oldText is ambiguous — found ${occurrences} occurrences. Expand the snippet to make it unique.` };
    return { ok: true, content: content.replace(oldText, newText ?? '') };
  };

  // ── Execute tool calls against virtual filesystem ────────────────────────
  const executeToolCall = useCallback((name, args, currentFS) => {
    switch (name) {
      case 'readFile': {
        const f = currentFS[args.path];
        if (!f) return { ok: false, error: `File not found: ${args.path}` };
        const safeContent = f.content ?? '';
        return { ok: true, path: args.path, content: safeContent, language: f.language, lines: safeContent.split('\n').length };
      }
      case 'writeFile': {
        if (currentFS[args.path]) {
          return { ok: false, error: `'${args.path}' already exists — use editFile with oldText/newText to patch specific sections instead of overwriting the whole file.` };
        }
        const lang = args.path.endsWith('.jsx') || args.path.endsWith('.js') ? 'javascript'
          : args.path.endsWith('.tsx') || args.path.endsWith('.ts') ? 'typescript'
          : args.path.endsWith('.css') ? 'css'
          : args.path.endsWith('.json') ? 'json'
          : args.path.endsWith('.md') ? 'markdown'
          : args.path.endsWith('.html') ? 'html' : 'text';
        const safeContent = args.content ?? '';
        return { ok: true, action: 'write', path: args.path, language: lang, content: safeContent, lines: safeContent.split('\n').length };
      }
      case 'editFile': {
        const f = currentFS[args.path];
        if (!f) return { ok: false, error: `File not found: ${args.path}` };
        const patch = applyPatch(f.content ?? '', args.oldText ?? '', args.newText ?? '');
        if (!patch.ok) return patch;
        return { ok: true, action: 'edit', path: args.path, content: patch.content, lines: patch.content.split('\n').length };
      }
      case 'deleteFile': {
        if (!currentFS[args.path]) return { ok: false, error: `File not found: ${args.path}` };
        return { ok: true, action: 'delete', path: args.path };
      }
      case 'listFiles':
        return { ok: true, files: Object.entries(currentFS).map(([p, f]) => ({ path: p, language: f.language, lines: (f.content ?? '').split('\n').length })) };
      case 'searchCode': {
        const results = [];
        const pat = args.pattern?.toLowerCase() || '';
        Object.entries(currentFS).forEach(([p, f]) => {
          (f.content ?? '').split('\n').forEach((line, i) => {
            if (line.toLowerCase().includes(pat)) results.push({ file: p, line: i + 1, text: line.trim().slice(0, 120) });
          });
        });
        return { ok: true, pattern: args.pattern, matches: results.length, results: results.slice(0, 30) };
      }
      case 'analyzeFile': {
        const targetPath = args.path || activeFile;
        const f = currentFS[targetPath];
        if (!f) return { ok: false, error: `File not found: ${targetPath}` };
        // Re-use the same analysis engine as createAgentTools
        const tools = createAgentTools(currentFS, targetPath);
        return tools.analyzeFile.execute(targetPath);
      }
      case 'runCommand': {
        // Require user confirmation before running destructive-looking commands
        const cmd = (args.command || '').trim();
        const isDestructive = /\brm\b|\brmdir\b|\bdrop\b|\bdelete\b|\bformat\b|>\s*\//.test(cmd);
        if (isDestructive) {
          const ok = window.confirm(`The AI agent wants to run:\n\n  ${cmd}\n\nAllow this command?`);
          if (!ok) return { ok: false, error: 'User cancelled command execution.' };
        }
        return { ok: true, action: 'runCommand', command: cmd };
      }
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  }, []);

  // ── Apply file mutations from tool calls ────────────────────────────────
  const applyToolMutations = useCallback((toolCalls, results, currentFS) => {
    let newFS = { ...currentFS };
    let changed = false;
    const cmdsToRun = [];
    toolCalls.forEach((tc, i) => {
      const r = results[i]?.result;
      if (!r?.ok) return;
      if (tc.name === 'writeFile') {
        // Use r.content (validated inside executeToolCall) rather than
        // tc.arguments.content directly — prevents empty files when the
        // model hits max_tokens and the OpenAI arguments JSON is truncated.
        newFS[tc.arguments.path] = { name: tc.arguments.path.split('/').pop(), language: r.language, content: r.content ?? '' };
        changed = true;
      } else if (tc.name === 'editFile' && r.content) {
        newFS[tc.arguments.path] = { ...newFS[tc.arguments.path], content: r.content };
        changed = true;
      } else if (tc.name === 'deleteFile') {
        delete newFS[tc.arguments.path];
        changed = true;
      } else if (tc.name === 'runCommand' && r.action === 'runCommand') {
        cmdsToRun.push(tc.arguments.command);
      }
    });
    return { newFS, changed, cmdsToRun };
  }, []);

  // ── Stop agent + optionally steer ──────────────────────────────────────
  const handleStop = useCallback(() => {
    chatAbortRef.current?.abort();
    setIsTyping(false);
    setIsSteerOpen(false);
    setSteerInput('');
    // Leave a visible stopped indicator in the chat thread
    setMessages(prev => {
      const withoutProgress = prev.filter(m => !m._progress);
      return [...withoutProgress, {
        role: 'assistant',
        content: '⛔ *Stopped by user.*',
        agent: activeAgent,
        agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
        toolCalls: [], steps: [], mode: chatMode, timestamp: Date.now(),
      }];
    });
  }, [activeAgent, chatMode]);

  const handleOpenSteer = useCallback(() => {
    // Pause the agent (abort in-flight fetch) but keep isTyping true visually
    // until the user submits steering or cancels.
    chatAbortRef.current?.abort();
    setIsSteerOpen(true);
    // Focus the steer textarea on next frame
    requestAnimationFrame(() => steerInputRef.current?.focus());
  }, []);

  const handleSteer = useCallback(() => {
    const steering = steerInput.trim();
    if (!steering) { handleStop(); return; }
    setIsSteerOpen(false);
    setSteerInput('');
    // Inject the steering message as a new user turn and re-fire the loop
    const steerMsg = { role: 'user', content: `[Steering] ${steering}`, agent: activeAgent, timestamp: Date.now() };
    setMessages(prev => [...prev.filter(m => !m._progress), steerMsg]);
    setConversations(prev => prev.map(c =>
      c.id === activeConvoId
        ? { ...c, messages: [...c.messages.filter(m => !m._progress), steerMsg] }
        : c,
    ));
    // Re-use handleAgentSubmit logic by stuffing chatInput + simulating submit
    setChatInput(steering);
    // Use a microtask so state settles before the submit fires
    Promise.resolve().then(() => {
      chatAbortRef.current = new AbortController();
      setIsTyping(true);
    });
  }, [steerInput, activeAgent, activeConvoId, handleStop]);

  const handleAttachChatImage = useCallback(async (file) => {
    if (!isImageFile(file)) return;
    try {
      // Resize to ≤1024px and export as compressed JPEG to avoid 2MB limit.
      const dataUrl = await resizeImageToDataUrl(file, 1024);
      if (!dataUrl) return;
      const commaIdx = dataUrl.indexOf(',');
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '';
      const ext = imageExtFromFile(file);
      setChatImage({
        name: sanitizeFileName(file.name || `pasted-image.${ext}`),
        mime: 'image/jpeg',
        dataUrl,
        base64,
      });
    } catch (err) {
      logger.warn('chat', 'image attach failed', err);
    }
  }, []);

  const handleExplorerDropFiles = useCallback(async (files, folderPath = '') => {
    const list = Array.from(files || []).filter((f) => isImageFile(f));
    if (!list.length) return;
    const current = getLatest();
    for (const file of list) {
      try {
        const ext = imageExtFromFile(file);
        const baseName = sanitizeFileName(file.name || `image.${ext}`);
        const dot = baseName.lastIndexOf('.');
        const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
        const suffix = dot > 0 ? baseName.slice(dot) : `.${ext}`;
        let candidate = baseName;
        let idx = 1;
        while (current[folderPath ? `${folderPath}/${candidate}` : candidate]) {
          idx += 1;
          candidate = `${stem}-${idx}${suffix}`;
        }
        const targetPath = folderPath ? `${folderPath}/${candidate}` : candidate;
        const buffer = await arrayBufferFromFile(file);
        const bytes = new Uint8Array(buffer);
        // Generate a resized dataUrl for inline preview (≤2048px, JPEG 0.8).
        let dataUrl = null;
        try { dataUrl = await resizeImageToDataUrl(file, 2048); } catch { /* best-effort */ }
        const mime = imageMimeFromFile(file);
        if (dataUrl) {
          // Store the dataUrl as content so the editor pane can preview it.
          writeFile(targetPath, dataUrl, 'binary');
        } else {
          await writeBinaryFile(targetPath, bytes, 'binary');
        }
        current[targetPath] = { name: candidate, dataUrl, mime };
      } catch (err) {
        logger.warn('explorer', `drop import failed: ${file?.name || 'image'}`, err);
      }
    }
  }, [getLatest, writeBinaryFile]);

  // ── Chat handler (agent-aware with tool loop) ──────────────────────────
  const handleAgentSubmit = useCallback((e) => {
    e.preventDefault();
    if ((!chatInput.trim() && !chatImage) || isTyping || sessionTokens >= TOKEN_CEILING) return;
    // Abort any in-flight request before starting a new one
    chatAbortRef.current?.abort();
    chatAbortRef.current = new AbortController();
    const userMessage = chatInput.trim();
    const apiUserContent = toModelUserContent(userMessage, chatImage, activeAgent);
    const displayContent = userMessage || `Image attached: ${chatImage?.name || 'image'}`;
    const userMsg = { role: 'user', content: displayContent, agent: activeAgent, timestamp: Date.now(), imageDataUrl: chatImage?.dataUrl || null };
    setMessages(prev => [...prev, userMsg]);
    setConversations(prev => prev.map(c => c.id === activeConvoId ? { ...c, messages: [...c.messages, userMsg] } : c));
    setChatInput('');
    setChatImage(null);
    setIsTyping(true);

    const context = {
      activeFile,
      activeContent: fileSystem[activeFile]?.content || '',
      // Guard against entries with missing/non-string content (directory
      // placeholders, freshly-created empty files, binary blobs). Without
      // this, .split('\n') throws "undefined is not an object".
      files: Object.entries(fileSystem)
        .filter(([, f]) => f && typeof f === 'object')
        .map(([p, f]) => ({
          path: p,
          language: f.language || 'plaintext',
          lines: typeof f.content === 'string' ? f.content.split('\n').length : 0,
        })),
    };

    const convo = conversations.find(c => c.id === activeConvoId);
    const history = [...(convo?.messages || []), { ...userMsg, content: apiUserContent }]
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-20)
      .map(m => ({ role: m.role, content: m.content }));

    (async () => {
      let allSteps = [];
      let allToolCalls = [];
      let currentFS = { ...fileSystem };
      let pendingToolCalls = null;
      let toolResults = null;
      let lastToolCallSig = null;
      const MAX_ROUNDS = 8;
      let consecToolRounds = 0; // consecutive tool-call rounds without user input

      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const payload = { agent: activeAgent, model: activeModel, messages: history, context, mode: chatMode };
          if (toolResults && pendingToolCalls) {
            payload.toolResults = toolResults;
            payload.pendingToolCalls = pendingToolCalls;
          }

          const _fetchFn = (p, sig) => fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p),
            signal: sig,
          });
          const { response: res, usedRoute: _autoRoute } = await autoFetch(
            payload,
            inputValue,
            chatAbortRef.current?.signal,
            _fetchFn
          );
          // If Auto routing swapped the agent/model, reflect it in the payload for tool-round continuity
          if (_autoRoute) {
            payload.agent = _autoRoute.agent;
            payload.model = _autoRoute.model;
          }
          const data = await res.json();
          if (!res.ok) {
            const hint = data.missingKey
              ? ` Go to Vercel → Project → Settings → Environment Variables, add ${data.missingKey}, and redeploy.`
              : '';
            throw new Error((data.error || `API error ${res.status}`) + hint);
          }

          // If model returned text only, we're done
          if (data.type === 'text') {
            const assistantMsg = {
              role: 'assistant',
              content: data.content,
              agent: activeAgent,
              agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
              toolCalls: allToolCalls,
              steps: allSteps,
              mode: chatMode,
              timestamp: Date.now(),
              usage: data.usage,          // surface cache-hit telemetry
              truncated: data._truncated, // set by the API on context-length fallback
            };
            // Functional update + filter stale _progress stubs from the
            // previous tool round so history never gets corrupted.
            setMessages(prev => [...prev.filter(m => !m._progress), assistantMsg]);
            setConversations(prev => prev.map(c => c.id === activeConvoId
              ? { ...c, messages: [...c.messages.filter(m => !m._progress), assistantMsg] }
              : c));
            return;
          }

          // Accumulate token usage from every round into the session counter.
          if (data.usage) {
            const roundTokens = data.usage.total_tokens        // OpenAI
              ?? ((data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0))  // Anthropic
              ?? data.usage.totalTokenCount                      // Gemini
              ?? 0;
            if (roundTokens > 0) setSessionTokens(prev => prev + roundTokens);
          }

          // Model wants to call tools
          if (data.type === 'tool_calls' && data.tool_calls?.length) {
            consecToolRounds++;

            // Circuit breaker: pause after MAX_TOOL_ROUNDS consecutive tool
            // rounds and ask the user for explicit permission to continue.
            if (consecToolRounds > MAX_TOOL_ROUNDS) {
              const breakMsg = {
                role: 'assistant',
                content: `⏸️ **Circuit breaker triggered** — the agent has executed ${allToolCalls.length} tool calls (${MAX_TOOL_ROUNDS} consecutive rounds) without pausing.\n\nReply **"continue"** to let it keep going, or describe a new direction to steer it.`,
                agent: activeAgent,
                agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
                toolCalls: allToolCalls,
                steps: allSteps,
                mode: chatMode,
                timestamp: Date.now(),
                _circuitBreak: true,
              };
              setMessages(prev => [...prev.filter(m => !m._progress), breakMsg]);
              setConversations(prev => prev.map(c => c.id === activeConvoId
                ? { ...c, messages: [...c.messages.filter(m => !m._progress), breakMsg] }
                : c));
              return;
            }

            // Show thinking text if present
            if (data.content) {
              allSteps.push(`💭 ${data.content.slice(0, 200)}`);
            }

            // Execute each tool call locally
            toolResults = data.tool_calls.map(tc => {
              const signature = toolCallSignature(tc.name, tc.arguments);
              const isConsecutiveDuplicate = signature === lastToolCallSig;
              const result = isConsecutiveDuplicate
                ? {
                    ok: false,
                    duplicate: true,
                    systemMessage: 'You just read this file, please proceed with the data provided',
                  }
                : executeToolCall(tc.name, tc.arguments, currentFS);

              if (!isConsecutiveDuplicate) {
                lastToolCallSig = signature;
              }

              // Use result.lines — computed from the validated/safe content inside
              // executeToolCall — so it can never show 0 from a raw undefined arg.
              const argSummary = tc.name === 'writeFile' ? `"${tc.arguments.path}" (${result.lines ?? 0} lines)`
                : tc.name === 'editFile' ? `"${tc.arguments.path}"`
                : tc.name === 'deleteFile' ? `"${tc.arguments.path}"`
                : tc.name === 'readFile' ? `"${tc.arguments.path}"`
                : tc.name === 'searchCode' ? `"${tc.arguments.pattern}"`
                : tc.name === 'analyzeFile' ? `"${tc.arguments.path || activeFile}"`
                : '';
              const icon = tc.name === 'writeFile' ? '📝' : tc.name === 'editFile' ? '✏️' : tc.name === 'deleteFile' ? '🗑️' : tc.name === 'readFile' ? '📖' : tc.name === 'searchCode' ? '🔍' : tc.name === 'analyzeFile' ? '🔬' : '📋';
              const resultSummary = isConsecutiveDuplicate
                ? '⚠️ duplicate blocked'
                : tc.name === 'analyzeFile' && result.ok
                  ? `${result.issueCount} issue(s) [${result.summary}]`
                  : result.ok ? '✅' : '❌ ' + result.error;
              allSteps.push(`${icon} **${tc.name}**(${argSummary}) → ${resultSummary}`);
              allToolCalls.push({ tool: tc.name, args: tc.arguments });
              return { id: tc.id, name: tc.name, result };
            });

            // Apply filesystem mutations
            const { newFS, changed, cmdsToRun } = applyToolMutations(data.tool_calls, toolResults, currentFS);
            if (changed) {
              currentFS = newFS;
              replaceAll(newFS);
              data.tool_calls.forEach(tc => {
                if (tc.name === 'writeFile') {
                  setOpenTabs(prev => prev.includes(tc.arguments.path) ? prev : [...prev, tc.arguments.path]);
                  setActiveFile(tc.arguments.path);
                }
              });
            }
            // Run terminal commands requested by agent
            if (cmdsToRun.length > 0) {
              setTerminalState('open');
              setActiveTerminalTab('terminal');
              cmdsToRun.forEach(cmd => handleTerminalCommandRef.current?.(cmd));
            }

            pendingToolCalls = data.tool_calls;

            // Update steps in real-time with a progress message
            setMessages(prev => {
              const progressMsg = prev.find(m => m._progress && m.agent === activeAgent);
              const msg = {
                role: 'assistant', _progress: true,
                content: `Working... (${allToolCalls.length} tool call${allToolCalls.length > 1 ? 's' : ''})`,
                agent: activeAgent, agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
                toolCalls: [...allToolCalls], steps: [...allSteps],
                mode: chatMode, timestamp: Date.now(),
              };
              return progressMsg ? prev.map(m => m._progress && m.agent === activeAgent ? msg : m) : [...prev, msg];
            });

            continue; // next round
          }

          // Unexpected response shape — treat as text
          const assistantMsg = {
            role: 'assistant',
            content: data.content || 'Done.',
            agent: activeAgent, agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
            toolCalls: allToolCalls, steps: allSteps, mode: chatMode, timestamp: Date.now(),
          };
          setMessages(prev => [...prev.filter(m => !m._progress), assistantMsg]);
          setConversations(prev => prev.map(c => c.id === activeConvoId ? { ...c, messages: [...c.messages, assistantMsg] } : c));
          return;
        }

        // Max rounds reached
        const finalMsg = {
          role: 'assistant',
          content: `Completed ${allToolCalls.length} operations (max rounds reached).`,
          agent: activeAgent, agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
          toolCalls: allToolCalls, steps: allSteps, mode: chatMode, timestamp: Date.now(),
        };
        setMessages(prev => [...prev.filter(m => !m._progress), finalMsg]);
        setConversations(prev => prev.map(c => c.id === activeConvoId ? { ...c, messages: [...c.messages, finalMsg] } : c));
      } catch (err) {
        // AbortError is a deliberate user stop — don't show the fallback.
        if (err?.name === 'AbortError') {
          setMessages(prev => prev.filter(m => !m._progress));
          return;
        }
        logger.error('chat', 'API call failed — falling back to local agent', { message: err?.message });
        // Fallback to local simulated response
        const tools = createAgentTools(fileSystem, activeFile);
        const { response: fallbackResponse } = buildAgentResponse(activeAgent, userMessage, tools, fileSystem, activeFile);
        const assistantMsg = {
          role: 'assistant',
          content: `⚠️ *API unavailable — using local mode*\n\n${fallbackResponse}`,
          agent: activeAgent, agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
          toolCalls: allToolCalls, steps: [...allSteps, `⚠️ API error: ${err.message}`],
          mode: chatMode, timestamp: Date.now(),
        };
        setMessages(prev => [...prev.filter(m => !m._progress), assistantMsg]);
        setConversations(prev => prev.map(c => c.id === activeConvoId ? { ...c, messages: [...c.messages, assistantMsg] } : c));
      } finally {
        setIsTyping(false);
      }
    })();
  }, [chatInput, chatImage, isTyping, sessionTokens, fileSystem, activeFile, activeAgent, activeModel, activeConvoId, chatMode, executeToolCall, applyToolMutations, conversations]);

  const handleNewConversation = useCallback(() => {
    convoCountRef.current += 1;
    const newId = convoCountRef.current;
    const newConvo = { id: newId, name: `Chat ${newId}`, messages: [], agent: activeAgent, createdAt: Date.now() };
    setConversations(prev => [...prev, newConvo]);
    setActiveConvoId(newId);
    setMessages([]);
    setSessionTokens(0);
    setShowConversations(false);
    setConvoSearch('');
  }, [activeAgent]);

  const handleSwitchConversation = useCallback((id) => {
    setActiveConvoId(id);
    const convo = conversations.find(c => c.id === id);
    if (convo) {
      setMessages(convo.messages);
      setActiveAgent(convo.agent);
      // stamp last-opened so list stays sorted by recent
      setConversations(prev => prev.map(c => c.id === id ? { ...c, lastOpenedAt: Date.now() } : c));
    }
    setSessionTokens(0);
    setShowConversations(false);
    setConvoSearch('');
  }, [conversations]);

  const handleRenameConvo = useCallback((id, newName) => {
    if (!newName.trim()) return;
    setConversations(prev => prev.map(c => c.id === id ? { ...c, name: newName.trim() } : c));
    setRenamingConvo(null);
    setRenameConvoValue('');
  }, []);

  const handleDeleteConvo = useCallback((id) => {
    setConversations(prev => {
      const next = prev.filter(c => c.id !== id);
      if (next.length === 0) {
        convoCountRef.current += 1;
        const newId = convoCountRef.current;
        const fresh = { id: newId, name: `Chat ${newId}`, messages: [], agent: activeAgent, createdAt: Date.now() };
        setActiveConvoId(newId);
        setMessages([]);
        return [fresh];
      }
      if (id === activeConvoId) {
        const last = next[next.length - 1];
        setActiveConvoId(last.id);
        setMessages(last.messages);
        setActiveAgent(last.agent);
      }
      return next;
    });
  }, [activeConvoId, activeAgent]);

  // ── Open preview in a real browser tab using a blob URL ──────────────────
  // Doesn’t need a dev server — inlines everything from the virtual FS.
  const openPreviewTab = useCallback(() => {
    if (!previewDoc) {
      toast.warn('Add an index.html to your workspace first.');
      return;
    }
    const tab = window.open('', '_blank');
    if (!tab) { toast.error('Pop-up blocked. Please allow pop-ups for this site.'); return; }
    tab.document.open();
    tab.document.write(previewDoc);
    tab.document.close();
  }, [previewDoc]);

  // ── Build/Debug/Run handlers ──────────────────────────────────────────────
  const handleRunBuild = useCallback(() => {
    setTerminalState('open');
    setActiveTerminalTab('terminal');
    setOutputLog(buildOutput);
    setTerminalLines(prev => [...prev, 'ubuntu@epicode:~/workspace (main) $ npm run build', ...buildOutput, 'ubuntu@epicode:~/workspace (main) $ ']);
  }, [buildOutput]);

  const handleStartDebug = useCallback(() => {
    setTerminalState('open');
    setActiveTerminalTab('terminal');
    setTerminalLines(prev => [
      ...prev,
      `ubuntu@epicode:~/workspace (main) $ node --inspect ${fileSystem[activeFile]?.name || 'app.js'}`,
      'Debugger listening on ws://127.0.0.1:9229/abc123',
      'For help, see: https://nodejs.org/en/docs/inspector',
      'ubuntu@epicode:~/workspace (main) $ ',
    ]);
  }, [activeFile, fileSystem]);

  const handleRunActiveFile = useCallback(() => {
    const fileName = fileSystem[activeFile]?.name || 'file';
    setTerminalState('open');
    setActiveTerminalTab('terminal');
    setTerminalLines(prev => [...prev, `ubuntu@epicode:~/workspace (main) $ node ${fileName}`, `Running ${fileName}...`, 'Done.', 'ubuntu@epicode:~/workspace (main) $ ']);
  }, [activeFile, fileSystem]);

  // ── Terminal command handler ──────────────────────────────────────────────
  const handleTerminalCommand = useCallback((cmd) => {
    const prompt = 'ubuntu@epicode:~/workspace (main) $ ';
    const args = cmd.trim().split(/\s+/);
    const base = args[0];
    const fileList = Object.keys(fileSystem).join('  ');
    const responses = {
      clear: () => { setTerminalLines([]); return null; },
      ls: () => [`  ${fileList}`, 'index.html  node_modules/  package.json  postcss.config.js  tailwind.config.js  vite.config.js'],
      pwd: () => ['/workspaces/EpiCodeSpace'],
      whoami: () => ['ubuntu'],
      date: () => [new Date().toString()],
      echo: () => [args.slice(1).join(' ')],
      node: () => args[1] ? [`Running ${args[1]}...`, 'Done.'] : ['Welcome to Node.js v20.x.', 'Type ".exit" to exit'],
      git: () => {
        if (args[1] === 'status') return ['On branch main', 'Changes not staged for commit:', `  modified:   ${activeFile}`, '', `${Object.keys(fileSystem).length} files tracked`];
        if (args[1] === 'log') return ['commit a1b2c3d (HEAD -> main)', 'Author: EpiCodeSpace <dev@epicodespace.io>', 'Date:   ' + new Date().toDateString(), '', '    Initial commit'];
        if (args[1] === 'branch') return ['* main', '  dev', '  feature/ai-chat'];
        if (args[1] === 'diff') return [`diff --git a/${activeFile} b/${activeFile}`, '--- a/' + activeFile, '+++ b/' + activeFile, '@@ -1,4 +1,4 @@', '+ // latest changes'];
        if (args[1] === 'add') return args[2] ? [`Added ${args[2]} to staging area`] : ['Added all files to staging area'];
        if (args[1] === 'commit') return ['[main abc1234] ' + (args.includes('-m') ? args.slice(args.indexOf('-m') + 1).join(' ') : 'Commit'), ' 1 file changed, 1 insertion(+)'];
        if (args[1] === 'push') return ['Enumerating objects: 3, done.', 'Counting objects: 100% (3/3), done.', 'Writing objects: 100% (3/3), 312 bytes | 312.00 KiB/s', 'To github.com:epicodespace/project.git', '   abc1234..def5678  main -> main'];
        if (args[1] === 'pull') return ['Already up to date.'];
        if (args[1] === 'clone') return args[2] ? [`Cloning into '${args[2].split('/').pop()}'...`, 'remote: Enumerating objects: 42, done.', 'Receiving objects: 100% (42/42), done.'] : ['fatal: You must specify a repository to clone.'];
        if (args[1] === 'stash') return args[2] === 'pop' ? ['On branch main', 'Changes restored from stash'] : ['Saved working directory and index state WIP on main'];
        if (args[1] === 'remote') return ['origin  git@github.com:epicodespace/project.git (fetch)', 'origin  git@github.com:epicodespace/project.git (push)'];
        if (args[1] === 'checkout') return args[2] ? [`Switched to branch '${args[2]}'`] : ['error: please specify a branch'];
        return [`git: '${args[1] || ''}' is not a git command. See 'git --help'.`];
      },
      npm: () => {
        if (args[1] === 'run' && args[2] === 'build') { handleRunBuild(); return null; }
        if (args[1] === 'run' && args[2] === 'dev') return ['', '  VITE v6.0.0  ready in 312 ms', '', '  ➜  Local:   http://localhost:5173/', '  ➜  Network: use --host to expose'];
        if (args[1] === 'install' || args[1] === 'i') return ['added 127 packages, audited 128 packages in 4s', '24 packages are looking for funding', '  run `npm fund` for details', 'found 0 vulnerabilities'];
        if (args[1] === 'test') return ['> epicodespace@1.0.0 test', '> vitest run', '', 'PASS  src/__tests__/App.test.jsx', '  ✓ renders welcome message (12ms)', '', 'Test Suites: 1 passed, 1 total', 'Tests:       1 passed, 1 total'];
        if (args[1] === 'list' || args[1] === 'ls') return Object.keys(fileSystem).map(f => `  └── ${f}`);
        if (args[1] === 'init') return ['Wrote to /workspaces/EpiCodeSpace/package.json'];
        return [`npm: unknown command '${args.slice(1).join(' ')}'`];
      },
      cat: () => {
        const target = args[1];
        if (target && fileSystem[target]) return [fileSystem[target].content];
        return [`cat: ${target || '(no file)'}: No such file or directory`];
      },
      touch: () => {
        if (!args[1]) return ['touch: missing file operand'];
        if (!fileSystem[args[1]]) {
          writeFile(args[1], '', 'text');
          setOpenTabs(prev => prev.includes(args[1]) ? prev : [...prev, args[1]]);
          setActiveFile(args[1]);
        }
        return [`Created: ${args[1]}`];
      },
      mkdir: () => args[1] ? [`mkdir: directory '${args[1]}' created (virtual)`] : ['mkdir: missing operand'],
      rm: () => {
        if (!args[1]) return ['rm: missing operand'];
        const target = args[1] === '-rf' ? args[2] : args[1];
        if (target && fileSystem[target]) {
          hookDeleteFile(target);
          setOpenTabs(prev => prev.filter(t => t !== target));
          return [`Removed: ${target}`];
        }
        return [`rm: cannot remove '${target}': No such file or directory`];
      },
      mv: () => {
        if (!args[1] || !args[2]) return ['mv: missing operand'];
        if (!fileSystem[args[1]]) return [`mv: cannot stat '${args[1]}': No such file`];
        if (fileSystem[args[2]]) return [`mv: target '${args[2]}' already exists`];
        hookRenameFile(args[1], args[2]);
        setOpenTabs(prev => prev.map(t => t === args[1] ? args[2] : t));
        setActiveFile(cur => cur === args[1] ? args[2] : cur);
        return [`Renamed ${args[1]} → ${args[2]}`];
      },
      cp: () => {
        if (!args[1] || !args[2]) return ['cp: missing operand'];
        const src = fileSystem[args[1]];
        if (src) {
          writeFile(args[2], src.content ?? '', src.language);
          return [`Copied ${args[1]} → ${args[2]}`];
        }
        return [`cp: cannot stat '${args[1]}': No such file`];
      },
      grep: () => {
        if (!args[1]) return ['Usage: grep <pattern> [file]'];
        const pattern = args[1];
        const target = args[2];
        const results = [];
        const files = target && fileSystem[target] ? { [target]: fileSystem[target] } : fileSystem;
        Object.entries(files).forEach(([p, f]) => {
          f.content.split('\n').forEach((line, i) => {
            if (line.includes(pattern)) results.push(`${p}:${i + 1}: ${line.trim()}`);
          });
        });
        return results.length > 0 ? results : [`No matches for '${pattern}'`];
      },
      wc: () => {
        if (!args[1]) return ['Usage: wc <file>'];
        const target = args.find(a => fileSystem[a]);
        if (target) {
          const c = fileSystem[target].content;
          return [`  ${c.split('\n').length}  ${c.split(/\s+/).length}  ${c.length} ${target}`];
        }
        return [`wc: ${args[1]}: No such file`];
      },
      head: () => {
        const target = args[1];
        if (target && fileSystem[target]) return fileSystem[target].content.split('\n').slice(0, 10);
        return [`head: ${target || '(no file)'}: No such file`];
      },
      tail: () => {
        const target = args[1];
        if (target && fileSystem[target]) return fileSystem[target].content.split('\n').slice(-10);
        return [`tail: ${target || '(no file)'}: No such file`];
      },
      history: () => terminalLines.filter(l => l.startsWith('ubuntu@')).map((l, i) => `  ${i + 1}  ${l.replace('ubuntu@epicode:~/workspace (main) $ ', '')}`).slice(-20),
      env: () => ['NODE_ENV=development', 'PORT=5173', 'HOME=/home/ubuntu', 'SHELL=/bin/bash', 'TERM=xterm-256color', 'LANG=en_US.UTF-8'],
      which: () => args[1] ? [`/usr/bin/${args[1]}`] : ['Usage: which <command>'],
      curl: () => args[1] ? ['HTTP/1.1 200 OK', 'Content-Type: application/json', '', '{"status":"ok","message":"EpiCodeSpace API running"}'] : ['curl: try \'curl --help\' for more information'],
      ping: () => args[1] ? [`PING ${args[1]} (127.0.0.1) 56(84) bytes of data.`, `64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.035 ms`, `--- ${args[1]} ping statistics ---`, '1 packets transmitted, 1 received, 0% packet loss'] : ['ping: usage error'],
      uptime: () => [' 14:32:01 up 42 days,  3:17,  1 user,  load average: 0.12, 0.08, 0.01'],
      df: () => ['Filesystem     1K-blocks     Used Available Use% Mounted on', '/dev/sda1       41943040 12582912  29360128  30% /'],
      free: () => ['              total        used        free      shared  buff/cache   available', 'Mem:        8053696     2013424     4026848       65536     2013424     5786272'],
      uname: () => ['Linux epicodespace 5.15.0-1052-azure #60-Ubuntu SMP x86_64 GNU/Linux'],
      exit: () => { setTerminalState('closed'); return null; },
      python: () => ['Python 3.11.4', '>>> (interactive mode not available in EpiCodeSpace)'],
      docker: () => {
        if (args[1] === 'ps') return ['CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS   PORTS   NAMES'];
        if (args[1] === 'images') return ['REPOSITORY   TAG       IMAGE ID   CREATED   SIZE'];
        return ['Usage: docker [command]'];
      },
      deploy: () => {
        const target = args[1] || 'vercel';
        if (target === 'vercel' || target === '--vercel') {
          // Generate a deployable bundle and download it
          const files = Object.entries(fileSystem);
          if (files.length === 0) return ['Error: No files to deploy. Create some files first.'];
          setOutputLog(prev => [...prev, '', '> deploy --vercel', '⏳ Preparing deployment bundle...']);
          const pkg = fileSystem['package.json'];
          const bundle = {};
          files.forEach(([p, f]) => { bundle[p] = f.content; });
          // Add vercel.json if not present
          if (!bundle['vercel.json']) bundle['vercel.json'] = JSON.stringify({ buildCommand: "npm run build", outputDirectory: "dist", framework: "vite" }, null, 2);
          const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${projectName.replace(/[^a-zA-Z0-9-_]/g, '_')}-deploy.json`;
          a.click();
          URL.revokeObjectURL(url);
          setTimeout(() => setOutputLog(prev => [...prev, '✓ Bundle exported!', '', 'To deploy on Vercel:', '  1. Go to https://vercel.com/new', '  2. Import your Git repository or drag & drop the project files', '  3. Vercel auto-detects framework and deploys', '', 'Or use the Vercel CLI:', '  $ npm i -g vercel', '  $ vercel --prod']), 500);
          return [
            '⏳ Preparing for Vercel deployment...',
            `📦 Bundling ${files.length} files from "${projectName}"...`,
            '✓ Bundle downloaded!',
            '',
            'To deploy to Vercel:',
            '  1. Push your code to GitHub/GitLab/Bitbucket',
            '  2. Go to https://vercel.com/new and import the repo',
            '  3. Vercel auto-detects settings and deploys',
            '',
            'Or use the Vercel CLI:',
            '  $ npm i -g vercel && vercel --prod',
          ];
        }
        if (target === 'netlify' || target === '--netlify') {
          return [
            '📦 Netlify deployment guide:',
            '  1. Push code to GitHub',
            '  2. Go to https://app.netlify.com/start',
            '  3. Connect your repository',
            '  4. Set build command: npm run build',
            '  5. Set publish directory: dist',
            '  6. Click Deploy',
            '',
            'Or drag & drop the dist folder at https://app.netlify.com/drop',
          ];
        }
        if (target === 'github-pages' || target === '--gh-pages') {
          return [
            '📦 GitHub Pages deployment guide:',
            '  1. In your vite.config.js, set base: "/<repo-name>/"',
            '  2. npm run build',
            '  3. git add dist -f && git commit -m "deploy"',
            '  4. git subtree push --prefix dist origin gh-pages',
            '',
            'Or use GitHub Actions for automatic deployment.',
          ];
        }
        return [
          'Usage: deploy <platform>',
          '  deploy vercel      Deploy to Vercel (recommended)',
          '  deploy netlify     Deploy to Netlify',
          '  deploy github-pages Deploy to GitHub Pages',
        ];
      },
      export: () => {
        handleExportProject();
        return [`✓ Exporting project "${projectName}" as .epicode.json...`, 'Download started.'];
      },
      help: () => [
        'Available commands:',
        '  ls, pwd, whoami, date, echo, clear, help, exit, history, env, uname, uptime, df, free',
        '  cat <file>, touch <file>, mkdir <dir>, rm <file>, mv <src> <dst>, cp <src> <dst>',
        '  head <file>, tail <file>, wc <file>, grep <pattern> [file], which <cmd>',
        '  git status|log|branch|diff|add|commit|push|pull|clone|stash|remote|checkout',
        '  npm run dev|build|test | npm install|list|init',
        '  node <file>, python, docker ps|images, curl <url>, ping <host>',
        '  deploy vercel|netlify|github-pages  — deployment guides & bundle export',
        '  export  — export project as downloadable file',
      ],
    };
    const handler = responses[base];
    if (handler) {
      const output = handler();
      if (output === null) return;
      setTerminalLines(prev => [...prev, `${prompt}${cmd}`, ...output, prompt]);
    } else {
      setTerminalLines(prev => [...prev, `${prompt}${cmd}`, `bash: ${base}: command not found — type 'help' for available commands`, prompt]);
    }
  }, [fileSystem, activeFile, handleRunBuild, terminalLines, projectName, handleExportProject]);

  // Keep ref in sync so handleAgentSubmit can call it without a forward-reference TDZ
  handleTerminalCommandRef.current = handleTerminalCommand;

  // ── Menu definitions ──────────────────────────────────────────────────────
  const menuDefinitions = useMemo(() => ({
    File: [
      { label: 'New File', shortcut: 'Ctrl+N', icon: FilePlus, action: handleNewFile },
      { label: 'New Project...', icon: FolderOpen, action: () => setNewProjectDialog({ template: 'react' }) },
      { label: 'New Window', shortcut: 'Ctrl+Shift+N', disabled: true },
      { type: 'separator' },
      { label: 'Open Project...', icon: FolderOpen, action: handleImportProject },
      { type: 'separator' },
      { label: 'Save', shortcut: 'Ctrl+S', icon: Save, action: handleSave },
      { label: 'Save As...', shortcut: 'Ctrl+Shift+S', disabled: true },
      { label: 'Save All', shortcut: 'Ctrl+K S', action: handleSave },
      { type: 'separator' },
      { label: 'Export Project...', action: handleExportProject },
      { label: 'Deploy to Vercel', icon: Globe, action: () => { setTerminalState('open'); setActiveTerminalTab('terminal'); handleTerminalCommand('deploy vercel'); } },
      { label: 'Deploy to Netlify', icon: Globe, action: () => { setTerminalState('open'); setActiveTerminalTab('terminal'); handleTerminalCommand('deploy netlify'); } },
      { type: 'separator' },
      { label: 'Close Editor', shortcut: 'Ctrl+W', action: () => setActiveFile(Object.keys(fileSystem)[0] || null) },
    ],
    Edit: [
      { label: 'Undo', shortcut: 'Ctrl+Z', icon: Undo2, disabled: true },
      { label: 'Redo', shortcut: 'Ctrl+Y', icon: Redo2, disabled: true },
      { type: 'separator' },
      { label: 'Cut', shortcut: 'Ctrl+X', icon: Scissors, action: editorCut },
      { label: 'Copy', shortcut: 'Ctrl+C', icon: Copy, action: editorCopy },
      { label: 'Paste', shortcut: 'Ctrl+V', icon: Clipboard, action: editorPaste },
      { type: 'separator' },
      { label: 'Find', shortcut: 'Ctrl+F', icon: Search, action: () => setShowFind(true) },
      { label: 'Replace', shortcut: 'Ctrl+H', disabled: true },
      { type: 'separator' },
      { label: 'Select All', shortcut: 'Ctrl+A', action: editorSelectAll },
      { type: 'separator' },
      { label: 'Toggle Line Comment', shortcut: 'Ctrl+/', disabled: true },
      { label: 'Format Document', shortcut: 'Shift+Alt+F', disabled: true },
    ],
    Selection: [
      { label: 'Select All', shortcut: 'Ctrl+A', action: editorSelectAll },
      { label: 'Expand Selection', shortcut: 'Shift+Alt+→', disabled: true },
      { label: 'Shrink Selection', shortcut: 'Shift+Alt+←', disabled: true },
      { type: 'separator' },
      { label: 'Copy Line Up', shortcut: 'Shift+Alt+↑', disabled: true },
      { label: 'Copy Line Down', shortcut: 'Shift+Alt+↓', disabled: true },
      { label: 'Move Line Up', shortcut: 'Alt+↑', disabled: true },
      { label: 'Move Line Down', shortcut: 'Alt+↓', disabled: true },
      { type: 'separator' },
      { label: 'Add Cursor Above', shortcut: 'Ctrl+Alt+↑', disabled: true },
      { label: 'Add Cursor Below', shortcut: 'Ctrl+Alt+↓', disabled: true },
      { label: 'Select All Occurrences', shortcut: 'Ctrl+Shift+L', disabled: true },
    ],
    View: [
      { label: 'Command Palette', shortcut: 'Ctrl+Shift+P', disabled: true },
      { type: 'separator' },
      { label: 'Explorer', shortcut: 'Ctrl+Shift+E', action: () => setSidebarOpen(p => !p) },
      { label: 'AI Chat Panel', action: () => setRightSidebarOpen(p => !p) },
      { type: 'separator' },
      { label: 'Terminal', shortcut: 'Ctrl+`', action: () => setTerminalState(p => p === 'open' ? 'closed' : 'open') },
      { type: 'separator' },
      { label: 'Word Wrap', shortcut: 'Alt+Z', action: () => setWordWrap(p => !p) },
      { type: 'separator' },
      { label: 'Zoom In', shortcut: 'Ctrl+=', icon: ZoomIn, action: () => setFontSize(p => Math.min(p + 1, 28)) },
      { label: 'Zoom Out', shortcut: 'Ctrl+-', icon: ZoomOut, action: () => setFontSize(p => Math.max(p - 1, 10)) },
      { label: 'Reset Zoom', shortcut: 'Ctrl+0', action: () => setFontSize(13) },
    ],
    Go: [
      { label: 'Back', shortcut: 'Alt+←', disabled: true },
      { label: 'Forward', shortcut: 'Alt+→', disabled: true },
      { type: 'separator' },
      { label: 'Go to File...', shortcut: 'Ctrl+P', disabled: true },
      { label: 'Go to Symbol...', shortcut: 'Ctrl+Shift+O', disabled: true },
      { label: 'Go to Definition', shortcut: 'F12', disabled: true },
      { label: 'Go to Line/Column...', shortcut: 'Ctrl+G', disabled: true },
      { type: 'separator' },
      { label: 'Next Problem', shortcut: 'F8', disabled: true },
      { label: 'Previous Problem', shortcut: 'Shift+F8', disabled: true },
    ],
    Run: [
      { label: 'Start Debugging', shortcut: 'F5', icon: Bug, action: handleStartDebug },
      { label: 'Run Without Debugging', shortcut: 'Ctrl+F5', action: handleStartDebug },
      { label: 'Stop Debugging', shortcut: 'Shift+F5', icon: Square, disabled: true },
      { type: 'separator' },
      { label: 'Add Configuration...', disabled: true },
      { label: 'Toggle Breakpoint', shortcut: 'F9', disabled: true },
      { type: 'separator' },
      { label: 'Run Build Task', shortcut: 'Ctrl+Shift+B', action: handleRunBuild },
    ],
    Terminal: [
      { label: 'New Terminal', shortcut: 'Ctrl+Shift+`', action: () => { setTerminalState('open'); setActiveTerminalTab('terminal'); } },
      { label: 'Split Terminal', shortcut: 'Ctrl+Shift+5', disabled: true },
      { type: 'separator' },
      { label: 'Run Active File', action: handleRunActiveFile },
      { label: 'Run Selected Text', disabled: true },
      { type: 'separator' },
      { label: 'Clear Terminal', action: () => setTerminalLines([]) },
    ],
    Help: [
      { label: 'Welcome', disabled: true },
      { label: 'Documentation', icon: BookOpen, disabled: true },
      { label: 'Release Notes', disabled: true },
      { type: 'separator' },
      { label: 'Keyboard Shortcuts', shortcut: 'Ctrl+K Ctrl+S', disabled: true },
      { type: 'separator' },
      { label: 'Toggle Developer Tools', disabled: true },
      { type: 'separator' },
      { label: 'About EpiCodeSpace', icon: Info, action: () => setShowAbout(true) },
    ],
  }), [handleNewFile, handleNewProject, handleImportProject, handleExportProject, handleSave, handleTerminalCommand, editorCut, editorCopy, editorPaste, editorSelectAll, handleStartDebug, handleRunBuild, handleRunActiveFile, fileSystem]);

  // ═════════════════════════════════════════════════════════════════════════
  //  RENDER
  // ═════════════════════════════════════════════════════════════════════════
  return (
    <div className="app-shell flex flex-col bg-[#0a0412] text-purple-100 font-sans overflow-hidden selection:bg-fuchsia-500/30">

      {isDragging && <div className={`fixed inset-0 z-50 ${isDragging === 'terminal' ? 'cursor-row-resize' : 'cursor-col-resize'}`} style={{ touchAction: 'none' }} />}

      {/* ── Top Bar ───────────────────────────────────────────────────────── */}
      <header className="flex items-end justify-between px-2 sm:px-3 bg-[#15092a] border-b border-fuchsia-500/20 z-20 shrink-0 shadow-[0_4px_20px_rgba(192,38,211,0.05)]" style={{ paddingTop: 'var(--sat)', minHeight: 'calc(44px + var(--sat))', paddingBottom: '6px' }}>
        <div className="flex items-center gap-1.5 sm:gap-2 text-sm">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle Explorer" className="p-2 sm:p-1.5 hover:bg-[#25104a] rounded-md transition-colors text-purple-300">
            <Menu size={18} />
          </button>
          <div className="flex items-center gap-1.5 sm:gap-2 text-fuchsia-50 font-semibold px-1 sm:px-2">
            <Cpu className="text-fuchsia-400 drop-shadow-[0_0_8px_rgba(232,121,249,0.6)]" size={sm ? 16 : 18} />
            <span className="tracking-wide font-bold bg-clip-text text-transparent bg-gradient-to-r from-fuchsia-300 to-purple-300 text-xs sm:text-sm">EpiCodeSpace</span>
          </div>
          <div ref={menuBarRef} className="hidden md:flex items-center gap-1 ml-4 text-purple-300/80 relative">
            {Object.keys(menuDefinitions).map(menuName => (
              <div key={menuName} className="relative">
                <span
                  onClick={() => setActiveMenu(activeMenu === menuName ? null : menuName)}
                  className={`px-2 py-1 rounded-md cursor-pointer text-xs transition-colors select-none ${activeMenu === menuName ? 'bg-[#25104a] text-purple-100' : 'hover:bg-[#25104a] hover:text-purple-100'}`}
                >
                  {menuName}
                </span>
                {activeMenu === menuName && (
                  <div className="absolute top-full left-0 mt-0.5 w-64 bg-[#1a0b35] border border-fuchsia-500/30 rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.7)] z-50 py-1 overflow-hidden">
                    {menuDefinitions[menuName].map((item, idx) =>
                      item.type === 'separator'
                        ? <div key={idx} className="my-1 border-t border-fuchsia-500/15" />
                        : (
                          <button
                            key={idx}
                            disabled={item.disabled}
                            onClick={() => { if (item.action) item.action(); setActiveMenu(null); }}
                            className={`w-full flex items-center justify-between px-3 py-1.5 text-xs transition-colors ${item.disabled ? 'text-purple-500/35 cursor-not-allowed' : 'text-purple-200 hover:bg-fuchsia-500/15 hover:text-purple-50 cursor-pointer'}`}
                          >
                            <span className="flex items-center gap-2.5">
                              {item.icon ? <item.icon size={13} className="text-fuchsia-400/70 shrink-0" /> : <span className="w-[13px] shrink-0" />}
                              {item.label}
                            </span>
                            {item.shortcut && <span className="text-[10px] text-purple-500/55 ml-4 shrink-0 font-mono">{item.shortcut}</span>}
                          </button>
                        )
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <OpfsToggle onNotify={(n) => toast?.[n.kind === 'error' ? 'error' : 'info']?.(n.message)} />
          <button
            onClick={() => setRightSidebarOpen(!rightSidebarOpen)}
            className={`p-2 sm:p-1.5 rounded-md transition-colors ${rightSidebarOpen ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'hover:bg-[#25104a] text-purple-300'}`}
            aria-label="Toggle AI Chat"
          >
            {sm ? <MessageSquare size={18} /> : <Layout size={18} />}
          </button>
        </div>
      </header>

      {/* ── Main Workspace ────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Skeleton shown while OPFS is still initialising / migrating.
            Blocks the Explorer + Editor so the user can't mutate a ghost
            state that would then race with the on-disk tree load. */}
        {!fsReady && fsMode === 'opfs-pending' && (
          <div
            role="status"
            aria-live="polite"
            aria-label="Loading workspace from advanced storage"
            className="absolute inset-0 z-40 flex items-center justify-center bg-[#0a0412]/90 backdrop-blur-sm"
          >
            <div className="flex flex-col items-center gap-3 px-6 py-5 rounded-xl border border-fuchsia-500/20 bg-[#15092a]/80">
              <Loader2 size={22} className="animate-spin text-fuchsia-300" />
              <div className="text-xs text-fuchsia-100 font-semibold">Initialising advanced storage…</div>
              <div className="text-[11px] text-purple-300/70 max-w-xs text-center leading-relaxed">
                Migrating your workspace into the browser's persistent filesystem. This runs once.
              </div>
            </div>
          </div>
        )}

        {/* Left Sidebar */}
        {sidebarOpen && (
          <>
            {sm && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
            <aside className="absolute md:relative z-10 h-full bg-[#15092a] border-r border-fuchsia-500/20 flex flex-col shrink-0 panel-transition" style={{ width: sm ? Math.min(leftWidth, screenWidth * 0.85) : leftWidth }} aria-label="File explorer">
              {!sm && <div className="absolute top-0 -right-[2px] w-1.5 h-full cursor-col-resize drag-handle hover:bg-fuchsia-400/50 active:bg-fuchsia-400 z-20 transition-colors" onMouseDown={(e) => { e.preventDefault(); setIsDragging('left'); }} onTouchStart={(e) => { e.preventDefault(); setIsDragging('left'); }} />}
              <PanelErrorBoundary scope="Explorer">
                <FileExplorer
                  fileSystem={fileSystem}
                  activeFile={activeFile}
                  projectName={projectName}
                  onFileClick={handleFileClick}
                  onCreateFile={handleCreateFileAt}
                  onDeleteFile={handleDeleteFile}
                  onRenameFile={handleRenameFile}
                  onMoveFile={handleMoveFile}
                  onDropFiles={handleExplorerDropFiles}
                  onProjectRename={setProjectName}
                  onImport={handleImportProject}
                  onExport={handleExportProject}
                  onNewProjectTemplate={(template) => setNewProjectDialog({ template })}
                />
              </PanelErrorBoundary>
            </aside>
          </>
        )}

        {/* Middle Column */}
        <main className="flex-1 flex flex-col min-w-0 bg-[#0a0412]">
          <div className="flex-1 flex flex-col min-h-0">
            {/* Editor Tabs */}
            <div className="flex bg-[#15092a] overflow-x-auto no-scrollbar border-b border-fuchsia-500/20 shrink-0">
              {openTabs.map(path => {
                const isActive = activeFile === path;
                const file = fileSystem[path];
                if (!file) return null;
                return (
                  <div
                    key={path}
                    onClick={() => setActiveFile(path)}
                    className={`flex items-center gap-2 px-4 py-2 border-r border-fuchsia-500/20 min-w-max cursor-pointer transition-colors group ${isActive ? 'bg-[#0a0412] border-t-2 border-t-cyan-400 text-fuchsia-50 shadow-[0_-2px_10px_rgba(34,211,238,0.1)]' : 'text-purple-400/70 hover:bg-[#25104a] hover:text-purple-200 border-t-2 border-t-transparent'}`}
                  >
                    <File size={13} className={isActive ? 'text-cyan-400' : 'text-fuchsia-400/50'} />
                    <span className="text-xs">{file.name}</span>
                    <X size={13} onClick={(e) => handleCloseTab(path, e)} className="ml-1 text-purple-400/30 hover:text-fuchsia-300 opacity-0 group-hover:opacity-100 transition-all cursor-pointer" />
                  </div>
                );
              })}
              <div className="flex-1 flex justify-end items-center px-2 gap-1">
                <button onClick={handleNewFile} className="p-1 hover:bg-[#25104a] rounded text-purple-400/70 transition-colors" title="New file"><Plus size={14}/></button>
                <button
                  onClick={() => { setTerminalState('open'); setActiveTerminalTab('preview'); }}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${activeTerminalTab === 'preview' && terminalState === 'open' ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'text-purple-400/60 hover:text-purple-200 hover:bg-[#25104a]'}`}
                  title="Open Live Preview panel"
                >
                  <MonitorPlay size={13}/> {!sm && <span>Preview</span>}
                </button>
              </div>
            </div>

            {/* Text Editor */}
            <div className="flex-1 flex overflow-hidden relative">
              {!activeFile || !fileSystem[activeFile] ? (
                <div className="flex-1 flex flex-col items-center justify-center text-purple-500/40 gap-4">
                  <Cpu size={48} className="text-fuchsia-400/20" />
                  <div className="text-lg font-semibold text-purple-300/30">EpiCodeSpace</div>
                  <div className="text-xs text-purple-500/30">Create or open a file to start coding</div>
                  <div className="flex gap-2 mt-2">
                    <button onClick={handleNewFile} className="text-xs text-purple-300 hover:text-purple-100 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-4 py-2 transition-colors flex items-center gap-2"><FilePlus size={12}/> New File</button>
                    <button onClick={() => handleNewProject('react')} className="text-xs text-purple-300 hover:text-purple-100 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-4 py-2 transition-colors">⚛️ React</button>
                    <button onClick={() => handleNewProject('node')} className="text-xs text-purple-300 hover:text-purple-100 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-4 py-2 transition-colors">🟢 Node</button>
                  </div>
                </div>
              ) : (
              <>
              {showFind && (
                <div className="absolute top-2 right-4 z-30 bg-[#1a0b35] border border-fuchsia-500/30 rounded-lg shadow-xl flex items-center gap-2 px-3 py-2">
                  <Search size={13} className="text-fuchsia-400 shrink-0" />
                  <input autoFocus type="text" value={findQuery} onChange={(e) => setFindQuery(e.target.value)} placeholder="Find..." className="bg-transparent text-purple-100 text-xs outline-none placeholder:text-purple-500/50 w-44" />
                  <span className="text-purple-500/50 text-[10px] min-w-[60px]">
                    {findQuery ? `${(fileSystem[activeFile]?.content ?? '').split(findQuery).length - 1} match(es)` : 'Type to search'}
                  </span>
                  <button onClick={() => { setShowFind(false); setFindQuery(''); }} className="text-purple-400/60 hover:text-fuchsia-300 transition-colors ml-1"><X size={13} /></button>
                </div>
              )}
              {(() => {
                const entry = fileSystem[activeFile];
                // ── Image file preview ────────────────────────────────────
                if (activeFile && isImageFile({ name: activeFile, type: entry?.mime || '' })) {
                  const src = entry?.dataUrl || (entry?.content && entry.content.startsWith('data:') ? entry.content : null);
                  return (
                    <div className="flex-1 flex flex-col items-center justify-center bg-[#0a0412] gap-3 p-6">
                      {src
                        ? <img src={src} alt={activeFile} className="max-w-full max-h-[70vh] rounded-lg border border-fuchsia-500/20 shadow-lg object-contain" />
                        : <div className="text-purple-500/50 text-xs font-mono">Binary image — no inline preview available.</div>
                      }
                      <span className="text-[11px] text-purple-400/60 font-mono">{activeFile}</span>
                    </div>
                  );
                }
                const fileBytes = entry?.size ?? (entry?.content?.length ?? 0);
                // Trust `isLarge` when the hook set it; otherwise compute at
                // render time from the content length so large content pasted
                // through the legacy setState path is still flagged.
                const isLarge = !!entry?.isLarge || fileBytes > MAX_INLINE_READ_BYTES;
                if (isLarge) {
                  const mb = (fileBytes / (1024 * 1024)).toFixed(2);
                  const ceilingMb = (MAX_INLINE_READ_BYTES / (1024 * 1024)).toFixed(0);
                  return (
                    <div className="flex-1 flex flex-col bg-[#0a0412]">
                      <div
                        role="alert"
                        className="flex items-start gap-3 px-4 py-3 border-b border-fuchsia-500/20 bg-gradient-to-r from-fuchsia-500/10 via-purple-500/5 to-transparent"
                      >
                        <AlertCircle size={16} className="text-fuchsia-300 shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold text-fuchsia-100">
                            Large file — inline editor disabled
                          </div>
                          <div className="text-[11px] text-purple-300/80 mt-0.5 leading-relaxed">
                            <span className="font-mono text-fuchsia-300">{entry?.name}</span> is{' '}
                            <span className="font-mono">{mb} MB</span>, above the{' '}
                            <span className="font-mono">{ceilingMb} MB</span> inline ceiling.
                            Editing this file in the editor would pin it in memory and risk a tab crash on iPad.
                            Use streamed reads (<span className="font-mono text-fuchsia-300">readLargeChunk</span>) or split the file into smaller modules.
                          </div>
                        </div>
                      </div>
                      <div className="flex-1 flex items-center justify-center text-purple-500/40 text-xs font-mono px-6 text-center">
                        Preview not rendered. This file stays on disk to protect main-thread memory.
                      </div>
                    </div>
                  );
                }
                return (
                  <Suspense fallback={
                    <div className="flex-1 flex items-center justify-center bg-[#0b1020] text-fuchsia-300/70 text-xs gap-2">
                      <Loader2 size={14} className="animate-spin" /> Loading editor…
                    </div>
                  }>
                    <CodeEditor
                      ref={editorRef}
                      path={activeFile}
                      value={entry?.content ?? ''}
                      onChange={(next) => patchFile(activeFile, next)}
                      onCursorChange={handleCursorMove}
                      fontSize={fontSize}
                      wordWrap={wordWrap}
                    />
                  </Suspense>
                );
              })()}
              </>
              )}
            </div>
          </div>

          {/* Terminal Pane */}
          {terminalState === 'open' && (
            <div className="border-t border-fuchsia-500/20 bg-[#0a0412] flex flex-col shrink-0 relative" style={{ height: sm ? Math.min(termHeight, window.innerHeight * 0.4) : termHeight }}>
              <div className="absolute top-0 left-0 w-full h-3 sm:h-1.5 -mt-[2px] cursor-row-resize drag-handle hover:bg-fuchsia-400/50 active:bg-fuchsia-400 z-20 transition-colors" onMouseDown={(e) => { e.preventDefault(); setIsDragging('terminal'); }} onTouchStart={(e) => { e.preventDefault(); setIsDragging('terminal'); }} />
              <div role="tablist" aria-label="Panel tabs" className="flex items-center px-2 sm:px-4 pt-2 gap-1 sm:gap-3 shrink-0 overflow-x-auto no-scrollbar">
                {[
                  { id: 'problems', label: 'PROBLEMS', badge: allProblems.length > 0 ? allProblems.length : null },
                  { id: 'output', label: 'OUTPUT' },
                  { id: 'terminal', label: 'TERMINAL' },
                  { id: 'runtime', label: 'RUNTIME' },
                  { id: 'preview', label: 'PREVIEW' },
                  { id: 'debug', label: 'DEBUG CONSOLE' },
                  { id: 'ports', label: 'PORTS', badge: ports.filter(p => p.state === 'running').length || null },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    role="tab"
                    aria-selected={activeTerminalTab === tab.id}
                    aria-controls={`panel-${tab.id}`}
                    id={`tab-${tab.id}`}
                    tabIndex={activeTerminalTab === tab.id ? 0 : -1}
                    onClick={() => setActiveTerminalTab(tab.id)}
                    onKeyDown={(e) => {
                      const ids = ['problems','output','terminal','runtime','preview','debug','ports'];
                      const cur = ids.indexOf(activeTerminalTab);
                      if (e.key === 'ArrowRight') { e.preventDefault(); setActiveTerminalTab(ids[(cur + 1) % ids.length]); }
                      else if (e.key === 'ArrowLeft') { e.preventDefault(); setActiveTerminalTab(ids[(cur - 1 + ids.length) % ids.length]); }
                      else if (e.key === 'Home') { e.preventDefault(); setActiveTerminalTab(ids[0]); }
                      else if (e.key === 'End') { e.preventDefault(); setActiveTerminalTab(ids[ids.length - 1]); }
                    }}
                    className={`text-[11px] font-semibold tracking-wider pb-2 border-b-2 transition-colors whitespace-nowrap px-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400/60 rounded-sm ${activeTerminalTab === tab.id ? 'border-cyan-400 text-cyan-50 drop-shadow-[0_0_5px_rgba(34,211,238,0.5)]' : 'border-transparent text-purple-400/60 hover:text-purple-200'}`}
                  >
                    {tab.label}
                    {tab.badge && <span className="ml-1.5 bg-fuchsia-500/20 text-fuchsia-300 px-1.5 rounded-full text-[10px]">{tab.badge}</span>}
                  </button>
                ))}
                <div className="flex-1 flex justify-end gap-2 pb-2">
                  <button className="p-1 hover:bg-[#25104a] rounded text-purple-400/60 transition-colors"><Plus size={14} /></button>
                  <button className="p-1 hover:bg-[#25104a] rounded text-purple-400/60 transition-colors" onClick={() => setTerminalState('closed')}><X size={14} /></button>
                </div>
              </div>

              {activeTerminalTab === 'terminal' && (
                <div className="flex-1 overflow-y-auto font-mono text-[13px] flex flex-col" role="log" aria-live="polite" aria-label="Terminal output">
                  {/* Output area — user-select:text so touch-drag selects + copies on iPadOS.
                      `fake-terminal-output` overrides the global `.no-callout` rule so the
                      iOS Copy/Share callout appears after a long-press selection. */}
                  <div
                    className="fake-terminal-output flex-1 p-3 select-text cursor-text"
                    style={{ userSelect: 'text', WebkitUserSelect: 'text', WebkitTouchCallout: 'default' }}
                    onMouseUp={(e) => {
                      const sel = window.getSelection()?.toString();
                      if (!sel) {
                        termInputRef.current?.focus();
                      }
                    }}
                    onContextMenu={(e) => {
                      const sel = window.getSelection()?.toString();
                      if (sel) {
                        e.preventDefault();
                        setChatInput(prev => (prev ? prev + '\n\n' : '') + '```\n' + sel.trim() + '\n```');
                        // switch focus to chat once pasted
                        setTimeout(() => editorRef.current?.focus?.(), 50);
                      }
                    }}
                  >
                    {terminalLines.map((line, i) => (
                      <div key={i} className={`break-all leading-relaxed whitespace-pre-wrap ${
                        line.startsWith('✓') || line.startsWith('Done') ? 'text-green-400' :
                        line.startsWith('bash:') || line.startsWith('Error') || line.startsWith('fatal') ? 'text-red-400' :
                        line.startsWith('  ➜') ? 'text-cyan-400' :
                        line.startsWith('ubuntu@') ? 'text-cyan-400 font-semibold' :
                        'text-purple-200'
                      }`}>{line}</div>
                    ))}
                  </div>
                  <form onSubmit={(e) => { e.preventDefault(); if (!terminalInput.trim()) return; handleTerminalCommand(terminalInput.trim()); setTerminalInput(''); }} className="flex items-start px-3 pb-3 mt-1">
                    <span className="text-cyan-400 mr-2 shrink-0 font-semibold drop-shadow-[0_0_2px_rgba(34,211,238,0.8)]">ubuntu@epicode:~/workspace (main) $</span>
                    <input ref={termInputRef} type="text" value={terminalInput} onChange={(e) => setTerminalInput(e.target.value.toLowerCase())} aria-label="Terminal input" className="terminal-input flex-1 bg-transparent border-none outline-none text-purple-100 focus:ring-0 focus:outline-none p-0 caret-fuchsia-500" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck="false" autoFocus />
                  </form>
                </div>
              )}

              {activeTerminalTab === 'problems' && (
                <div className="flex-1 p-3 overflow-y-auto font-mono text-[12px]">
                  {allProblems.length === 0 ? (
                    <div className="text-purple-500/50 flex items-center gap-2 mt-2"><CheckCircle2 size={13} className="text-green-400"/> No problems detected.</div>
                  ) : allProblems.map((p, i) => (
                    <div key={i} onClick={() => handleFileClick(p.file)} className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-[#25104a] cursor-pointer group">
                      <AlertCircle size={12} className={`mt-0.5 shrink-0 ${p.severity === 'error' ? 'text-red-400' : p.severity === 'warning' ? 'text-yellow-400' : 'text-cyan-400'}`}/>
                      <div className="flex-1">
                        <span className="text-purple-200">{p.msg}</span>
                        <span className="text-purple-500/60 ml-2">{p.file}:{p.line}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeTerminalTab === 'output' && (
                <div className="flex-1 p-3 overflow-y-auto font-mono text-[12px]">
                  {outputLog.length === 0 ? (
                    <div className="text-purple-500/50">No output yet. Run a build task to see output here.</div>
                  ) : outputLog.map((line, i) => (
                    <div key={i} className={`leading-relaxed ${line.startsWith('✓') ? 'text-green-400' : line.startsWith('Error') ? 'text-red-400' : line.startsWith('dist/') ? 'text-cyan-300' : 'text-purple-300'}`}>{line || '\u00a0'}</div>
                  ))}
                </div>
              )}

              {/* Runtime stays mounted across tab switches so xterm,
                  the WebContainer process, and LSP connection survive.
                  Hidden via CSS when another tab is active. */}
              <div
                className={`flex-1 min-h-0 ${activeTerminalTab === 'runtime' ? 'flex flex-col' : 'hidden'}`}
                aria-hidden={activeTerminalTab !== 'runtime'}
              >
                <Suspense fallback={<div className="p-3 text-xs text-purple-400/60">Loading runtime…</div>}>
                  <WebContainerTerminal
                    files={fileSystem}
                    sink={{ writeFile, getLatest: () => fileSystem }}
                    onServerUrl={(url) => setPreviewUrl(url)}
                  />
                </Suspense>
              </div>

              {activeTerminalTab === 'debug' && (
                <div className="flex-1 flex flex-col overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-fuchsia-500/10 bg-[#0f0620]">
                    <select className="bg-[#1a0b35] border border-fuchsia-500/20 text-purple-200 text-[11px] rounded px-2 py-1 outline-none">
                      <option>Node.js (default)</option>
                      <option>Chrome DevTools</option>
                    </select>
                    <div className="flex gap-1 ml-auto">
                      <button onClick={() => { setDebugConsoleLines(prev => [...prev, { type: 'info', text: `\u25b6 Debugger attached to pid ${Math.floor(1000 + Math.random() * 9000)}`, ts: Date.now() }]); }} className="p-1 hover:bg-[#25104a] rounded text-green-400/60 hover:text-green-400" title="Start"><Play size={13}/></button>
                      <button className="p-1 hover:bg-[#25104a] rounded text-red-400/60 hover:text-red-400" title="Stop"><Square size={13}/></button>
                      <button onClick={() => setDebugConsoleLines([{ type: 'info', text: 'Debug console cleared.', ts: Date.now() }])} className="p-1 hover:bg-[#25104a] rounded text-purple-400/60 hover:text-purple-200" title="Clear"><Trash2 size={13}/></button>
                    </div>
                  </div>
                  <div className="flex-1 p-3 overflow-y-auto font-mono text-[12px] space-y-0.5">
                    {debugConsoleLines.map((entry, i) => (
                      <div key={i} className={`flex items-start gap-2 py-0.5 ${entry.type === 'error' ? 'text-red-400' : entry.type === 'warn' ? 'text-yellow-400' : entry.type === 'info' ? 'text-cyan-300' : 'text-purple-200'}`}>
                        <span className="text-purple-500/30 text-[10px] shrink-0 w-16">{new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                        <span className={`text-[10px] shrink-0 w-10 uppercase font-semibold ${entry.type === 'error' ? 'text-red-400/70' : entry.type === 'warn' ? 'text-yellow-400/70' : 'text-cyan-400/70'}`}>{entry.type}</span>
                        <span className="break-all">{entry.text}</span>
                      </div>
                    ))}
                  </div>
                  <form onSubmit={(e) => {
                    e.preventDefault();
                    const input = e.target.elements.debugInput;
                    const expr = input.value.trim();
                    if (!expr) return;
                    setDebugConsoleLines(prev => [...prev, { type: 'log', text: `> ${expr}`, ts: Date.now() }]);
                    try {
                      const safeResult = expr === 'process.env' ? '{ NODE_ENV: "development" }'
                        : expr.startsWith('console.') ? 'undefined'
                        : expr === 'window.location' ? '{ href: "https://epicodespace.vercel.app" }'
                        : expr.match(/^\d[\d+\-*/. ()]*$/) ? String(Function('"use strict"; return (' + expr + ')')()) // safe math only
                        : `"${expr}"`;
                      setDebugConsoleLines(prev => [...prev, { type: 'info', text: safeResult, ts: Date.now() }]);
                    } catch {
                      setDebugConsoleLines(prev => [...prev, { type: 'error', text: `ReferenceError: ${expr} is not defined`, ts: Date.now() }]);
                    }
                    input.value = '';
                  }} className="flex items-center px-3 py-2 border-t border-fuchsia-500/10 gap-2">
                    <span className="text-cyan-400 text-[11px] font-mono shrink-0">&gt;</span>
                    <input name="debugInput" type="text" placeholder="Evaluate expression..." className="flex-1 bg-transparent border-none outline-none text-purple-100 text-[12px] font-mono caret-fuchsia-500" autoComplete="off" spellCheck="false" />
                  </form>
                </div>
              )}

              {/* ── Live Preview Panel ─────────────────────────────────────── */}
              {activeTerminalTab === 'preview' && (
                <div className={previewFullscreen ? 'fixed inset-0 z-[200] flex flex-col' : 'flex-1 flex flex-col overflow-hidden'}>
                  {/* Preview toolbar */}
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-fuchsia-500/10 bg-[#0f0620] shrink-0">
                    <div className="flex-1 flex items-center gap-2 bg-[#1a0b35] rounded px-3 py-1 text-[11px] text-purple-300/50 border border-fuchsia-500/10 min-w-0">
                      <Globe size={11} className="text-fuchsia-400/60 shrink-0" />
                      <span className="truncate">
                        {previewDoc ? `Preview — ${Object.entries(fileSystem).find(([k]) => k.endsWith('.html'))?.[0] || 'index.html'}` : 'No HTML file found in workspace'}
                      </span>
                    </div>
                    <button
                      onClick={() => setPreviewKey(k => k + 1)}
                      className="p-1.5 hover:bg-[#25104a] rounded text-purple-400/60 hover:text-purple-200 transition-colors"
                      title="Refresh preview (re-inlines CSS + JS)"
                    >
                      <RotateCcw size={13} />
                    </button>
                    <button
                      onClick={() => { setTerminalState('open'); setActiveTerminalTab('terminal'); handleTerminalCommand('npm run dev'); }}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-green-400/70 hover:text-green-300 hover:bg-green-500/10 border border-green-500/20 transition-colors"
                      title="Start Vite dev server on port 5173"
                    >
                      <Play size={11} /> Dev
                    </button>
                    <button
                      onClick={openPreviewTab}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-cyan-400/70 hover:text-cyan-300 hover:bg-cyan-500/10 border border-cyan-500/20 transition-colors"
                      title="Open preview in a new browser tab (no server required)"
                    >
                      <ExternalLink size={11} /> Open Tab
                    </button>
                  </div>

                  {/* Preview content */}
                  {previewDoc ? (
                    <iframe
                      key={previewKey}
                      srcDoc={previewDoc}
                      className="flex-1 w-full border-none"
                      style={{ background: '#fff' }}
                      /* Amendment #2 — security: dropped `allow-same-origin` so preview scripts
                         cannot read parent storage/cookies even though srcdoc shares origin.
                         `referrerpolicy` prevents leaking the parent URL. */
                      sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-top-navigation-by-user-activation"
                      referrerPolicy="no-referrer"
                      title="EpiCodeSpace Live Preview"
                    />
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center gap-4 text-purple-500/40 p-6">
                      <MonitorPlay size={48} className="text-fuchsia-400/20" />
                      <div className="text-sm font-semibold text-purple-300/40">No HTML file to preview</div>
                      <div className="text-[11px] text-center max-w-xs text-purple-500/30 leading-relaxed">
                        Add an <code className="text-fuchsia-400/50">index.html</code> to your workspace for
                        inline preview. CSS and JS from other files are automatically inlined.
                      </div>
                      <button
                        onClick={openPreviewTab}
                        className="flex items-center gap-2 text-[12px] text-cyan-400 hover:text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 rounded-lg px-4 py-2 transition-colors"
                      >
                        <ExternalLink size={13} /> Open Preview in New Tab
                      </button>
                      {false && <button
                        onClick={() => { const port = ports.find(p => p.state === 'running')?.port || 5173; window.open(`http://localhost:${port}`, '_blank', 'noopener,noreferrer'); }}
                        className="flex items-center gap-2 text-[12px] text-cyan-400 hover:text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 rounded-lg px-4 py-2 transition-colors"
                      >
                        <ExternalLink size={13} /> Open localhost:5173
                      </button>}
                    </div>
                  )}
                </div>
              )}

              {activeTerminalTab === 'ports' && (
                <div className="flex-1 p-3 overflow-y-auto font-mono text-[12px]">
                  <div className="flex items-center gap-2 mb-3 justify-between">
                    <span className="text-purple-400/60 text-[11px] uppercase tracking-wider font-semibold">Forwarded Ports</span>
                    <button onClick={() => setPorts(prev => [...prev, { port: 3000 + Math.floor(Math.random() * 5000), protocol: 'https', state: 'running', label: 'New Service', visibility: 'private', pid: Math.floor(1000 + Math.random() * 9000) }])} className="text-[10px] text-purple-400/60 hover:text-purple-200 bg-white/5 hover:bg-white/10 px-2 py-1 rounded transition-colors flex items-center gap-1"><Plus size={11}/> Add Port</button>
                  </div>
                  {ports.length === 0 ? (
                    <div className="text-purple-500/50 flex items-center gap-2 mt-4"><Globe size={14}/> No forwarded ports. Run a server to see ports here.</div>
                  ) : (
                    <table className="w-full text-left">
                      <thead>
                        <tr className="text-purple-500/50 text-[10px] uppercase border-b border-fuchsia-500/10">
                          <th className="py-1.5 px-2 font-semibold">Port</th>
                          <th className="py-1.5 px-2 font-semibold">Protocol</th>
                          <th className="py-1.5 px-2 font-semibold hidden sm:table-cell">Label</th>
                          <th className="py-1.5 px-2 font-semibold">Visibility</th>
                          <th className="py-1.5 px-2 font-semibold">Status</th>
                          <th className="py-1.5 px-2 font-semibold w-20"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {ports.map((p, i) => (
                          <tr key={i} className="hover:bg-[#25104a] transition-colors border-b border-fuchsia-500/5 group">
                            <td className="py-2 px-2">
                              <button
                                onClick={openPreviewTab}
                                className="text-cyan-300 font-semibold hover:text-cyan-100 hover:underline transition-colors flex items-center gap-1"
                                title="Open preview in a new browser tab"
                              >
                                {p.port} <ExternalLink size={9} className="opacity-50" />
                              </button>
                            </td>
                            <td className="py-2 px-2 text-purple-300/70">{p.protocol}</td>
                            <td className="py-2 px-2 text-purple-200 hidden sm:table-cell">{p.label}</td>
                            <td className="py-2 px-2">
                              <button onClick={() => setPorts(prev => prev.map((pp, pi) => pi === i ? { ...pp, visibility: pp.visibility === 'private' ? 'public' : 'private' } : pp))} className={`text-[10px] px-2 py-0.5 rounded-full border ${p.visibility === 'public' ? 'border-green-500/30 text-green-400 bg-green-500/10' : 'border-yellow-500/30 text-yellow-400 bg-yellow-500/10'}`}>
                                {p.visibility}
                              </button>
                            </td>
                            <td className="py-2 px-2">
                              <span className={`flex items-center gap-1.5 ${p.state === 'running' ? 'text-green-400' : 'text-red-400'}`}>
                                {p.state === 'running' ? <Wifi size={11}/> : <WifiOff size={11}/>}
                                {p.state}
                              </span>
                            </td>
                            <td className="py-2 px-2">
                              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button onClick={() => setPorts(prev => prev.map((pp, pi) => pi === i ? { ...pp, state: pp.state === 'running' ? 'stopped' : 'running' } : pp))} className="p-1 hover:bg-white/10 rounded text-purple-400/60" title={p.state === 'running' ? 'Stop' : 'Start'}>
                                  {p.state === 'running' ? <Square size={11}/> : <Play size={11}/>}
                                </button>
                                <button onClick={() => setPorts(prev => prev.filter((_, pi) => pi !== i))} className="p-1 hover:bg-white/10 rounded text-red-400/60" title="Remove">
                                  <Trash2 size={11}/>
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          )}
        </main>

        {/* Right Sidebar (AI Chat) */}
        {rightSidebarOpen && (
          <>
            {sm && <div className="sidebar-backdrop" onClick={() => setRightSidebarOpen(false)} />}
            <aside className={`${sm ? 'fixed inset-0 z-20' : 'relative'} border-l border-fuchsia-500/20 bg-[#15092a] flex flex-col shrink-0 shadow-[-4px_0_20px_rgba(192,38,211,0.03)] panel-transition overflow-hidden`} style={sm ? {} : { width: rightWidth }}>
              {!sm && <div className="absolute top-0 -left-[2px] w-1.5 h-full cursor-col-resize drag-handle hover:bg-fuchsia-400/50 active:bg-fuchsia-400 z-20 transition-colors" onMouseDown={(e) => { e.preventDefault(); setIsDragging('right'); }} onTouchStart={(e) => { e.preventDefault(); setIsDragging('right'); }} />}

            {/* Chat Header */}
            <div className="flex justify-between items-center px-3 sm:px-4 py-2.5 sm:py-2 border-b border-fuchsia-500/20 shrink-0" style={sm ? { paddingTop: 'max(0.625rem, var(--sat))' } : {}}>
              <span className="text-[11px] font-bold text-purple-200 uppercase tracking-widest flex items-center gap-2">
                <MessageSquare size={14} className="text-fuchsia-400"/> CHAT
                <span className={`text-[9px] font-normal px-1.5 py-0.5 rounded-full ${AGENT_REGISTRY[activeAgent]?.color || 'text-fuchsia-400'} bg-white/5 border border-white/10`}>
                  {AGENT_REGISTRY[activeAgent]?.name || 'Agent'}
                </span>
              </span>
              <div className="flex gap-1 text-purple-400/60">
                <button onClick={handleNewConversation} className="p-1.5 sm:p-1 hover:text-purple-200 hover:bg-[#25104a] rounded transition-colors" title="New conversation"><Plus size={14} /></button>
                <button onClick={() => setShowConversations(p => !p)} className="p-1.5 sm:p-1 hover:text-purple-200 hover:bg-[#25104a] rounded transition-colors" title="Conversations"><MessageSquare size={14} /></button>
                <button className="p-1.5 sm:p-1 hover:text-purple-200 hover:bg-[#25104a] rounded transition-colors"><Settings size={14} /></button>
                <button className="p-1.5 sm:p-1 hover:text-purple-200 hover:bg-[#25104a] rounded transition-colors" onClick={() => setRightSidebarOpen(false)}><X size={14} /></button>
              </div>
            </div>

            {/* Mode Switcher (Ask / Agent / Plan) */}
            <div className="flex items-center border-b border-fuchsia-500/20 bg-[#0f0620] shrink-0">
              {[
                { id: 'ask', label: 'Ask', icon: HelpCircle, desc: 'Q&A chat' },
                { id: 'agent', label: 'Agent', icon: Zap, desc: 'Builds & edits files' },
                { id: 'plan', label: 'Plan', icon: ListChecks, desc: 'Plan then execute' },
              ].map(m => (
                <button
                  key={m.id}
                  onClick={() => setChatMode(m.id)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-semibold transition-all border-b-2 ${chatMode === m.id ? 'border-fuchsia-400 text-fuchsia-300 bg-fuchsia-500/5' : 'border-transparent text-purple-400/50 hover:text-purple-300 hover:bg-white/5'}`}
                  title={m.desc}
                >
                  <m.icon size={13} />
                  {m.label}
                </button>
              ))}
            </div>

            {/* Conversation History Panel */}
            {showConversations && (
              <div className="absolute inset-0 z-30 flex flex-col bg-[#0f0620] border-r border-fuchsia-500/20" style={{ top: 0 }}>
                {/* Panel header */}
                <div className="flex items-center justify-between px-3 py-2.5 border-b border-fuchsia-500/20 shrink-0">
                  <span className="text-[11px] font-bold text-purple-200 uppercase tracking-widest flex items-center gap-2">
                    <MessageSquare size={13} className="text-fuchsia-400"/> Chat History
                  </span>
                  <div className="flex gap-1">
                    <button
                      onClick={handleNewConversation}
                      className="flex items-center gap-1 px-2 py-1 text-[10px] text-fuchsia-300 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 border border-fuchsia-500/20 rounded transition-colors"
                      title="New chat"
                    >
                      <Plus size={11}/> New
                    </button>
                    <button onClick={() => setShowConversations(false)} className="p-1 hover:bg-[#25104a] rounded text-purple-400/60 hover:text-purple-200 transition-colors"><X size={13}/></button>
                  </div>
                </div>
                {/* Search */}
                <div className="px-3 py-2 border-b border-fuchsia-500/10 shrink-0">
                  <div className="flex items-center gap-2 bg-[#1a0b35] border border-fuchsia-500/20 rounded-md px-2 py-1">
                    <Search size={11} className="text-purple-500/60 shrink-0"/>
                    <input
                      type="text"
                      value={convoSearch}
                      onChange={e => setConvoSearch(e.target.value)}
                      placeholder="Search chats..."
                      className="flex-1 bg-transparent text-[11px] text-purple-100 outline-none placeholder:text-purple-500/40"
                    />
                    {convoSearch && <button onClick={() => setConvoSearch('')} className="text-purple-500/60 hover:text-purple-300"><X size={10}/></button>}
                  </div>
                </div>
                {/* List */}
                <div className="flex-1 overflow-y-auto py-1">
                  {(() => {
                    const q = convoSearch.toLowerCase();
                    const filtered = [...conversations]
                      .sort((a, b) => (b.lastOpenedAt || b.createdAt || 0) - (a.lastOpenedAt || a.createdAt || 0))
                      .filter(c => !q || c.name.toLowerCase().includes(q) || c.messages.some(m => m.content?.toLowerCase().includes(q)));
                    if (filtered.length === 0) return (
                      <div className="text-center py-6 text-[11px] text-purple-500/40">No chats found</div>
                    );
                    return filtered.map(c => {
                      const isActive = c.id === activeConvoId;
                      const lastMsg = c.messages.filter(m => m.role === 'user').slice(-1)[0];
                      const ts = c.lastOpenedAt || c.createdAt;
                      const dateStr = ts ? new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
                      const timeStr = ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                      return (
                        <div
                          key={c.id}
                          className={`group relative flex flex-col px-3 py-2.5 border-b border-fuchsia-500/5 cursor-pointer transition-colors ${isActive ? 'bg-fuchsia-500/10' : 'hover:bg-[#1a0b35]'}`}
                          onClick={() => { if (renamingConvo !== c.id) handleSwitchConversation(c.id); }}
                        >
                          {/* Title row */}
                          <div className="flex items-center gap-2 min-w-0">
                            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-fuchsia-400' : 'bg-purple-600/40'}`}/>
                            {renamingConvo === c.id ? (
                              <form
                                onSubmit={e => { e.preventDefault(); handleRenameConvo(c.id, renameConvoValue); }}
                                onClick={e => e.stopPropagation()}
                                className="flex-1 flex gap-1"
                              >
                                <input
                                  autoFocus
                                  value={renameConvoValue}
                                  onChange={e => setRenameConvoValue(e.target.value)}
                                  onBlur={() => handleRenameConvo(c.id, renameConvoValue || c.name)}
                                  onKeyDown={e => { if (e.key === 'Escape') { setRenamingConvo(null); setRenameConvoValue(''); } }}
                                  className="flex-1 bg-[#25104a] border border-fuchsia-500/40 rounded px-1.5 py-0.5 text-[11px] text-purple-100 outline-none"
                                />
                                <button type="submit" className="text-[9px] text-fuchsia-300 hover:text-fuchsia-100 px-1">✓</button>
                              </form>
                            ) : (
                              <span className={`flex-1 text-[12px] font-medium truncate ${isActive ? 'text-fuchsia-200' : 'text-purple-200'}`}>{c.name}</span>
                            )}
                            {/* Action buttons — show on hover */}
                            {renamingConvo !== c.id && (
                              <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" onClick={e => e.stopPropagation()}>
                                <button
                                  title="Rename"
                                  onClick={() => { setRenamingConvo(c.id); setRenameConvoValue(c.name); }}
                                  className="p-1 text-purple-500/60 hover:text-purple-200 hover:bg-[#25104a] rounded transition-colors"
                                ><FileEdit size={10}/></button>
                                <button
                                  title="Delete"
                                  onClick={async () => { if (await toast.confirm(`Delete "${c.name}"?`, { danger: true, confirmLabel: 'Delete' })) handleDeleteConvo(c.id); }}
                                  className="p-1 text-purple-500/60 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                                ><Trash2 size={10}/></button>
                              </div>
                            )}
                          </div>
                          {/* Preview row */}
                          <div className="flex items-center gap-2 mt-0.5 pl-3.5">
                            {lastMsg && (
                              <span className="flex-1 text-[10px] text-purple-500/50 truncate">{lastMsg.content.slice(0, 50)}</span>
                            )}
                            <span className={`text-[9px] shrink-0 ${AGENT_REGISTRY[c.agent]?.color || 'text-fuchsia-400'}`}>{AGENT_REGISTRY[c.agent]?.name || c.agent}</span>
                          </div>
                          <div className="flex items-center gap-2 pl-3.5 mt-0.5">
                            <span className="text-[9px] text-purple-600/40">{c.messages.length} msg{c.messages.length !== 1 ? 's' : ''}</span>
                            {dateStr && <span className="text-[9px] text-purple-600/40">{dateStr} {timeStr}</span>}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            )}

            {/* Chat Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-5 font-sans text-[13px] bg-gradient-to-b from-[#15092a] to-[#0a0412]" role="log" aria-live="polite" aria-label="Chat history">
              {messages.length === 0 && (
                <div className="text-center pt-8 space-y-4">
                  <div className="flex justify-center">
                    <div className={`p-3 rounded-xl bg-white/5 border border-white/10 ${AGENT_REGISTRY[activeAgent]?.color}`}>
                      <Sparkles size={24} />
                    </div>
                  </div>
                  <div>
                    <h3 className="text-purple-200 font-semibold text-sm">{AGENT_REGISTRY[activeAgent]?.name}</h3>
                    <p className="text-purple-400/60 text-xs mt-1">{AGENT_REGISTRY[activeAgent]?.description}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5 justify-center mt-4">
                    {(AGENT_REGISTRY[activeAgent]?.capabilities || []).map(cap => (
                      <span key={cap} className="text-[9px] px-2 py-1 rounded-full bg-fuchsia-500/10 text-fuchsia-300/70 border border-fuchsia-500/20">
                        {cap.replace('_', ' ')}
                      </span>
                    ))}
                  </div>
                  <div className="space-y-2 pt-4">
                    <p className="text-[10px] text-purple-500/60 uppercase tracking-wider">Try asking</p>
                    {['Explain this file', 'Review my code', 'Generate a test', 'Find all TODOs'].map(q => (
                      <button key={q} onClick={() => { setChatInput(q); }} className="block mx-auto text-xs text-purple-300/60 hover:text-purple-200 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-3 py-1.5 transition-colors">
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.filter(msg => !msg._progress).map((msg, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 text-purple-400/80 text-[11px] font-semibold uppercase tracking-wider mb-0.5">
                    {msg.role === 'user'
                      ? <><Terminal size={12} /> You</>
                      : <><Sparkles size={12} className={AGENT_REGISTRY[msg.agent]?.color || 'text-fuchsia-400'} /> {msg.agentName || AGENT_REGISTRY[msg.agent]?.name || 'Agent'}</>
                    }
                    {msg.timestamp && <span className="text-[9px] text-purple-500/40 font-normal normal-case ml-auto">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
                  </div>
                  {/* GitHub-Copilot-style thinking block */}
                  {msg.role === 'assistant' && (msg.steps?.length > 0 || msg.toolCalls?.length > 0) && (
                    <ThinkingBlock
                      steps={msg.steps || []}
                      toolCalls={msg.toolCalls || []}
                      inProgress={!!msg._progress}
                      mode={msg.mode}
                    />
                  )}
                  <div className={`rounded-xl px-4 py-3 ${msg.role === 'user' ? 'bg-[#1f0e40] border border-purple-500/30 text-purple-100 shadow-md' : 'bg-transparent border border-fuchsia-500/20 text-purple-200'} text-[13px]`}>
                    {msg.imageDataUrl && (
                      <img src={msg.imageDataUrl} className="max-w-xs rounded-md mb-2" alt="Uploaded preview" />
                    )}
                    {(() => {
                      const c = msg.content || '';
                      if (/^data:image\/[a-z+]+;base64,/.test(c.trim())) {
                        return <img src={c.trim()} className="max-w-xs rounded-md" alt="Uploaded preview" />;
                      }
                      return (
                        <Suspense fallback={<div className="text-[11px] text-purple-500/50">Loading…</div>}>
                          <MarkdownContent content={c} />
                        </Suspense>
                      );
                    })()}
                  </div>
                  {/* Extracted TODOs from assistant messages */}
                  {msg.role === 'assistant' && msg.content && (() => {
                    const todoLines = msg.content.split('\n').filter(l => /^[-*]\s*\[[ x]\]/i.test(l.trim()) || /^\d+\.\s/.test(l.trim()));
                    if (todoLines.length === 0) return null;
                    const msgTodos = todoLines.map(l => l.replace(/^[-*]\s*\[[ x]\]\s*/i, '').replace(/^\d+\.\s*/, '').trim()).filter(t => t.length > 3);
                    if (msgTodos.length === 0) return null;
                    const alreadyAdded = chatTodos.map(t => t.text);
                    const newOnes = msgTodos.filter(t => !alreadyAdded.includes(t));
                    if (newOnes.length === 0 && msgTodos.every(t => alreadyAdded.includes(t))) return null;
                    return (
                      <div className="mt-2 bg-fuchsia-500/5 border border-fuchsia-500/20 rounded-lg p-2.5 space-y-1.5">
                        <div className="text-[10px] text-fuchsia-300/70 uppercase tracking-wider font-semibold flex items-center gap-1.5">
                          <ListChecks size={11}/> Tasks detected ({msgTodos.length})
                        </div>
                        {msgTodos.map((todo, ti) => {
                          const exists = alreadyAdded.includes(todo);
                          return (
                            <div key={ti} className="flex items-start gap-2 text-[11px] text-purple-200/80 py-0.5">
                              <span className="shrink-0 mt-0.5 text-fuchsia-400/50">•</span>
                              <span className="flex-1">{todo}</span>
                              {exists ? (
                                <span className="text-[9px] text-green-400/60 shrink-0">added</span>
                              ) : (
                                <button onClick={() => setChatTodos(prev => [...prev, { id: Date.now() + ti, text: todo, done: false }])} className="text-[9px] text-fuchsia-400 hover:text-fuchsia-300 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 px-1.5 py-0.5 rounded shrink-0 transition-colors">+ Keep</button>
                              )}
                            </div>
                          );
                        })}
                        {newOnes.length > 1 && (
                          <button onClick={() => setChatTodos(prev => [...prev, ...newOnes.filter(t => !prev.some(p => p.text === t)).map((t, i) => ({ id: Date.now() + i, text: t, done: false }))])} className="text-[9px] text-fuchsia-300 hover:text-fuchsia-200 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 px-2 py-1 rounded transition-colors mt-1">
                            + Keep All ({newOnes.length})
                          </button>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ))}
              {isTyping && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-purple-400/80 text-[11px] font-semibold uppercase tracking-wider">
                    <Sparkles size={12} className={`${AGENT_REGISTRY[activeAgent]?.color || 'text-fuchsia-400'} animate-pulse`} /> {AGENT_REGISTRY[activeAgent]?.name}
                  </div>
                  {/* Live thinking block — populated by progress messages */}
                  {(() => {
                    const progressMsg = messages.find(m => m._progress && m.agent === activeAgent);
                    const liveSteps = progressMsg?.steps || [];
                    const liveCalls = progressMsg?.toolCalls || [];
                    return liveSteps.length > 0 || liveCalls.length > 0
                      ? <ThinkingBlock steps={liveSteps} toolCalls={liveCalls} inProgress mode={chatMode} />
                      : (
                        <div className="bg-transparent border border-fuchsia-500/20 text-purple-400 rounded-xl px-4 py-2.5 flex items-center gap-2 w-fit">
                          <Loader2 size={13} className={`animate-spin ${AGENT_REGISTRY[activeAgent]?.color || 'text-fuchsia-400'}`} />
                          <span className="text-xs">{chatMode === 'agent' ? 'Executing tools & writing code...' : chatMode === 'plan' ? 'Analyzing codebase & planning...' : 'Thinking...'}</span>
                        </div>
                      );
                  })()}
                  {/* Stop / Steer controls */}
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={handleOpenSteer} title="Stop and provide steering"
                      className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300 hover:bg-fuchsia-500/25 hover:text-fuchsia-100 transition-colors">
                      <RotateCcw size={10} /> Steer
                    </button>
                    <button type="button" onClick={handleStop} title="Stop generation"
                      className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/25 hover:text-red-200 transition-colors">
                      <Square size={10} /> Stop
                    </button>
                  </div>
                  {/* Inline steer input */}
                  {isSteerOpen && (
                    <div className="flex items-center gap-2 bg-[#0a0412]/80 border border-fuchsia-400/40 rounded-lg px-3 py-2 shadow-[0_0_12px_rgba(232,121,249,0.15)]">
                      <RotateCcw size={12} className="text-fuchsia-400 shrink-0" />
                      <input ref={steerInputRef} value={steerInput} onChange={e => setSteerInput(e.target.value)}
                        placeholder="Add steering instructions and press Enter…"
                        className="flex-1 bg-transparent text-[12px] text-purple-100 placeholder-purple-500/50 outline-none"
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSteer(); } if (e.key === 'Escape') { setIsSteerOpen(false); setSteerInput(''); handleStop(); } }}
                      />
                      <button type="button" onClick={handleSteer} className="text-[10px] px-2 py-0.5 rounded bg-fuchsia-600 hover:bg-fuchsia-500 text-white transition-colors shrink-0">Send</button>
                      <button type="button" onClick={() => { setIsSteerOpen(false); setSteerInput(''); handleStop(); }} className="text-[10px] text-purple-500 hover:text-red-400 transition-colors shrink-0">Cancel</button>
                    </div>
                  )}
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Kept TODOs Panel */}
            {chatTodos.length > 0 && (
              <div className="px-3 py-2 bg-[#120825] border-t border-fuchsia-500/15 shrink-0">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-fuchsia-300/70 uppercase tracking-wider font-semibold flex items-center gap-1"><ListChecks size={10}/> TODOs ({chatTodos.filter(t=>!t.done).length}/{chatTodos.length})</span>
                  <button onClick={() => setChatTodos([])} className="text-[9px] text-red-400/50 hover:text-red-300 transition-colors">Clear all</button>
                </div>
                <div className="space-y-1 max-h-[120px] overflow-y-auto">
                  {chatTodos.map(todo => (
                    <div key={todo.id} className={`flex items-start gap-2 text-[11px] py-0.5 px-1.5 rounded group ${todo.done ? 'opacity-50' : ''}`}>
                      <button onClick={() => setChatTodos(prev => prev.map(t => t.id === todo.id ? {...t, done: !t.done} : t))} className="shrink-0 mt-0.5">
                        {todo.done ? <CheckSquare size={12} className="text-green-400/70"/> : <Square size={12} className="text-purple-400/40 hover:text-fuchsia-300"/>}
                      </button>
                      <span className={`flex-1 text-purple-200/80 ${todo.done ? 'line-through' : ''}`}>{todo.text}</span>
                      <button onClick={() => setChatTodos(prev => prev.filter(t => t.id !== todo.id))} className="shrink-0 text-red-400/30 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"><X size={11}/></button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Chat Input */}
            <div className="p-3 bg-[#15092a] border-t border-fuchsia-500/20 shrink-0" style={{ paddingBottom: 'max(0.75rem, var(--sab))' }}>
              {sessionTokens >= TOKEN_CEILING && (
                <div className="mb-2 flex items-center gap-2 rounded-lg bg-amber-900/40 border border-amber-500/40 px-3 py-2 text-amber-300 text-[11px]">
                  <span className="text-base leading-none">⚠️</span>
                  <span>
                    This session has used ~{Math.round(sessionTokens / 1000)}k tokens (limit: {TOKEN_CEILING / 1000}k).
                    {' '}<button type="button" className="underline hover:text-amber-100 transition-colors" onClick={handleNewConversation}>Start a new chat</button> to preserve context efficiency.
                  </span>
                </div>
              )}
              <form onSubmit={handleAgentSubmit} className="flex flex-col gap-2">
                <div className="relative bg-[#0a0412]/80 border border-fuchsia-500/30 focus-within:border-fuchsia-400 focus-within:shadow-[0_0_10px_rgba(232,121,249,0.2)] rounded-lg transition-all">
                  {chatImage && (
                    <div className="px-3 pt-3">
                      <div className="inline-flex items-center gap-2 rounded-md border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 py-1">
                        <img src={chatImage.dataUrl} alt={chatImage.name} className="h-10 w-10 rounded object-cover border border-fuchsia-400/40" />
                        <span className="text-[11px] text-purple-200/90 max-w-[180px] truncate">{chatImage.name}</span>
                        <button
                          type="button"
                          onClick={() => setChatImage(null)}
                          className="text-[11px] text-purple-400 hover:text-red-300 transition-colors"
                          aria-label="Remove image"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                  )}
                  <textarea
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    disabled={sessionTokens >= TOKEN_CEILING}
                    onPaste={(e) => {
                      const imageFile = extractImageFileFromDataTransfer(e.clipboardData);
                      if (imageFile) {
                        e.preventDefault();
                        handleAttachChatImage(imageFile);
                        return;
                      }
                      // Allow paste of anything — strip only null bytes that break JSON
                      const pasted = e.clipboardData.getData('text');
                      if (pasted) {
                        e.preventDefault();
                        const cleaned = pasted.replace(/\0/g, '');
                        const ta = e.target;
                        const start = ta.selectionStart;
                        const end = ta.selectionEnd;
                        const next = chatInput.slice(0, start) + cleaned + chatInput.slice(end);
                        setChatInput(next);
                        // Restore cursor after React re-render
                        requestAnimationFrame(() => {
                          ta.selectionStart = ta.selectionEnd = start + cleaned.length;
                        });
                      }
                    }}
                    onDrop={(e) => {
                      const imageFile = extractImageFileFromDataTransfer(e.dataTransfer);
                      if (!imageFile) return;
                      e.preventDefault();
                      handleAttachChatImage(imageFile);
                    }}
                    onDragOver={(e) => {
                      if (extractImageFileFromDataTransfer(e.dataTransfer)) e.preventDefault();
                    }}
                    placeholder={chatMode === 'agent' ? `Tell ${AGENT_REGISTRY[activeAgent]?.name || 'Agent'} what to build or fix...` : chatMode === 'plan' ? `Describe what you want planned...` : `Ask ${AGENT_REGISTRY[activeAgent]?.name || 'Agent'}...`}
                    className={`w-full bg-transparent p-3 text-[13px] text-purple-100 outline-none placeholder:text-purple-400/40 resize-none min-h-[80px] ${sessionTokens >= TOKEN_CEILING ? 'opacity-40 cursor-not-allowed' : ''}`}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAgentSubmit(e); } }}
                  />
                  <div className="flex items-center justify-between px-2 pb-2">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        title={activeFile ? `Attach ${fileSystem[activeFile]?.name || activeFile}` : 'No file open'}
                        className="p-1.5 text-purple-400/60 hover:text-fuchsia-300 transition-colors"
                        onClick={() => {
                          if (!activeFile || !fileSystem[activeFile]) return;
                          const f = fileSystem[activeFile];
                          const fence = '```' + (f.language || '') + '\n' + f.content + '\n```';
                          setChatInput(prev => (prev ? prev + '\n\n' : '') + `**${f.name}:**\n${fence}`);
                        }}
                      >
                        <Paperclip size={14}/>
                      </button>
                      <button
                        type="button"
                        title="Paste from clipboard"
                        className="p-1.5 text-purple-400/60 hover:text-fuchsia-300 transition-colors"
                        onClick={async () => {
                          try {
                            const text = await navigator.clipboard.readText();
                            if (text) setChatInput(prev => prev + text);
                          } catch {
                            // clipboard API blocked — user can use Ctrl+V in textarea directly
                          }
                        }}
                      >
                        <ClipboardPaste size={14}/>
                      </button>
                      <button type="button" className="p-1.5 text-purple-400/60 hover:text-purple-200 transition-colors text-xs font-semibold px-2">@</button>
                    </div>
                    <button
                      type="submit"
                      disabled={(!chatInput.trim() && !chatImage) || isTyping || sessionTokens >= TOKEN_CEILING}
                      className="p-1.5 bg-fuchsia-600 hover:bg-fuchsia-500 disabled:bg-[#25104a] disabled:text-purple-500/50 text-white rounded-md transition-all shadow-md"
                    >
                      <Send size={14} className={isTyping ? "opacity-50" : ""} />
                    </button>
                  </div>
                </div>

                {/* Agent Picker */}
                <div className="flex justify-between items-center text-[10px] text-purple-400/70 mt-1 px-1 relative">
                  <div className="flex items-center gap-1 hover:text-purple-200 cursor-pointer" onClick={() => setShowConversations(p => !p)}>
                    <MessageSquare size={11} /> {conversations.find(c => c.id === activeConvoId)?.name || `Chat ${activeConvoId}`} <ChevronDown size={11} />
                  </div>
                  <div className="relative" data-agent-picker>
                    <div
                      className="flex items-center gap-1 hover:text-fuchsia-300 cursor-pointer transition-colors"
                      onClick={() => { setShowAgentPicker(p => !p); setAgentPickerSubmenu(null); }}
                    >
                      <Sparkles size={12} className={AGENT_REGISTRY[activeAgent]?.color || 'text-fuchsia-400/70'} />
                      <span>
                        {AGENT_REGISTRY[activeAgent]?.name || 'Select Agent'}
                        {activeModel && (
                          <span className="text-purple-500/60 ml-1">
                            · {activeModel === AUTO_MODEL_ID ? 'Auto' : (AGENT_REGISTRY[activeAgent]?.models?.find(m => m.id === activeModel)?.name || activeModel)}
                          </span>
                        )}
                      </span>
                      <ChevronDown size={11} />
                    </div>
                    {showAgentPicker && (
                      <div className="absolute bottom-full right-0 mb-1 w-72 bg-[#1a0b35] border border-fuchsia-500/30 rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.7)] z-50 py-1 overflow-hidden max-h-[70vh] overflow-y-auto">
                        <div className="px-3 py-1.5 text-[9px] text-purple-500/50 uppercase tracking-widest font-bold">Select Agent &amp; Model</div>
                        {/* ── Auto option ── */}
                        <div className={activeModel === AUTO_MODEL_ID && activeAgent === 'epicode-agent' ? 'bg-fuchsia-500/10' : ''}>
                          <button
                            onClick={() => {
                              setActiveAgent('epicode-agent');
                              setActiveModels(prev => ({ ...prev, 'epicode-agent': AUTO_MODEL_ID }));
                              setConversations(prev => prev.map(c => c.id === activeConvoId ? { ...c, agent: 'epicode-agent' } : c));
                              setShowAgentPicker(false);
                              setAgentPickerSubmenu(null);
                            }}
                            className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2.5 ${
                              activeModel === AUTO_MODEL_ID && activeAgent === 'epicode-agent'
                                ? 'text-fuchsia-200'
                                : 'text-purple-300 hover:bg-[#25104a] hover:text-purple-100'
                            }`}
                          >
                            <Zap size={12} className="text-yellow-400 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold flex items-center gap-1.5">
                                Auto
                                {activeModel === AUTO_MODEL_ID && activeAgent === 'epicode-agent' && <CheckCircle2 size={10} className="text-fuchsia-400" />}
                              </div>
                              <div className="text-[9px] text-purple-500/60 truncate">Routes to DeepSeek or Gemini Flash — no premium models</div>
                            </div>
                          </button>
                        </div>
                        {Object.values(AGENT_REGISTRY).map(agent => {
                          const models = agent.models || [];
                          const expanded = agentPickerSubmenu === agent.id;
                          const currentModelId = activeModels[agent.id] || defaultModelFor(agent.id);
                          const currentModel = models.find(m => m.id === currentModelId);
                          const isActive = activeAgent === agent.id;
                          return (
                            <div key={agent.id} className={isActive ? 'bg-fuchsia-500/10' : ''}>
                              <button
                                onClick={() => {
                                  setActiveAgent(agent.id);
                                  setConversations(prev => prev.map(c => c.id === activeConvoId ? { ...c, agent: agent.id } : c));
                                  setAgentPickerSubmenu(expanded ? null : agent.id);
                                }}
                                className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2.5 ${isActive ? 'text-fuchsia-200' : 'text-purple-300 hover:bg-[#25104a] hover:text-purple-100'}`}
                              >
                                <Sparkles size={12} className={`${agent.color} shrink-0`} />
                                <div className="flex-1 min-w-0">
                                  <div className="font-semibold flex items-center gap-1.5">
                                    {agent.name}
                                    {isActive && <CheckCircle2 size={10} className="text-fuchsia-400" />}
                                  </div>
                                  <div className="text-[9px] text-purple-500/60 truncate">
                                    {currentModel ? currentModel.name : agent.description}
                                  </div>
                                </div>
                                {models.length > 1 && (
                                  <ChevronDown
                                    size={11}
                                    className={`shrink-0 text-purple-400/60 transition-transform ${expanded ? 'rotate-180' : ''}`}
                                  />
                                )}
                              </button>
                              {expanded && models.length > 0 && (
                                <div className="bg-[#0f0627] border-t border-fuchsia-500/10 py-1">
                                  {models.map(m => {
                                    const selected = currentModelId === m.id;
                                    const tierColor = m.tier === 'premium' ? 'text-amber-300' : m.tier === 'fast' ? 'text-cyan-300' : 'text-purple-300';
                                    return (
                                      <button
                                        key={m.id}
                                        onClick={() => {
                                          setActiveAgent(agent.id);
                                          setActiveModels(prev => ({ ...prev, [agent.id]: m.id }));
                                          setConversations(prev => prev.map(c => c.id === activeConvoId ? { ...c, agent: agent.id } : c));
                                          setShowAgentPicker(false);
                                          setAgentPickerSubmenu(null);
                                        }}
                                        className={`w-full text-left pl-9 pr-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${selected ? 'bg-fuchsia-500/20 text-fuchsia-100' : 'text-purple-300 hover:bg-[#25104a] hover:text-purple-100'}`}
                                      >
                                        <div className="flex-1 min-w-0">
                                          <div className="flex items-center gap-1.5">
                                            <span className="font-medium">{m.name}</span>
                                            <span className={`text-[8px] uppercase tracking-wider ${tierColor}`}>{m.tier}</span>
                                            {selected && <CheckCircle2 size={10} className="text-fuchsia-400" />}
                                          </div>
                                          {m.description && (
                                            <div className="text-[9px] text-purple-500/60 truncate">{m.description}</div>
                                          )}
                                        </div>
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </form>
            </div>
          </aside>
          </>
        )}
      </div>

      {/* Saved Toast */}
      {savedIndicator && (
        <div className="fixed top-14 left-1/2 -translate-x-1/2 z-[60] bg-[#1a0b35] border border-fuchsia-500/30 rounded-lg px-4 py-2 text-xs text-fuchsia-200 flex items-center gap-2 shadow-xl animate-pulse">
          <CheckCircle2 size={13} className="text-fuchsia-400" /> File saved
        </div>
      )}

      {/* New Project Dialog */}
      {newProjectDialog && (
        <NewProjectDialog
          initialTemplate={newProjectDialog.template}
          onConfirm={(template, name) => { handleNewProject(template, name); setNewProjectDialog(null); }}
          onCancel={() => setNewProjectDialog(null)}
        />
      )}

      {/* About Modal */}
      {showAbout && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowAbout(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="about-title"
        >
          <div className="bg-[#15092a] border border-fuchsia-500/30 rounded-xl shadow-[0_0_40px_rgba(192,38,211,0.25)] p-8 w-80 text-center focus:outline-none" onClick={e => e.stopPropagation()} tabIndex={-1} ref={el => el?.focus()}>
            <div className="flex justify-center mb-4">
              <Cpu size={44} className="text-fuchsia-400 drop-shadow-[0_0_20px_rgba(232,121,249,0.9)]" />
            </div>
            <h2 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-fuchsia-300 to-purple-300 mb-1">EpiCodeSpace</h2>
            <p className="text-purple-400/60 text-xs mb-4">Version 2.0.0 &mdash; April 2026</p>
            <p className="text-purple-300/80 text-xs leading-relaxed mb-6">
              An AI-powered cloud IDE mimicking GitHub Codespaces.<br />
              Built with React, Vite, Tailwind CSS &amp; lucide-react.
            </p>
            <div className="text-[10px] text-purple-500/50 mb-6 space-y-0.5">
              <div>Node: v20.x</div>
              <div>React: 18</div>
              <div>Vite: 6</div>
            </div>
            <button onClick={() => setShowAbout(false)} className="px-6 py-2 bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-xs rounded-lg transition-colors shadow-md">Close</button>
          </div>
        </div>
      )}

      {/* ── Status Bar ────────────────────────────────────────────────────── */}
      <footer className="flex items-start justify-between px-1 sm:px-2 bg-[#15092a] border-t border-fuchsia-500/30 text-[10px] sm:text-[11px] text-purple-300 z-20 shrink-0 overflow-x-auto no-scrollbar" style={{ paddingTop: '4px', paddingBottom: 'var(--sab)', minHeight: 'calc(24px + var(--sab))' }}>
        <div className="flex items-center h-full">
          <div className="hidden sm:flex items-center gap-1 h-full px-2 sm:px-3 bg-gradient-to-r from-cyan-600 to-blue-600 text-white font-semibold cursor-pointer hover:from-cyan-500 hover:to-blue-500 transition-colors rounded-tl-sm">
            <span className="text-[10px]">&gt;&lt;</span> <span className="hidden md:inline">EpiCodeSpace</span><span className="md:hidden">ECS</span>
          </div>
          <div className="flex items-center gap-1 px-2 sm:px-3 h-full hover:bg-[#25104a] cursor-pointer transition-colors border-r border-fuchsia-500/10">
            <GitBranch size={12} /> main*
          </div>
          <div className="hidden md:flex items-center gap-1 px-3 h-full hover:bg-[#25104a] cursor-pointer transition-colors border-r border-fuchsia-500/10">
            <GitCommit size={12} /> Sync Changes
          </div>
          <div onClick={() => { setTerminalState('open'); setActiveTerminalTab('problems'); }} className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 h-full hover:bg-[#25104a] cursor-pointer transition-colors">
            <div className="flex items-center gap-1"><AlertCircle size={12} className="text-red-400"/> {errorCount}</div>
            <div className="flex items-center gap-1"><AlertCircle size={12} className="text-yellow-400" /> {warningCount}</div>
            <div className="hidden sm:flex items-center gap-1"><AlertCircle size={12} className="text-cyan-400" /> {infoCount}</div>
          </div>
        </div>
        <div className="flex items-center h-full">
          <div className="px-2 h-full flex items-center hover:bg-[#25104a] cursor-pointer transition-colors">Ln {cursorPos.line}, Col {cursorPos.col}</div>
          <div className="hidden sm:flex px-2 h-full items-center hover:bg-[#25104a] cursor-pointer transition-colors" onClick={() => setWordWrap(p => !p)} title="Toggle Word Wrap (Alt+Z)">{wordWrap ? 'Wrap: On' : 'Spaces: 2'}</div>
          <div className="hidden md:flex px-2 h-full items-center hover:bg-[#25104a] cursor-pointer transition-colors">UTF-8</div>
          <div className="hidden lg:flex px-2 h-full items-center hover:bg-[#25104a] cursor-pointer transition-colors">LF</div>
          <div className="hidden md:flex px-2 h-full items-center hover:bg-[#25104a] cursor-pointer transition-colors font-semibold gap-1"><CheckCircle2 size={12} className="text-fuchsia-400"/> Prettier</div>
          <Suspense fallback={null}><LspStatusBadge /></Suspense>
          <div className="hidden lg:flex px-2 h-full items-center hover:bg-[#25104a] cursor-pointer transition-colors">Layout: U.S.</div>
          <div className={`px-2 h-full flex items-center border-l border-fuchsia-500/10 ${AGENT_REGISTRY[activeAgent]?.color || 'text-fuchsia-400'}`}>⚡ <span className="hidden sm:inline ml-1">{AGENT_REGISTRY[activeAgent]?.name || 'Agent'}</span></div>
        </div>
      </footer>
    </div>
  );
}

/* ─── Wrapped Export with Error Boundary ─────────────────────────────────── */
function EpiCodeSpaceWithBoundary() {
  return <ErrorBoundary><EpiCodeSpaceApp /></ErrorBoundary>;
}

export default EpiCodeSpaceWithBoundary;
