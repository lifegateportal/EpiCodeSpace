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
  RotateCcw, ExternalLink, MonitorPlay, Rocket, EyeOff, Cloud, CloudOff
} from 'lucide-react';

// ─── Extracted modules (Amendment #6 — split monolith) ────────────────────────
import CodeBlock from './components/CodeBlock.jsx';
// Amendment #4 — Performance: lazy-load heavy panels only when needed.
const MarkdownContent = lazy(() => import('./components/MarkdownContent.jsx'));
const CodeEditor = lazy(() => import('./components/CodeEditor.jsx'));
const WebContainerTerminal = lazy(() => import('./components/ServerTerminal.jsx'));
const LspStatusBadge = lazy(() => import('./components/LspStatusBadge.jsx'));
import FileExplorer from './components/FileExplorer.jsx';
import DeployModal from './components/DeployModal.jsx';
import ConnectionsManager from './components/ConnectionsManager.jsx';
import { loadConnections, saveConnections } from './lib/connections.js';
import PanelErrorBoundary from './components/ErrorBoundary.jsx';
import { useToast } from './components/Toaster.jsx';
import { logger } from './lib/logger.js';
import {
  STORAGE_KEY, CONVOS_KEY, PREFS_KEY, PANELS_KEY, AGENT_KEY, MODELS_KEY, MODE_KEY, SNAPSHOTS_KEY,
  loadJSON, storeJSON, loadLatestSnapshot, saveLocalSnapshot,
} from './lib/storage.js';
import DOMPurify from 'dompurify';
import { AGENT_REGISTRY, defaultModelFor, isValidModelFor } from './lib/agentRegistry.js';
import { createAgentTools as createSharedAgentTools, buildAgentResponse as buildSharedAgentResponse } from './lib/agentTools.js';
import { AUTO_MODEL_ID, resolveAutoRoute, autoFetch } from './lib/modelRouter.ts';
import { MAX_INLINE_READ_BYTES } from './lib/fs/types.ts';
import { FsClient } from './lib/fs/FsClient.ts';
import { bridge } from './lib/runtime/WebContainerBridge.ts';
import { useFileSystem, isOpfsEnabled } from './hooks/useFileSystem.js';
import { isGistSyncEnabled, pushToGist, pullFromGist, GIST_TOKEN_KEY, GIST_ID_KEY } from './lib/gistSync.js';
import { cloneRepo } from './lib/gitClone.js';

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

const URL_IN_TEXT_RE = /https?:\/\/[^\s)]+/gi;

function isPublicIpv4Host(hostname) {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const parts = m.slice(1).map((n) => Number(n));
  if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return false;
  if (a === 127) return false;
  if (a === 0) return false;
  if (a === 169 && b === 254) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  return true;
}

function isUsefulDirectPreviewUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol)) return false;
    if (!url.port) return false;
    if (/\/api\/preview\//i.test(url.pathname)) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPublicIpv4Host(host);
    return true;
  } catch {
    return false;
  }
}

function extractDirectPreviewUrl(line) {
  if (!line || typeof line !== 'string') return '';
  const matches = line.match(URL_IN_TEXT_RE) || [];
  for (const candidate of matches) {
    const clean = candidate.replace(/[.,;:!?]+$/, '');
    if (isUsefulDirectPreviewUrl(clean)) return clean;
  }
  return '';
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

  const writeCount   = toolCalls.filter(tc => tc.tool === 'writeFile' || tc.tool === 'editFile' || tc.tool === 'patchLines').length;
  const readCount    = toolCalls.filter(tc => tc.tool === 'readFile').length;
  const searchCount  = toolCalls.filter(tc => tc.tool === 'searchCode').length;
  const cmdCount     = toolCalls.filter(tc => tc.tool === 'runCommand' || tc.tool === 'runTests' || tc.tool === 'runLint' || tc.tool === 'runTypecheck').length;

  const summaryParts = [];
  if (writeCount)  summaryParts.push(`${writeCount} file${writeCount > 1 ? 's' : ''} written`);
  if (readCount)   summaryParts.push(`${readCount} read`);
  if (searchCount) summaryParts.push(`${searchCount} search${searchCount > 1 ? 'es' : ''}`);
  if (cmdCount)    summaryParts.push(`${cmdCount} command${cmdCount > 1 ? 's' : ''}`);
  const summary = summaryParts.join(' · ') || `${steps.length} step${steps.length !== 1 ? 's' : ''}`;
  const displayToolCalls = compactToolCalls(toolCalls.filter(tc => !tc.blocked), 12);

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
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(s.text.replace(/\*\*(.*?)\*\*/g, '<strong class="text-purple-200/90 not-italic">$1</strong>').replace(/`([^`]+)`/g, '<code class="text-fuchsia-300/80 bg-fuchsia-500/10 px-1 rounded text-[10px] not-italic">$1</code>'), { ALLOWED_TAGS: ['strong', 'code'], ALLOWED_ATTR: ['class'] }) }}
              />
            </div>
          ))}
          {/* Tool calls detail */}
          {displayToolCalls.length > 0 && (
            <div className="pt-1.5 mt-1.5 border-t border-white/5 flex flex-wrap gap-1">
              {displayToolCalls.map((tc, ti) => {
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

function toolCallPath(call) {
  const args = call?.args || call?.arguments || {};
  if (typeof args.path === 'string' && args.path) return args.path;
  if (typeof args.targetFile === 'string' && args.targetFile) return args.targetFile;
  return null;
}

function compactToolCalls(calls, max = 14) {
  if (!Array.isArray(calls) || calls.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (let i = calls.length - 1; i >= 0; i--) {
    const tc = calls[i] || {};
    const args = tc.args || tc.arguments || {};
    const key = `${tc.tool || tc.name}:${args.path || args.targetFile || args.pattern || args.command || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tc);
    if (out.length >= max) break;
  }
  return out.reverse();
}

function buildExecutionRecap(toolCalls = [], changeSummary = { files: [], totalPlus: 0, totalMinus: 0 }) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const files = Array.isArray(changeSummary?.files) ? changeSummary.files : [];
  if (calls.length === 0 && files.length === 0) return '';

  const countTools = (...names) => calls.filter((c) => names.includes(c.tool || c.name)).length;
  const writeCount = countTools('writeFile', 'editFile', 'patchLines', 'searchAndReplace', 'autoFix', 'createComponent', 'deleteFile');
  const readCount = countTools('readFile', 'listFiles', 'searchCode', 'analyzeFile', 'getProjectStructure');
  const commandCount = countTools('runCommand', 'npmInstall', 'runTests', 'runLint', 'runTypecheck', 'getGitStatus');

  const fileLines = files.slice(0, 8).map((f) => {
    const suffix = f.action === 'create' || f.action === 'write'
      ? 'created'
      : f.action === 'delete'
        ? 'deleted'
        : 'updated';
    return `- ${f.path} (${suffix})`;
  });
  const extraFiles = files.length > 8 ? `\n- ...and ${files.length - 8} more file(s)` : '';

  return [
    '',
    '### What I did',
    `- Executed ${calls.length} tool call(s)`,
    `- Reads: ${readCount}, Writes: ${writeCount}, Commands: ${commandCount}`,
    files.length > 0 ? `- Changed ${files.length} file(s) (+${changeSummary.totalPlus || 0}/-${changeSummary.totalMinus || 0})` : '- No files were changed',
    ...(fileLines.length > 0 ? ['- File changes:', ...fileLines] : []),
    ...(extraFiles ? [extraFiles] : []),
  ].join('\n');
}

function compactLargeText(value, max = 4000) {
  if (typeof value !== 'string' || value.length <= max) return value;
  const half = Math.floor(max / 2);
  return `${value.slice(0, half)}\n...[truncated for resume continuity]...\n${value.slice(-half)}`;
}

function compactToolResultPayload(result) {
  if (result == null || typeof result !== 'object') return result;
  if (Array.isArray(result)) return result.slice(0, 50).map((v) => compactToolResultPayload(v));
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (typeof v === 'string') out[k] = compactLargeText(v, 4000);
    else if (Array.isArray(v)) out[k] = v.slice(0, 50).map((x) => compactToolResultPayload(x));
    else if (v && typeof v === 'object') out[k] = compactToolResultPayload(v);
    else out[k] = v;
  }
  return out;
}

const AGENT_RUN_STATES = {
  IDLE: 'idle',
  PLANNING: 'planning',
  TOOL_EXECUTION: 'tool_execution',
  VERIFYING: 'verifying',
  RESPONDING: 'responding',
  FAILED: 'failed',
};

const TOOL_POLICY = {
  readFile: 'read',
  listFiles: 'read',
  getProjectStructure: 'read',
  searchCode: 'read',
  analyzeFile: 'read',
  getTerminalOutput: 'read',
  getProblems: 'read',
  getGitStatus: 'read',
  diagnoseProject: 'read',
  explainError: 'read',
  writeFile: 'safe_write',
  editFile: 'safe_write',
  patchLines: 'safe_write',
  searchAndReplace: 'safe_write',
  autoFix: 'safe_write',
  createComponent: 'safe_write',
  deleteFile: 'risky_write',
  runCommand: 'command',
  npmInstall: 'command',
  runBuild: 'command',
  runTests: 'command',
  runLint: 'command',
  runTypecheck: 'command',
};

function isWritePolicy(toolName) {
  return TOOL_POLICY[toolName] === 'safe_write' || TOOL_POLICY[toolName] === 'risky_write' || TOOL_POLICY[toolName] === 'command';
}

function isFileWriteTool(toolName) {
  const p = TOOL_POLICY[toolName];
  return p === 'safe_write' || p === 'risky_write';
}

function compactMessageForStorage(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  const out = { ...msg };
  delete out._progress;
  if (Array.isArray(out.steps) && out.steps.length > 80) out.steps = out.steps.slice(-80);
  if (Array.isArray(out.toolCalls) && out.toolCalls.length > 60) out.toolCalls = compactToolCalls(out.toolCalls, 60);
  if (typeof out.content === 'string' && out.content.length > 120000) {
    out.content = `${out.content.slice(0, 110000)}\n\n...[truncated for local storage budget]...`;
  }
  if (out.resumeState && typeof out.resumeState === 'object') {
    const rs = out.resumeState;
    out.resumeState = {
      ...rs,
      history: Array.isArray(rs.history) ? rs.history.slice(-20) : [],
      pendingToolCalls: Array.isArray(rs.pendingToolCalls) ? rs.pendingToolCalls.slice(-40) : [],
      toolResults: Array.isArray(rs.toolResults) ? rs.toolResults.slice(-40) : [],
      allSteps: Array.isArray(rs.allSteps) ? rs.allSteps.slice(-120) : [],
      allToolCalls: Array.isArray(rs.allToolCalls) ? compactToolCalls(rs.allToolCalls, 120) : [],
    };
  }
  return out;
}

function compactConversationsForStorage(convos, perConvoMessageCap = 120) {
  if (!Array.isArray(convos)) return [];
  return convos.map((c) => {
    const msgs = Array.isArray(c?.messages) ? c.messages.filter((m) => !m?._progress) : [];
    const clipped = msgs.slice(-perConvoMessageCap).map(compactMessageForStorage);
    return { ...c, messages: clipped };
  });
}

function packChatHistory(messages, activeFile, userMessage, maxItems = 20) {
  if (!Array.isArray(messages) || messages.length <= maxItems) return messages;

  const needleSet = new Set(
    (userMessage || '')
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 4)
  );
  const activeNeedle = (activeFile || '').toLowerCase();

  const scored = messages.map((m, idx) => {
    const text = typeof m?.content === 'string' ? m.content.toLowerCase() : '';
    const recency = idx / Math.max(1, messages.length - 1);
    let relevance = 0;
    if (activeNeedle && text.includes(activeNeedle)) relevance += 3;
    for (const n of needleSet) {
      if (text.includes(n)) relevance += 1;
    }
    if (m?.role === 'user') relevance += 0.5;
    return { idx, msg: m, score: recency + relevance };
  });

  const mustKeep = new Set();
  mustKeep.add(messages.length - 1);
  if (messages.length > 1) mustKeep.add(messages.length - 2);

  const selected = scored
    .filter((s) => !mustKeep.has(s.idx))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, maxItems - mustKeep.size))
    .map((s) => s.idx);

  for (const idx of mustKeep) selected.push(idx);

  const sorted = Array.from(new Set(selected)).sort((a, b) => a - b).map((idx) => messages[idx]);
  return sorted;
}

function historyLimitsForAgent(agentId, mode) {
  if (mode !== 'agent') return { pack: 20, slice: 22 };
  if (agentId === 'backend-architect') return { pack: 40, slice: 48 };
  if (agentId === 'deepseek') return { pack: 28, slice: 32 };
  return { pack: 20, slice: 22 };
}

function makeMessageId(prefix = 'msg') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function looksLikeWorkspaceChangeRequest(text) {
  const value = (text || '').toLowerCase();
  return /(fix|update|change|modify|edit|patch|write|save|create|add|remove|delete|rename|refactor|implement|build|generate|scaffold)/.test(value);
}

function looksLikeBatchChangeRequest(text) {
  const value = (text || '').toLowerCase();
  return /(across (the|my)? project|across (all|multiple) files|project-wide|project wide|globally|global fix|everywhere|bulk|whole project|entire project|multi-file|multiple files|all files)/.test(value);
}

function userExplicitlyRequestedDeletion(text, targetPath = '') {
  const raw = String(text || '').toLowerCase();
  const target = String(targetPath || '').toLowerCase();
  if (!raw) return false;
  const asksToDelete = /\b(delete|remove|rm|erase|drop|truncate|wipe)\b/.test(raw);
  if (!asksToDelete) return false;
  if (!target) return true;
  return raw.includes(target) || raw.includes(target.split('/').pop() || '');
}

function userExplicitlyApprovedDestructiveSweep(text) {
  const raw = String(text || '').toLowerCase();
  if (!raw) return false;
  return /(approve|approved|confirm|confirmed|yes|proceed).*(sweep|bulk|mass).*(delete|remove|replace|wipe|truncate)|\b(delete all files|remove all files|mass delete approved|approved bulk replace)\b/.test(raw);
}

function looksLikeWebsiteBuildRequest(text) {
  const value = (text || '').toLowerCase();
  return /(build|create|make|scaffold|design)\s+.*(website|web\s*app|site|landing\s*page)|\b(website|web\s*app|landing\s*page|homepage|portfolio\s*site)\b/.test(value);
}

function looksLikeAppBuildRequest(text) {
  const value = (text || '').toLowerCase();
  return /(build|create|make|scaffold|ship|continue)\s+.*(app|application|mvp|product)|\b(building an app|building my app|continue building|full stack app|full-stack app|end-to-end app)\b/.test(value);
}

function looksLikePastedErrorBlock(text) {
  const value = String(text || '');
  if (value.length < 1800) return false;
  const lines = value.split('\n');
  if (lines.length < 18) return false;
  return /(error|exception|failed|traceback|stack|cannot|undefined|syntaxerror|typeerror|referenceerror|ts\d+:|at\s+.+:\d+:\d+)/i.test(value);
}

function normalizeLargeErrorBlock(text) {
  const raw = String(text || '').replace(/\0/g, '');
  if (!looksLikePastedErrorBlock(raw)) return raw;
  const lines = raw.split('\n');
  const head = lines.slice(0, 24).join('\n');
  const tail = lines.slice(-40).join('\n');
  return [
    'Analyze and fix this pasted error/log block.',
    'Focus on the root cause and the first actionable fix. Do not quote the entire log back.',
    '',
    '[Error block start excerpt]',
    head,
    '',
    '[Error block end excerpt]',
    tail,
  ].join('\n');
}

function looksLikeCommandExecutionRequest(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  if (/^(npm|pnpm|yarn|bun|npx|node|tsx|ts-node|fuser|lsof|kill|pkill|curl|wget)\b/.test(value)) return true;
  if (/\b(runcommand|runbuild|runtypecheck|runlint|runtests|npminstall)\b/.test(value)) return true;
  if (/\b(runtime terminal|terminal command|run this command|execute this command)\b/.test(value)) return true;
  if (/`[^`]*\b(npm|pnpm|yarn|bun|npx|node|fuser|lsof|kill|curl)\b[^`]*`/.test(value)) return true;
  return /\b(run|execute|launch|start)\b.*\b(command|terminal|runtime|build|typecheck|lint|tests?|dev|server)\b/.test(value);
}

const REASONER_CONTEXT_FILE_LIMIT = 8;
const REASONER_CONTEXT_FILE_CHARS = 2200;

function buildReasonerNeedles(userMessage, activeFile, pinnedFilePath) {
  const needles = new Set(
    String(userMessage || '')
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length >= 4)
  );

  for (const path of [activeFile, pinnedFilePath]) {
    const normalized = String(path || '').toLowerCase();
    for (const part of normalized.split(/[\/._-]+/)) {
      if (part.length >= 4) needles.add(part);
    }
  }

  return Array.from(needles);
}

function buildReasonerExcerpt(content, needles, maxChars = REASONER_CONTEXT_FILE_CHARS) {
  const lines = String(content || '').split('\n');
  const lowered = lines.map((line) => line.toLowerCase());
  let focusLine = 0;

  for (const needle of needles) {
    const idx = lowered.findIndex((line) => line.includes(needle));
    if (idx >= 0) {
      focusLine = idx;
      break;
    }
  }

  const start = Math.max(0, focusLine - 12);
  const numbered = [];
  let usedChars = 0;

  for (let i = start; i < lines.length; i++) {
    const numberedLine = `${String(i + 1).padStart(4, ' ')} │ ${lines[i]}`;
    if (numbered.length > 0 && usedChars + numberedLine.length + 1 > maxChars) break;
    numbered.push(numberedLine);
    usedChars += numberedLine.length + 1;
  }

  return numbered.join('\n');
}

function buildReasonerRelevantFiles(fs, activeFile, userMessage, pinnedFilePath, maxFiles = REASONER_CONTEXT_FILE_LIMIT) {
  const needles = buildReasonerNeedles(userMessage, activeFile, pinnedFilePath);
  const candidates = [];

  for (const [path, entry] of Object.entries(fs || {})) {
    if (!entry || typeof entry !== 'object' || typeof entry.content !== 'string') continue;
    if (!entry.content.trim()) continue;

    const lowerPath = path.toLowerCase();
    const lowerContent = entry.content.toLowerCase();
    let score = 0;

    if (path === activeFile) score += 100;
    if (path === pinnedFilePath) score += 80;
    if (/package\.json$|tsconfig|vite\.config|tailwind\.config|openapi\.ya?ml|schema\//i.test(path)) score += 4;

    for (const needle of needles) {
      if (lowerPath.includes(needle)) score += 10;
      if (lowerContent.includes(needle)) score += 3;
    }

    if (score <= 0) continue;

    candidates.push({
      path,
      score,
      excerpt: buildReasonerExcerpt(entry.content, needles),
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxFiles)
    .map(({ path, excerpt }) => ({ path, excerpt }));
}

function extractReasonerVisibleSummary(planText) {
  const text = String(planText || '').trim();
  if (!text) return 'Preparing targeted implementation and verification.';

  const explicitSummary = text.match(/(?:^|\n)summary\s*:\s*(.+)/i);
  if (explicitSummary?.[1]) {
    return explicitSummary[1].trim().slice(0, 240);
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^```/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim());

  const summaryLine = lines.find((line) => /goal|work on|focus|implement|fix|update/i.test(line)) || lines[0];
  return (summaryLine || 'Preparing targeted implementation and verification.').slice(0, 240);
}

function extractMajorPlanSteps(planText, maxSteps = 8) {
  const text = String(planText || '').trim();
  if (!text) return [];
  const lines = text.split('\n').map((line) => line.trim());
  const numbered = lines
    .filter((line) => /^\d+[.)]\s+/.test(line))
    .map((line) => line.replace(/^\d+[.)]\s+/, '').trim())
    .filter(Boolean);
  return numbered.slice(0, maxSteps);
}

function userApprovedNextPlanStep(text) {
  const value = String(text || '').toLowerCase().trim();
  return /^(yes|yep|yeah|continue|go ahead|next|proceed|ok|okay)\b/.test(value);
}

function userRejectedNextPlanStep(text) {
  const value = String(text || '').toLowerCase().trim();
  return /^(no|stop|pause|hold|not yet|wait)\b/.test(value);
}

function formatCommandOutputSnippet(output) {
  const text = String(output || '').trim();
  if (!text) return '';
  const lines = text.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const tail = lines.slice(-6).join('\n');
  return tail.length > 500 ? `${tail.slice(0, 500)}...` : tail;
}

function assessWebsiteCoreCompletion(fs) {
  const paths = Object.keys(fs || {});
  const hasPath = (re) => paths.some((p) => re.test(p));

  const packageJsonRaw = fs?.['package.json']?.content || '{}';
  let scripts = {};
  try {
    scripts = JSON.parse(packageJsonRaw)?.scripts || {};
  } catch {
    scripts = {};
  }

  const checks = {
    htmlEntry: hasPath(/^(index\.html|public\/index\.html|src\/index\.html)$/),
    appEntry: hasPath(/^src\/(main|index)\.(js|jsx|ts|tsx)$/),
    primaryUi: hasPath(/^src\/(app|App|pages\/.*|components\/.*)\.(js|jsx|ts|tsx)$/),
    styling: hasPath(/\.(css|scss|sass|less)$/),
    runScripts: typeof scripts.dev === 'string' && scripts.dev.length > 0 && typeof scripts.build === 'string' && scripts.build.length > 0,
  };

  const score = Object.values(checks).filter(Boolean).length;
  const complete = (checks.htmlEntry && checks.appEntry && checks.primaryUi && checks.styling) || score >= 4;
  const missing = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);

  return { complete, score, checks, missing };
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
  if (agentId === 'epicode-agent') {
    return [
      { type: 'text', text: safeText },
      { type: 'image_url', image_url: { url: image.dataUrl } },
    ];
  }
  return safeText;
}

function isIpadDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function canUseStreamCompression() {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function gzipText(text) {
  const src = new TextEncoder().encode(text);
  if (!canUseStreamCompression()) return src;
  const stream = new Blob([src]).stream().pipeThrough(new CompressionStream('gzip'));
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}

async function gunzipToText(bytes) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!canUseStreamCompression()) {
    return new TextDecoder().decode(src);
  }
  const stream = new Blob([src]).stream().pipeThrough(new DecompressionStream('gzip'));
  const out = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(out);
}

function isGzipBytes(bytes) {
  return bytes && bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

const PREVIEW_MODE_KEY = 'epicodespace_preview_mode_v1';
const PINNED_RULES_KEY = 'epicodespace_pinned_rules_v1';
const LITE_MODE_KEY = 'epicodespace_lite_mode_v1';
const LAST_BACKUP_AT_KEY = 'epicodespace_last_backup_at_v1';
const CHAT_QUIET_MODE_KEY = 'epicodespace_chat_quiet_mode_v1';
const CANONICAL_GUIDANCE_FILE = '.cursorrules.md';

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
  const [projectName,    setProjectName]    = useState(() => loadJSON('epicodespace_project_v1', 'My Project'));
  const [projectRepoUrl, setProjectRepoUrl] = useState(() => loadJSON('epicodespace_project_repo_v1', ''));
  const firstFile = Object.keys(fileSystem)[0] || null;
  const [activeFile, setActiveFile] = useState(firstFile);
  const [openTabs, setOpenTabs] = useState(firstFile ? [firstFile] : []);
  const [untitledCount, setUntitledCount] = useState(1);
  const [renamingFile, setRenamingFile] = useState(null);
  const [newProjectDialog, setNewProjectDialog] = useState(null); // null | { template: string }
  const [renameValue, setRenameValue] = useState('');

  // ── Panels ────────────────────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState(() => loadJSON(PANELS_KEY, { sidebarOpen: true, rightSidebarOpen: true, terminalState: 'open' }).sidebarOpen);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(() => loadJSON(PANELS_KEY, { sidebarOpen: true, rightSidebarOpen: true, terminalState: 'open' }).rightSidebarOpen);
  const [terminalState, setTerminalState] = useState(() => loadJSON(PANELS_KEY, { sidebarOpen: true, rightSidebarOpen: true, terminalState: 'open' }).terminalState);
  const [activeTerminalTab, setActiveTerminalTab] = useState('terminal');
  const [previewKey, setPreviewKey] = useState(0);
  const [previewRenderMode, setPreviewRenderMode] = useState(() => {
    const saved = loadJSON(PREVIEW_MODE_KEY, 'static');
    return saved === 'live' ? 'live' : 'static';
  }); // 'static' | 'live'
  const [previewSourcePath, setPreviewSourcePath] = useState('index.html');

  // ── Terminal ──────────────────────────────────────────────────────────────
  const [terminalLines, setTerminalLines] = useState(['ubuntu@epicode:~/workspace (main) $ ']);
  const [terminalInput, setTerminalInput] = useState('');
  const runtimeTerminalSeqRef = useRef(1);
  const [runtimeTerminals, setRuntimeTerminals] = useState([{ id: 'runtime-1', label: 'Runtime 1' }]);
  const [activeRuntimeTerminalId, setActiveRuntimeTerminalId] = useState('runtime-1');
  const [outputLog, setOutputLog] = useState(['EpiCodeSpace output panel ready.']);
  const [debugConsoleLines, setDebugConsoleLines] = useState([{ type: 'info', text: 'Debug console attached.', ts: Date.now() }]);
  const [ports, setPorts] = useState([
    { port: 5173, protocol: 'https', state: 'running', label: 'Vite Dev Server', visibility: 'private', pid: 1024 },
  ]);
  const [chatTodos, setChatTodos] = useState([]);
  const [pinnedFilePath, setPinnedFilePath] = useState(() => {
    const saved = loadJSON(PINNED_RULES_KEY, null);
    return typeof saved === 'string' ? saved : null;
  });
  const [pinnedFileOpen, setPinnedFileOpen] = useState(true);
  const [changesBarOpen, setChangesBarOpen] = useState(true);
  const [selectedChangeMsgId, setSelectedChangeMsgId] = useState('');
  const [timelineOpen, setTimelineOpen] = useState(false);

  const [canInstallPwa, setCanInstallPwa] = useState(false);
  const [isPwaInstalled, setIsPwaInstalled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone === true;
  });
  const installPromptRef = useRef(null);

  // ── Chat ──────────────────────────────────────────────────────────────────
  // Circuit-breaker limits: pause after this many consecutive tool rounds.
  // Token ceiling is warning-only (never blocks input).
  const MAX_TOOL_ROUNDS = 60;
  const TOKEN_CEILING_DEFAULT = 120_000;
  const TOKEN_CEILING_DEEPSEEK = 220_000;

  const [chatInput, setChatInput] = useState('');
  const [chatImage, setChatImage] = useState(null);
  const [messages, setMessages] = useState([]);
  const [copiedMsgKey, setCopiedMsgKey] = useState('');
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [isTyping, setIsTyping] = useState(false);
  const [chatQuietMode, setChatQuietMode] = useState(() => loadJSON(CHAT_QUIET_MODE_KEY, true) !== false);
  const [showLiveProgressDetails, setShowLiveProgressDetails] = useState(false);
  const [agentRunState, setAgentRunState] = useState(AGENT_RUN_STATES.IDLE);
  const [sessionTokens, setSessionTokens] = useState(0);
  const [steerInput, setSteerInput] = useState('');
  const [isSteerOpen, setIsSteerOpen] = useState(false);
  const steerInputRef = useRef(null);
  const [chatMode, setChatMode] = useState(() => loadJSON(MODE_KEY, 'agent'));
  const [activeAgent, setActiveAgent] = useState(() => loadJSON(AGENT_KEY, 'epicode-agent'));
  const tokenCeiling = activeAgent === 'deepseek' ? TOKEN_CEILING_DEEPSEEK : TOKEN_CEILING_DEFAULT;
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
  const [conversations, setConversations] = useState(() => loadJSON(CONVOS_KEY, [{ id: 1, name: 'Chat 1', messages: [], agent: 'epicode-agent', createdAt: Date.now() }]));
  const [activeConvoId, setActiveConvoId] = useState(() => conversations[0]?.id ?? 1);
  const convoCountRef = useRef(Math.max(...conversations.map(c => c.id), 1));

  // ── Resizing ──────────────────────────────────────────────────────────────
  const [screenWidth, setScreenWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200);
  const isMobile = screenWidth < 768;
  const isTablet = screenWidth >= 768 && screenWidth < 1024;
  const [leftWidth, setLeftWidth] = useState(isMobile ? 280 : 240);
  const [rightWidth, setRightWidth] = useState(isMobile ? window.innerWidth : isTablet ? 300 : 320);
  const [termHeight, setTermHeight] = useState(isMobile ? 200 : 256);
  const [isDragging, setIsDragging] = useState(null);
  const isIpad = useMemo(() => isIpadDevice(), []);
  const [liteModePreference, setLiteModePreference] = useState(() => {
    const saved = loadJSON(LITE_MODE_KEY, null);
    if (saved === null) return null;
    return !!saved;
  });

  // ── Editor extras ─────────────────────────────────────────────────────────
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const [fontSize, setFontSize] = useState(() => loadJSON(PREFS_KEY, { fontSize: 13, wordWrap: false }).fontSize);
  const [wordWrap, setWordWrap] = useState(() => loadJSON(PREFS_KEY, { fontSize: 13, wordWrap: false }).wordWrap);
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [savedIndicator, setSavedIndicator] = useState(false);
  const [activeMenu, setActiveMenu] = useState(null);
  const [showAbout, setShowAbout] = useState(false);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [wcServerUrl, setWcServerUrl] = useState('');
  const [directPreviewUrl, setDirectPreviewUrl] = useState('');
  const setPreviewUrl = setWcServerUrl; // alias used by WebContainerTerminal
  // Lazy-load gate: the user must explicitly tap "Load Preview" before the
  // WebContainer preview iframe loads. Auto-loading it immediately after
  // server-ready causes a WASM memory spike that aborts the shell on Safari.
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [showStorageMonitor, setShowStorageMonitor] = useState(false);
  const [showDeployModal,          setShowDeployModal]          = useState(false);
  const [showConnectionsManager,   setShowConnectionsManager]   = useState(false);
  const [deployConnections,        setDeployConnections]        = useState(() => loadConnections());
  const [storageMonitor, setStorageMonitor] = useState({
    usage: 0,
    quota: 0,
    reserved: 0,
    percent: 0,
    source: 'browser',
    localBytes: 0,
    snapshotCount: 0,
    lastUpdated: 0,
  });

  // ── Refs ──────────────────────────────────────────────────────────────────
  const chatScrollRef = useRef(null);
  const chatEndRef = useRef(null);
  const changeLedgerRef = useRef(new Map());
  const editorRef = useRef(null);
  const menuBarRef = useRef(null);
  const termInputRef = useRef(null);
  const handleSaveRef = useRef(null);
  const handleNewFileRef = useRef(null);
  const handleTerminalCommandRef = useRef(null);
  const wcTermRefs = useRef(new Map()); // runtime terminal id -> imperative handle
  const activeRuntimeTerminalIdRef = useRef('runtime-1');
  const terminalOutputRef = useRef([]); // ring buffer — last 300 lines of terminal output
  // AbortController for the active chat fetch loop — aborted on new submission or unmount
  const chatAbortRef = useRef(null);
  const agentSubmitRef = useRef(null);
  const autoDevStartedRef = useRef(false);
  const autoDevProcessRef = useRef(null);
  const autoDevRetryAfterRef = useRef(0);
  const autoDevLastErrorToastRef = useRef({ key: '', at: 0 });
  const lastAutoSnapshotHashRef = useRef('');
  const lastAutoSnapshotAtRef = useRef(0);
  const storageWarnedRef = useRef({ w80: false, w90: false });
  const backupReminderShownRef = useRef(false);

  // ── Track screen width (drives reactive isMobile / isTablet) ────────────
  useEffect(() => {
    const ac = new AbortController();
    window.addEventListener('resize', () => setScreenWidth(window.innerWidth), { signal: ac.signal });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    activeRuntimeTerminalIdRef.current = activeRuntimeTerminalId;
  }, [activeRuntimeTerminalId]);

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
  const [activeMobileTab, setActiveMobileTab] = useState('editor'); // 'explorer' | 'editor' | 'terminal' | 'chat'
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [activeMobileMenuName, setActiveMobileMenuName] = useState(null);
  const projectStats = useMemo(() => {
    const entries = Object.values(fileSystem || {});
    const fileCount = entries.length;
    const totalBytes = entries.reduce((n, f) => n + (typeof f?.content === 'string' ? f.content.length : Number(f?.size || 0)), 0);
    return { fileCount, totalBytes };
  }, [fileSystem]);
  const shouldSuggestLite = isIpad && (projectStats.fileCount >= 180 || projectStats.totalBytes >= 1_600_000);
  const liteModeEnabled = liteModePreference === null ? shouldSuggestLite : !!liteModePreference;

  useEffect(() => {
    if (!shouldSuggestLite || liteModePreference !== null) return;
    toast?.info?.('Lite performance mode auto-enabled for this large iPad workspace. You can switch it off from the quick actions bar.');
  }, [shouldSuggestLite, liteModePreference, toast]);

  useEffect(() => {
    const onBeforeInstallPrompt = (event) => {
      event.preventDefault();
      installPromptRef.current = event;
      setCanInstallPwa(true);
    };
    const onInstalled = () => {
      installPromptRef.current = null;
      setCanInstallPwa(false);
      setIsPwaInstalled(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!projectStats.fileCount) return;
    if (backupReminderShownRef.current) return;
    const lastBackupAt = Number(loadJSON(LAST_BACKUP_AT_KEY, 0) || 0);
    const hoursSince = lastBackupAt > 0 ? (Date.now() - lastBackupAt) / 3600000 : Number.POSITIVE_INFINITY;
    if (hoursSince < 12) return;
    backupReminderShownRef.current = true;
    toast?.warn?.('Reminder: export a compressed backup before longer edit sessions.');
  }, [projectStats.fileCount, toast]);

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

  // Keep preview URL + auto-dev guard aligned with container lifecycle.
  useEffect(() => bridge.onState((state) => {
    if (state !== 'ready') {
      autoDevStartedRef.current = false;
      setWcServerUrl('');
      setDirectPreviewUrl('');
    }
  }), []);

  // When a new server URL arrives: switch to Preview tab but do NOT auto-load
  // the iframe. Loading it immediately causes a memory spike that aborts the
  // shell on Safari (the WebContainer service worker spins up handling the
  // first SSR request right as Next.js/Vite is still initialising).
  // The user taps "Load Preview" when they're ready — by then the server has
  // settled and the load doesn't trigger an OOM abort.
  useEffect(() => {
    if (!wcServerUrl) return;
    setPreviewLoaded(false);          // reset gate for new URL
    setTerminalState('open');
    setActiveTerminalTab('preview');
  }, [wcServerUrl]);

  // Auto-start runtime server when user opens Preview and no live URL exists.
  useEffect(() => {
    if (activeTerminalTab !== 'preview') return;
    if (wcServerUrl) return;
    if (autoDevStartedRef.current) return;
    if (Date.now() < autoDevRetryAfterRef.current) return;

    autoDevStartedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        if (typeof window !== 'undefined' && !window.crossOriginIsolated) {
          toast.warn('Live React preview requires cross-origin isolation headers (COOP/COEP).');
          autoDevStartedRef.current = false;
          return;
        }

        const detectPmFromFiles = () => {
          let pkg = {};
          try {
            pkg = JSON.parse(fileSystem['package.json']?.content || '{}');
          } catch {
            pkg = {};
          }
          const pmField = String(pkg.packageManager || '').toLowerCase();
          const hasPnpmLock = !!fileSystem['pnpm-lock.yaml'];
          const hasYarnLock = !!fileSystem['yarn.lock'];
          const hasBunLock = !!fileSystem['bun.lockb'];
          if (pmField.startsWith('pnpm') || hasPnpmLock) return 'pnpm';
          if (pmField.startsWith('yarn') || hasYarnLock) return 'yarn';
          if (pmField.startsWith('bun') || hasBunLock) return 'bun';
          return 'npm';
        };

        const pm = detectPmFromFiles();
        const bootCmd = pm === 'pnpm'
          ? 'pnpm install --prod=false && pnpm run dev'
          : pm === 'yarn'
            ? 'yarn install && yarn dev'
            : pm === 'bun'
              ? 'bun install && bun run dev'
              : 'npm install --include=dev && npm run dev';

        logger.info('runtime', `preview auto-start using ${pm}: ${bootCmd}`);

        await bridge.boot({ files: fileSystem });
        if (cancelled) return;

        const container = bridge.getContainer();
        const proc = await container.spawn('jsh', ['-lc', bootCmd], {
          terminal: { cols: 80, rows: 24 },
        });
        autoDevProcessRef.current = proc;
        autoDevRetryAfterRef.current = 0;

        // Fire-and-forget output drain so backpressure never stalls the process.
        proc.output.pipeTo(new WritableStream({
          write(chunk) {
            if (typeof chunk === 'string') logger.info('runtime', chunk.trim());
          },
        })).catch(() => {});
      } catch (err) {
        autoDevStartedRef.current = false;
        autoDevRetryAfterRef.current = Date.now() + 30_000;
        const msg = `Preview auto-start failed: ${err?.message || err}`;
        const last = autoDevLastErrorToastRef.current;
        const duplicate = last.key === msg && (Date.now() - last.at) < 15_000;
        if (!duplicate) {
          autoDevLastErrorToastRef.current = { key: msg, at: Date.now() };
          toast.error(msg);
        } else {
          logger.warn('runtime', msg);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [activeTerminalTab, wcServerUrl, fileSystem, toast]);

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

  const estimateLocalStorageBytes = useCallback(() => {
    try {
      let total = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        const v = localStorage.getItem(k) || '';
        total += (k.length + v.length) * 2;
      }
      return total;
    } catch {
      return 0;
    }
  }, []);

  const refreshStorageMonitor = useCallback(async () => {
    let usage = 0;
    let quota = 0;
    let reserved = 0;
    let source = 'browser';

    try {
      if (fsMode === 'opfs') {
        const u = await FsClient.usage();
        usage = Number(u?.usage || 0);
        quota = Number(u?.quota || 0);
        reserved = Number(u?.reserved || 0);
        source = 'opfs';
      } else {
        const est = await navigator.storage?.estimate?.();
        usage = Number(est?.usage || 0);
        quota = Number(est?.quota || 0);
      }
    } catch {
      // Keep monitor resilient; fallback values below still render.
    }

    const localBytes = estimateLocalStorageBytes();
    const snapshots = loadJSON(SNAPSHOTS_KEY, []);
    const snapshotCount = Array.isArray(snapshots) ? snapshots.length : 0;
    const effectiveUsage = Math.max(usage, localBytes);
    const percent = quota > 0 ? Math.round((effectiveUsage / quota) * 100) : 0;

    setStorageMonitor({
      usage: effectiveUsage,
      quota,
      reserved,
      percent,
      source,
      localBytes,
      snapshotCount,
      lastUpdated: Date.now(),
    });

    if (percent >= 90 && !storageWarnedRef.current.w90) {
      storageWarnedRef.current.w90 = true;
      toast?.error?.('Storage usage is above 90%. Open the Storage Monitor to clean up snapshots before writes fail.');
    } else if (percent >= 80 && !storageWarnedRef.current.w80) {
      storageWarnedRef.current.w80 = true;
      toast?.warn?.('Storage usage is above 80%. Consider pruning snapshots in Storage Monitor.');
    } else if (percent < 80) {
      storageWarnedRef.current.w80 = false;
      storageWarnedRef.current.w90 = false;
    }
  }, [estimateLocalStorageBytes, fsMode, toast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshStorageMonitor();
      if (cancelled) return;
    })();
    const id = setInterval(() => { void refreshStorageMonitor(); }, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshStorageMonitor]);

  useEffect(() => {
    const t = setTimeout(() => { void refreshStorageMonitor(); }, 900);
    return () => clearTimeout(t);
  }, [fileSystem, refreshStorageMonitor]);

  const handlePruneSnapshots = useCallback(() => {
    const snapshots = loadJSON(SNAPSHOTS_KEY, []);
    if (!Array.isArray(snapshots) || snapshots.length <= 5) {
      toast?.info?.('Nothing to prune.');
      return;
    }
    const next = snapshots.slice(0, 5);
    storeJSON(SNAPSHOTS_KEY, next);
    toast?.success?.(`Pruned ${snapshots.length - next.length} old snapshots.`);
    void refreshStorageMonitor();
  }, [refreshStorageMonitor, toast]);

  const handleClearSnapshots = useCallback(() => {
    const snapshots = loadJSON(SNAPSHOTS_KEY, []);
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      toast?.info?.('No snapshots to clear.');
      return;
    }
    storeJSON(SNAPSHOTS_KEY, []);
    toast?.success?.('Cleared all snapshots.');
    void refreshStorageMonitor();
  }, [refreshStorageMonitor, toast]);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(CONVOS_KEY, JSON.stringify(conversations));
      } catch {
        // Fall back to compact persistence so assistant replies are retained
        // instead of losing the entire conversation on quota pressure.
        try {
          const compact = compactConversationsForStorage(conversations, 120);
          localStorage.setItem(CONVOS_KEY, JSON.stringify(compact));
        } catch {
          try {
            const compactHard = compactConversationsForStorage(conversations, 60);
            localStorage.setItem(CONVOS_KEY, JSON.stringify(compactHard));
          } catch {
            // Final fallback: keep most recent conversation only.
            try {
              const latest = compactConversationsForStorage(conversations.slice(-1), 80);
              localStorage.setItem(CONVOS_KEY, JSON.stringify(latest));
            } catch {
              /* no-op */
            }
          }
        }
      }
    }, 400);
    return () => clearTimeout(t);
  }, [conversations]);
  useEffect(() => { storeJSON(AGENT_KEY, activeAgent); }, [activeAgent]);
  useEffect(() => { storeJSON(MODELS_KEY, activeModels); }, [activeModels]);
  useEffect(() => { storeJSON(MODE_KEY, chatMode); }, [chatMode]);
  useEffect(() => { storeJSON(CHAT_QUIET_MODE_KEY, chatQuietMode); }, [chatQuietMode]);
  useEffect(() => {
    const t = setTimeout(() => storeJSON(PREFS_KEY, { fontSize, wordWrap }), 300);
    return () => clearTimeout(t);
  }, [fontSize, wordWrap]);
  useEffect(() => {
    const t = setTimeout(() => storeJSON(PANELS_KEY, { sidebarOpen, rightSidebarOpen, terminalState }), 300);
    return () => clearTimeout(t);
  }, [sidebarOpen, rightSidebarOpen, terminalState]);
  useEffect(() => { storeJSON(PREVIEW_MODE_KEY, previewRenderMode === 'live' ? 'live' : 'static'); }, [previewRenderMode]);
  useEffect(() => {
    if (typeof pinnedFilePath === 'string' && pinnedFilePath) storeJSON(PINNED_RULES_KEY, pinnedFilePath);
    else storeJSON(PINNED_RULES_KEY, null);
  }, [pinnedFilePath]);

  // ── Gist sync: debounced push on every FS change ──────────────────────────
  const [gistSyncStatus, setGistSyncStatus] = useState('idle'); // 'idle'|'syncing'|'ok'|'error'
  const gistSyncTimerRef = useRef(null);
  useEffect(() => {
    if (!isGistSyncEnabled()) return;
    clearTimeout(gistSyncTimerRef.current);
    gistSyncTimerRef.current = setTimeout(async () => {
      setGistSyncStatus('syncing');
      const result = await pushToGist(fileSystem, projectName, projectRepoUrl);
      setGistSyncStatus(result.ok ? 'ok' : 'error');
      if (!result.ok) console.warn('[GistSync] push failed:', result.error);
    }, 3000); // 3 s debounce — only push when user pauses
    return () => clearTimeout(gistSyncTimerRef.current);
  }, [fileSystem, projectName]);

  // ── Chat scroll behavior ─────────────────────────────────────────────────
  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsNearBottom(remaining < 72);
  }, []);

  useEffect(() => {
    if (!isNearBottom) return;
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping, isNearBottom]);

  // ── Resizing logic (mouse + touch) ────────────────────────────────────────
  useEffect(() => {
    if (!isDragging) return;
    const getXY = (e) => e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };
    const onMove = (e) => {
      const { x, y } = getXY(e);
      if (isDragging === 'left') setLeftWidth(Math.max(160, Math.min(sm ? screenWidth * 0.85 : 600, x)));
      else if (isDragging === 'right') setRightWidth(Math.max(250, Math.min(sm ? screenWidth : 800, window.innerWidth - x)));
      else if (isDragging === 'terminal') setTermHeight(Math.max(80, Math.min(Math.floor(window.innerHeight * 0.65), window.innerHeight - y - 24)));
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
    if (liteModeEnabled) return [];
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
  }, [deferredFS, liteModeEnabled]);

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
    const previewErrorOverlayScript = `<script>
(function () {
  function ensureOverlay() {
    let el = document.getElementById('__epicode_preview_error__');
    if (!el) {
      el = document.createElement('div');
      el.id = '__epicode_preview_error__';
      el.style.position = 'fixed';
      el.style.left = '0';
      el.style.right = '0';
      el.style.bottom = '0';
      el.style.maxHeight = '45vh';
      el.style.overflow = 'auto';
      el.style.background = 'rgba(13, 5, 32, 0.96)';
      el.style.borderTop = '1px solid rgba(244, 114, 182, 0.5)';
      el.style.color = '#fca5a5';
      el.style.padding = '10px 12px';
      el.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
      el.style.fontSize = '12px';
      el.style.zIndex = '2147483647';
      document.body.appendChild(el);
    }
    return el;
  }
  function showError(title, detail) {
    const el = ensureOverlay();
    const safeTitle = String(title || 'Preview error');
    const safeDetail = String(detail || '').slice(0, 6000);
    el.innerHTML = '<div style="font-weight:700;color:#fda4af;margin-bottom:4px">' + safeTitle + '</div>' +
      '<pre style="white-space:pre-wrap;margin:0;color:#fecaca">' + safeDetail + '</pre>';
  }
  window.addEventListener('error', function (ev) {
    showError('Runtime error', (ev && (ev.error && ev.error.stack || ev.message)) || 'Unknown error');
  });
  window.addEventListener('unhandledrejection', function (ev) {
    const reason = ev && ev.reason;
    showError('Unhandled promise rejection', reason && reason.stack ? reason.stack : String(reason || 'Unknown rejection'));
  });
})();
<\/script>`;

    const appendPreviewOverlay = (doc) => {
      if (!doc) return doc;
      if (/<\/body>/i.test(doc)) return doc.replace(/<\/body>/i, `${previewErrorOverlayScript}\n</body>`);
      return doc + previewErrorOverlayScript;
    };

    const BABEL_PREVIEW_MAX_MODULES = 40;
    const BABEL_PREVIEW_MAX_SOURCE_CHARS = 220000;

    const buildLargeProjectPreviewDoc = (reason) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Preview Safety Mode</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0f0620; color: #e9d5ff; }
      .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .card { width: min(760px, 100%); border: 1px solid rgba(217, 70, 239, 0.35); background: rgba(31, 12, 59, 0.9); border-radius: 12px; padding: 16px; box-shadow: 0 12px 42px rgba(0, 0, 0, 0.35); }
      h1 { margin: 0 0 8px; font-size: 16px; color: #f0abfc; }
      p { margin: 6px 0; font-size: 13px; line-height: 1.5; color: #e9d5ff; }
      code { background: rgba(0, 0, 0, 0.25); border: 1px solid rgba(217, 70, 239, 0.25); border-radius: 6px; padding: 1px 6px; color: #f5d0fe; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>Preview Safety Mode Enabled</h1>
        <p>This workspace is too large for the inline Babel preview path, which can become unstable and throw generic script errors.</p>
        <p>${reason}</p>
        <p>For full fidelity, switch to <code>Live</code> preview (Runtime tab) so the app runs through the real dev server.</p>
      </div>
    </div>
  </body>
</html>`;

    const buildReactBabelPreview = (fs) => {
      const entryCandidates = ['src/index.jsx', 'src/main.jsx', 'src/index.tsx', 'src/main.tsx', 'src/index.js', 'src/main.js'];
      const entryPath = entryCandidates.find((p) => typeof fs[p]?.content === 'string' && fs[p].content.trim().length > 0);
      if (!entryPath) return { doc: null, disabledReason: '' };

      const excluded = new Set(['pictureeditor.css', 'pictureeditor.jsx', 'pictureedoitor.jsx']);
      let combinedCss = '';
      let combinedCode = '';
      let entryCode = '';
      let moduleCount = 0;
      let sourceChars = 0;

      Object.entries(fs).forEach(([filePath, f]) => {
        if (!filePath.startsWith('src/') || !f?.content) return;
        const name = filePath.split('/').pop().toLowerCase();
        if (excluded.has(name)) return;

        if (name.endsWith('.css')) {
          combinedCss += f.content + '\n';
          return;
        }

        if (!/\.(jsx|tsx|js|ts)$/i.test(name)) return;
        if (name.endsWith('.d.ts') || /\.(test|spec)\.[jt]sx?$/i.test(name)) return;

        moduleCount += 1;
        sourceChars += f.content.length;

        const cleaned = f.content
          .replace(/^\s*import[\s\S]*?;\s*$/gm, '')
          .replace(/^\s*export\s+default\s+/gm, '')
          .replace(/^\s*export\s+/gm, '')
          .replace(/import\.meta\.env\.[A-Z0-9_]*/g, 'undefined')
          .replace(/import\.meta\.hot\b/g, 'undefined')
          .replace(/import\.meta\.url\b/g, '"about:blank"')
          .replace(/import\.meta\b/g, '{}')
          .trim();

        if (!cleaned) return;
        if (filePath === entryPath) entryCode = cleaned;
        else combinedCode += cleaned + '\n\n';
      });

      if (moduleCount > BABEL_PREVIEW_MAX_MODULES || sourceChars > BABEL_PREVIEW_MAX_SOURCE_CHARS) {
        const reason = `Detected ${moduleCount} source modules / ${Math.round(sourceChars / 1024)} KB source size (limit: ${BABEL_PREVIEW_MAX_MODULES} modules or ${Math.round(BABEL_PREVIEW_MAX_SOURCE_CHARS / 1024)} KB).`;
        return { doc: null, disabledReason: reason };
      }

      const finalCode = (combinedCode.trim() + '\n\n' + entryCode.trim())
        .replace(/(?<!ReactDOM\.)\bcreateRoot\b/g, 'ReactDOM.createRoot')
        .replace(/<\/script>/gi, '<\\/script>')
        .trim();

      if (!finalCode) return { doc: null, disabledReason: '' };

      return { doc: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Preview</title>
    <style>${combinedCss.trim()}</style>
  </head>
  <body>
    <div id="root"></div>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <script type="text/babel" data-presets="typescript,react">
      const { useState, useRef, useEffect, useCallback, useMemo, useContext, useReducer, useLayoutEffect, useId, useTransition, useDeferredValue, useImperativeHandle, useInsertionEffect, createContext, createRef, forwardRef, memo, Fragment, Children, cloneElement, isValidElement, Component, PureComponent, StrictMode } = React;
      const { createPortal } = ReactDOM;
${finalCode}
    </script>
  </body>
</html>`, disabledReason: '' };
    };

    const { doc: babelPreviewDoc, disabledReason: babelPreviewDisabledReason } = buildReactBabelPreview(debouncedFS);

    // Keep compatibility with existing generate.js flow, but use the same robust builder.
    if (debouncedFS['generate.js'] && babelPreviewDoc) {
      setPreviewSourcePath('React entry (Babel)');
      setPreviewDoc(appendPreviewOverlay(babelPreviewDoc));
      return;
    }
    if (debouncedFS['generate.js'] && !babelPreviewDoc && babelPreviewDisabledReason) {
      setPreviewSourcePath('Preview safety mode');
      setPreviewDoc(appendPreviewOverlay(buildLargeProjectPreviewDoc(babelPreviewDisabledReason)));
      return;
    }

    const activeHtmlPath = activeFile && activeFile.endsWith('.html') && debouncedFS[activeFile] ? activeFile : null;
    const htmlEntryPath = activeHtmlPath
      || (debouncedFS['index.html'] ? 'index.html' : Object.keys(debouncedFS).find((k) => k.endsWith('.html')))
      || null;
    const htmlEntry = htmlEntryPath ? debouncedFS[htmlEntryPath] : null;
    if (!htmlEntry) {
      if (babelPreviewDoc) setPreviewSourcePath('React entry (Babel)');
      if (!babelPreviewDoc && babelPreviewDisabledReason) {
        setPreviewSourcePath('Preview safety mode');
        setPreviewDoc(appendPreviewOverlay(buildLargeProjectPreviewDoc(babelPreviewDisabledReason)));
      } else {
        setPreviewDoc(babelPreviewDoc ? appendPreviewOverlay(babelPreviewDoc) : null);
      }
      return;
    }

    setPreviewSourcePath(htmlEntryPath || 'index.html');

    let html = htmlEntry.content;

    const hasViteLikeModuleEntry =
      /<script[^>]*type=["']module["'][^>]*src=["'][^"']*\/src\/[^"']+\.(jsx|tsx|js|ts)["'][^>]*><\/script>/i.test(html) ||
      /<script[^>]*src=["'][^"']*\/src\/[^"']+\.(jsx|tsx|js|ts)["'][^>]*type=["']module["'][^>]*><\/script>/i.test(html);
    if (hasViteLikeModuleEntry && babelPreviewDoc) {
      setPreviewSourcePath('React entry (Babel)');
      setPreviewDoc(appendPreviewOverlay(babelPreviewDoc));
      return;
    }
    if (hasViteLikeModuleEntry && !babelPreviewDoc && babelPreviewDisabledReason) {
      setPreviewSourcePath('Preview safety mode');
      setPreviewDoc(appendPreviewOverlay(buildLargeProjectPreviewDoc(babelPreviewDisabledReason)));
      return;
    }

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
      setPreviewDoc(appendPreviewOverlay(html));
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
      if (!cancelled) setPreviewDoc(appendPreviewOverlay(enriched));
    })();

    return () => { cancelled = true; };
  }, [debouncedFS, previewKey, activeFile]); // previewKey forces a rebuild on manual refresh

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

  const handleInstallPwa = useCallback(async () => {
    const prompt = installPromptRef.current;
    if (prompt?.prompt) {
      try {
        await prompt.prompt();
        await prompt.userChoice;
      } catch {
        // Browser ignored prompt or user dismissed it.
      }
      installPromptRef.current = null;
      setCanInstallPwa(false);
      return;
    }
    if (isIpad) {
      toast?.info?.('To install on iPad Safari: Share → Add to Home Screen.');
      return;
    }
    toast?.info?.('Install prompt is not available yet. Reload after using HTTPS and interacting with the app.');
  }, [isIpad, toast]);

  const handleEditorUndo = useCallback(() => {
    const editor = editorRef.current?.getMonaco?.();
    editor?.trigger('keyboard', 'undo', null);
  }, []);

  const handleEditorRedo = useCallback(() => {
    const editor = editorRef.current?.getMonaco?.();
    editor?.trigger('keyboard', 'redo', null);
  }, []);

  const handleToggleLiteMode = useCallback(() => {
    setLiteModePreference((prev) => {
      const next = prev === null ? false : !prev;
      storeJSON(LITE_MODE_KEY, next);
      return next;
    });
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
  useEffect(() => { storeJSON('epicodespace_project_repo_v1', projectRepoUrl); }, [projectRepoUrl]);

  const buildWorkspaceSnapshot = useCallback(() => {
    const latest = getLatest();
    const validTabs = openTabs.filter((p) => latest[p]);
    const nextActive = activeFile && latest[activeFile]
      ? activeFile
      : (validTabs[0] || Object.keys(latest)[0] || null);
    return {
      files: latest,
      projectName,
      repoUrl: projectRepoUrl,
      openTabs: validTabs,
      activeFile: nextActive,
      previewRenderMode,
      previewSourcePath,
    };
  }, [getLatest, openTabs, activeFile, projectName, projectRepoUrl, previewRenderMode, previewSourcePath]);

  const handleSaveSnapshot = useCallback((opts = {}) => {
    const { manual = true } = opts;
    const payload = buildWorkspaceSnapshot();
    const entry = saveLocalSnapshot(payload);
    if (!entry) {
      if (manual) toast.error('Snapshot save failed.');
      return false;
    }
    const hash = stableStringify(payload);
    lastAutoSnapshotHashRef.current = hash;
    lastAutoSnapshotAtRef.current = Date.now();
    if (manual) {
      toast.success(`Snapshot saved (${Object.keys(payload.files).length} files).`);
    }
    return true;
  }, [buildWorkspaceSnapshot, toast]);

  const handleRestoreLatestSnapshot = useCallback(() => {
    const loaded = loadLatestSnapshot();
    if (!loaded?.snapshot) {
      toast.warn('No snapshot found.');
      return;
    }
    const snap = loaded.snapshot;
    replaceAll(snap.files || {});
    setProjectName(snap.projectName || 'My Project');
    if (snap.repoUrl !== undefined) setProjectRepoUrl(snap.repoUrl || '');
    setOpenTabs(Array.isArray(snap.openTabs) ? snap.openTabs : []);
    setActiveFile(snap.activeFile || null);
    setPreviewRenderMode(snap.previewRenderMode === 'live' ? 'live' : 'static');
    setPreviewSourcePath(snap.previewSourcePath || 'index.html');
    lastAutoSnapshotHashRef.current = stableStringify(snap);
    lastAutoSnapshotAtRef.current = Date.now();
    toast.success(`Snapshot restored from ${new Date(loaded.createdAt).toLocaleString()}.`);
  }, [replaceAll, toast]);

  useEffect(() => {
    const payload = buildWorkspaceSnapshot();
    const hash = stableStringify(payload);
    if (hash === lastAutoSnapshotHashRef.current) return;
    const now = Date.now();
    if (now - lastAutoSnapshotAtRef.current < 15000) return;
    const saved = saveLocalSnapshot(payload);
    if (!saved) return;
    lastAutoSnapshotHashRef.current = hash;
    lastAutoSnapshotAtRef.current = now;
  }, [buildWorkspaceSnapshot, fileSystem]);

  const handleNewProject = useCallback((template, name) => {
    const templates = {
      empty: {},
      react: {
        'src/App.jsx': { name: 'App.jsx', language: 'javascript', content: "import React from 'react';\n\nexport default function App() {\n  return <div>Hello World</div>;\n}\n" },
        'src/index.jsx': { name: 'index.jsx', language: 'javascript', content: "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\n\ncreateRoot(document.getElementById('root')).render(<App />);\n" },
        'src/index.css': { name: 'index.css', language: 'css', content: "body { margin: 0; font-family: sans-serif; }\n" },
        'generate.js': { name: 'generate.js', language: 'javascript', content: "const fs = require('fs');\nconst path = require('path');\n\nconst rootDir = __dirname;\nconst srcDir = path.join(rootDir, 'src');\nconst outputPath = path.join(rootDir, 'index.html');\n\nconst excludedFiles = new Set(['pictureeditor.css', 'pictureeditor.jsx', 'pictureedoitor.jsx']);\nconst files = fs.readdirSync(srcDir);\n\nlet combinedCss = '';\nlet combinedJsx = '';\nlet indexJsx = '';\n\nfor (const file of files) {\n  if (excludedFiles.has(file.toLowerCase())) {\n    continue;\n  }\n\n  const fullPath = path.join(srcDir, file);\n  if (!fs.statSync(fullPath).isFile()) {\n    continue;\n  }\n\n  if (file.endsWith('.css')) {\n    combinedCss += `${fs.readFileSync(fullPath, 'utf8')}\\n`;\n    continue;\n  }\n\n  if (file.endsWith('.jsx')) {\n    const jsx = fs.readFileSync(fullPath, 'utf8');\n    const cleanedJsx = jsx\n      .replace(/^\\s*import[\\s\\S]*?;\\s*$/gm, '')\n      .replace(/^\\s*export\\s+default\\s+/gm, '')\n      .replace(/^\\s*export\\s+/gm, '')\n      .trim();\n\n    if (file === 'index.jsx') {\n      indexJsx = cleanedJsx;\n    } else {\n      combinedJsx += `${cleanedJsx}\\n\\n`;\n    }\n  }\n}\n\nconst finalJsx = `${combinedJsx.trim()}\\n\\n${indexJsx.trim()}`\n  .replace(/createRoot/g, 'ReactDOM.createRoot')\n  .trim();\n\nconst html = `<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n    <title>Instant Preview</title>\n    <style>\n  ${combinedCss.trim()}\n    </style>\n  </head>\n  <body>\n    <div id=\"root\"></div>\n\n    <script crossorigin src=\"https://unpkg.com/react@18/umd/react.development.js\"></script>\n    <script crossorigin src=\"https://unpkg.com/react-dom@18/umd/react-dom.development.js\"></script>\n    <script src=\"https://unpkg.com/@babel/standalone/babel.min.js\"></script>\n\n    <script type=\"text/babel\">\n      const { useState, useRef, useEffect, useCallback } = React;\n\n${finalJsx}\n    </script>\n  </body>\n</html>\n`;\n\nfs.writeFileSync(outputPath, html, 'utf8');\nconsole.log(`Generated ${path.basename(outputPath)} from files in src/`);\n" },
        'index.html': { name: 'index.html', language: 'html', content: '<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>React App</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/index.jsx"></script>\n  </body>\n</html>\n' },
        'vite.config.js': { name: 'vite.config.js', language: 'javascript', content: "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n" },
        'package.json': { name: 'package.json', language: 'json', content: JSON.stringify({ name: 'my-app', version: '1.0.0', type: 'module', scripts: { dev: 'vite', build: 'vite build', generate: 'node generate.js', preview: 'vite preview' }, dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' }, devDependencies: { '@vitejs/plugin-react': '^4.0.0', vite: '^6.0.0' } }, null, 2) + '\n' },
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

  const handleExportProject = useCallback(async () => {
    const files = Object.entries(fileSystem);
    if (files.length === 0) return;
    const bundle = {
      name: projectName,
      files: fileSystem,
      exportedAt: new Date().toISOString(),
      backupVersion: 2,
    };
    const json = JSON.stringify(bundle, null, 2);
    let blob;
    let ext;
    if (canUseStreamCompression()) {
      const bytes = await gzipText(json);
      blob = new Blob([bytes], { type: 'application/gzip' });
      ext = 'epicode.json.gz';
    } else {
      blob = new Blob([json], { type: 'application/json' });
      ext = 'epicode.json';
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName.replace(/[^a-zA-Z0-9-_]/g, '_')}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    storeJSON(LAST_BACKUP_AT_KEY, Date.now());
    toast?.success?.(canUseStreamCompression() ? 'Compressed backup exported.' : 'Backup exported.');
  }, [fileSystem, projectName, toast]);

  const handleGitClone = useCallback(async (url, token, onProgress) => {
    const { files, repoName } = await cloneRepo(url, { token, onProgress });
    if (Object.keys(files).length === 0) throw new Error('No files found in repository.');
    replaceAll(files);
    setProjectName(repoName);
    setProjectRepoUrl(url.trim());
    const first = Object.keys(files)[0] || null;
    setOpenTabs(first ? [first] : []);
    setActiveFile(first);
    toast?.success?.(`Cloned ${Object.keys(files).length} files from ${repoName}.`);
  }, [replaceAll, toast]);

  const handleImportProject = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.epicode.json,.gz,.epicode.gz,.epicode.json.gz';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const bytes = new Uint8Array(await arrayBufferFromFile(file));
        const rawText = isGzipBytes(bytes)
          ? await gunzipToText(bytes)
          : new TextDecoder().decode(bytes);
        const data = JSON.parse(rawText);
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
          setProjectName(data.name || file.name.replace(/\.epicode\.json\.gz$|\.epicode\.json$|\.json\.gz$|\.json$/, ''));
          const first = Object.keys(cleanFS)[0] || null;
          setOpenTabs(first ? [first] : []);
          setActiveFile(first);
          storeJSON(LAST_BACKUP_AT_KEY, Date.now());
          toast?.success?.('Backup imported.');
        }
      } catch {
        toast?.error?.('Import failed: unsupported or corrupted backup file.');
      }
    };
    input.click();
  }, [replaceAll, toast]);

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
    // 1. Exact match
    const exact = content.split(oldText).length - 1;
    if (exact === 1) return { ok: true, content: content.replace(oldText, newText ?? '') };
    if (exact > 1) return { ok: false, error: `oldText is ambiguous — found ${exact} occurrences. Add more surrounding lines to make it unique.` };
    // 2. Fuzzy: normalize \r\n and trim trailing whitespace per line
    const norm = (s) => s.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).join('\n');
    const nc = norm(content);
    const no = norm(oldText);
    const fuzzy = nc.split(no).length - 1;
    if (fuzzy === 1) return { ok: true, content: nc.replace(no, norm(newText ?? '')) };
    if (fuzzy > 1) return { ok: false, error: `oldText is ambiguous (${fuzzy} fuzzy matches). Add more context lines.` };
    return {
      ok: false,
      error: `oldText not found. Whitespace/quote differences are likely.\n→ USE patchLines INSTEAD: call patchLines(path, startLine, endLine, newContent) — it always works.\n→ OR refine oldText with more surrounding context for editFile.\nDo NOT call readFile again — you already have the content.`,
    };
  };

  // ── Execute tool calls against virtual filesystem ────────────────────────
  const executeToolCall = useCallback(async (name, args, currentFS) => {
    const sanitizeShellCommand = (raw) => {
      let cmd = String(raw || '').trim();
      if (!cmd) return '';

      // Strip common markdown/prompt artifacts from model outputs.
      cmd = cmd
        .replace(/^```(?:bash|sh)?\s*/i, '')
        .replace(/```$/i, '')
        .replace(/^\$\s*/, '')
        .replace(/^>\s*/, '')
        .trim();

      // Fix occasional single-letter prefix corruption like "S cd ...".
      cmd = cmd.replace(/^[A-Za-z]\s+(?=(cd|npm|pnpm|yarn|npx|node|bun|git|ls|cat|echo|pwd|cp|mv|rm|mkdir|touch|grep|find)\b)/i, '');

      return cmd.trim();
    };

    const detectPackageManager = () => {
      let pkg = {};
      try { pkg = JSON.parse(currentFS['package.json']?.content || '{}'); } catch { /* ignore */ }
      const packageManager = String(pkg.packageManager || '').toLowerCase();
      const hasPnpmLock = !!currentFS['pnpm-lock.yaml'];
      const hasYarnLock = !!currentFS['yarn.lock'];
      const hasBunLock = !!currentFS['bun.lockb'];
      if (packageManager.startsWith('pnpm') || hasPnpmLock) return 'pnpm';
      if (packageManager.startsWith('yarn') || hasYarnLock) return 'yarn';
      if (packageManager.startsWith('bun') || hasBunLock) return 'bun';
      return 'npm';
    };

    const pmRun = (pm, script) => {
      if (pm === 'pnpm') return `pnpm run ${script}`;
      if (pm === 'yarn') return `yarn run ${script}`;
      if (pm === 'bun') return `bun run ${script}`;
      return `npm run ${script}`;
    };

    const rewriteCommandForPackageManager = (raw) => {
      const cmd = String(raw || '').trim();
      if (!cmd) return cmd;
      if (/[;&|]/.test(cmd)) return cmd;

      const pm = detectPackageManager();
      if (pm === 'npm') return cmd;

      if (/^npm\s+install(?:\s+--include=dev)?\s*$/i.test(cmd)) {
        if (pm === 'pnpm') return 'pnpm install --prod=false';
        if (pm === 'yarn') return 'yarn install';
        if (pm === 'bun') return 'bun install';
      }

      const installMatch = cmd.match(/^npm\s+install(?:\s+--include=dev)?(?:\s+--save-dev)?\s+(.+)$/i);
      if (installMatch) {
        const packages = installMatch[1].trim();
        const wantsDev = /--save-dev/.test(cmd);
        if (pm === 'pnpm') return `pnpm add${wantsDev ? ' -D' : ''} ${packages}`;
        if (pm === 'yarn') return `yarn add${wantsDev ? ' -D' : ''} ${packages}`;
        if (pm === 'bun') return `bun add${wantsDev ? ' -d' : ''} ${packages}`;
      }

      const runMatch = cmd.match(/^npm\s+run\s+([a-z0-9:_-]+)(.*)$/i);
      if (runMatch) {
        return `${pmRun(pm, runMatch[1])}${runMatch[2] || ''}`;
      }

      const scriptMatch = cmd.match(/^npm\s+(test|start|build|dev|lint)(.*)$/i);
      if (scriptMatch) {
        return `${pmRun(pm, scriptMatch[1].toLowerCase())}${scriptMatch[2] || ''}`;
      }

      return cmd;
    };

    switch (name) {
      case 'readFile': {
        const f = currentFS[args.path];
        if (!f) return { ok: false, error: `File not found: ${args.path}` };
        const safeContent = f.content ?? '';
        const lines = safeContent.split('\n');
        const totalLines = lines.length;
        const hasRange = Number.isFinite(args.startLine) || Number.isFinite(args.endLine);
        const s = hasRange ? Math.max(1, Math.min(parseInt(args.startLine, 10) || 1, totalLines)) : 1;
        const e = hasRange ? Math.max(s, Math.min(parseInt(args.endLine, 10) || totalLines, totalLines)) : totalLines;
        const chunk = lines.slice(s - 1, e).join('\n');
        const maxChars = Math.max(1000, Math.min(parseInt(args.maxChars, 10) || 60000, 200000));
        const limited = chunk.length > maxChars ? `${chunk.slice(0, maxChars)}\n... [truncated ${chunk.length - maxChars} chars]` : chunk;
        return {
          ok: true,
          path: args.path,
          content: limited,
          language: f.language,
          lines: totalLines,
          startLine: s,
          endLine: e,
          truncated: chunk.length > maxChars,
          note: hasRange ? `Returned lines ${s}-${e} of ${totalLines}` : `Returned full file (${totalLines} lines)`,
        };
      }
      case 'writeFile': {
        if (!args.path || typeof args.path !== 'string') return { ok: false, error: 'writeFile: path is required' };
        const existing = currentFS[args.path];
        const existingContent = existing?.content ?? '';
        const existingLang = currentFS[args.path]?.language;
        const lang = existingLang || (
          args.path.endsWith('.jsx') || args.path.endsWith('.js') ? 'javascript'
          : args.path.endsWith('.tsx') || args.path.endsWith('.ts') ? 'typescript'
          : args.path.endsWith('.css') ? 'css'
          : args.path.endsWith('.json') ? 'json'
          : args.path.endsWith('.md') ? 'markdown'
          : args.path.endsWith('.html') ? 'html' : 'text');
        const safeContent = args.content ?? '';

        // Guardrail: prevent accidental truncation when an existing file is rewritten
        // with partial model output. Require patchLines/editFile for large edits.
        if (existing && typeof existingContent === 'string') {
          const oldLines = existingContent.split('\n').length;
          const newLines = safeContent.split('\n').length;
          if (!safeContent.trim()) {
            return {
              ok: false,
              blocked: true,
              error: `Blocked writeFile on existing file: ${args.path}. Empty overwrite would erase file content. Use patchLines/editFile for targeted changes.`,
            };
          }
          if (oldLines >= 80 && newLines < Math.floor(oldLines * 0.6)) {
            return {
              ok: false,
              blocked: true,
              error: `Blocked writeFile on existing file: ${args.path}. New content appears truncated (${newLines}/${oldLines} lines). Use patchLines/editFile instead of whole-file overwrite.`,
            };
          }
        }

        return { ok: true, action: 'write', path: args.path, language: lang, content: safeContent, lines: safeContent.split('\n').length };
      }
      case 'editFile': {
        const f = currentFS[args.path];
        if (!f) return { ok: false, error: `File not found: ${args.path}` };
        const patch = applyPatch(f.content ?? '', args.oldText ?? '', args.newText ?? '');
        if (!patch.ok) return patch;
        return { ok: true, action: 'edit', path: args.path, content: patch.content, lines: patch.content.split('\n').length };
      }
      case 'patchLines': {
        const { path: pPath, startLine, endLine, newContent: pNewContent } = args;
        if (!pPath) return { ok: false, error: 'path is required' };
        const pf = currentFS[pPath];
        if (!pf) return { ok: false, error: `File not found: ${pPath}` };
        const pLines = (pf.content ?? '').split('\n');
        const total = pLines.length;
        const s = Math.max(1, Math.min(parseInt(startLine) || 1, total));
        const e = Math.max(s, Math.min(parseInt(endLine) || s, total));
        const insertLines = (pNewContent ?? '').split('\n');
        const result = [...pLines.slice(0, s - 1), ...insertLines, ...pLines.slice(e)];
        const patched = result.join('\n');
        return { ok: true, action: 'edit', path: pPath, content: patched, lines: result.length, note: `Replaced lines ${s}–${e} (${e - s + 1} original → ${insertLines.length} new)` };
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
        const tools = createSharedAgentTools(currentFS, targetPath);
        return tools.analyzeFile.execute(targetPath);
      }
      case 'runCommand': {
        // Require user confirmation before running destructive-looking commands
        const sanitized = sanitizeShellCommand(args.command);
        const cmd = rewriteCommandForPackageManager(sanitized);
        if (!cmd) return { ok: false, error: 'runCommand: empty or invalid command after sanitization.' };
        const isDestructive = /\brm\b|\brmdir\b|\bdrop\b|\bdelete\b|\bformat\b|>\s*\//.test(cmd);
        if (isDestructive) {
          const ok = await toast.confirm(`The AI agent wants to run:\n\n  ${cmd}\n\nAllow this command?`, { danger: true, confirmLabel: 'Allow' });
          if (!ok) return { ok: false, error: 'User cancelled command execution.' };
        }
        return {
          ok: true,
          action: 'runCommand',
          command: cmd,
          note: cmd === sanitized
            ? `Command dispatched: \`${cmd}\`. Follow immediately with getTerminalOutput or getProblems to verify results.`
            : `Command dispatched: \`${cmd}\` (normalized from \`${sanitized}\`). Follow immediately with getTerminalOutput or getProblems to verify results.`,
        };
      }
      case 'runTests': {
        const pm = detectPackageManager();
        const override = sanitizeShellCommand(args.command);
        const cmd = override || pmRun(pm, 'test');
        return { ok: true, action: 'runCommand', command: cmd, note: `Dispatched tests (${pm}): ${cmd}` };
      }
      case 'runLint': {
        const pm = detectPackageManager();
        const override = sanitizeShellCommand(args.command);
        const cmd = override || pmRun(pm, 'lint');
        return { ok: true, action: 'runCommand', command: cmd, note: `Dispatched lint (${pm}): ${cmd}` };
      }
      case 'runTypecheck': {
        const pm = detectPackageManager();
        const override = sanitizeShellCommand(args.command);
        const cmd = override || pmRun(pm, 'typecheck');
        return { ok: true, action: 'runCommand', command: cmd, note: `Dispatched typecheck (${pm}): ${cmd}` };
      }
      case 'runBuild': {
        const pm = detectPackageManager();
        const override = sanitizeShellCommand(args.command);
        const cmd = override || pmRun(pm, 'build');
        return { ok: true, action: 'runCommand', command: cmd, note: `Dispatched build (${pm}): ${cmd}` };
      }
      case 'getProjectStructure': {
        const allPaths = Object.keys(currentFS).sort();
        const tree = {};
        for (const path of allPaths) {
          const parts = path.split('/');
          let node = tree;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!node[parts[i]]) node[parts[i]] = {};
            node = node[parts[i]];
          }
          const f = currentFS[path];
          node[parts[parts.length - 1]] = `(${f.language || 'text'}, ${(f.content || '').split('\n').length} lines)`;
        }
        const flat = allPaths.map(p => {
          const f = currentFS[p];
          return `${p} (${f.language || 'text'}, ${(f.content || '').split('\n').length} lines)`;
        });
        return { ok: true, totalFiles: allPaths.length, flat, structure: tree };
      }
      case 'searchAndReplace': {
        const { pattern, replacement = '', targetFile, regex = false, caseSensitive = false } = args;
        if (!pattern) return { ok: false, error: 'pattern is required' };
        const filesToSearch = targetFile
          ? (currentFS[targetFile] ? [targetFile] : [])
          : Object.keys(currentFS).filter(p => currentFS[p]?.language && currentFS[p].language !== 'binary');
        if (filesToSearch.length === 0 && targetFile) return { ok: false, error: `File not found: ${targetFile}` };
        const changes = [];
        for (const path of filesToSearch) {
          const f = currentFS[path];
          if (!f) continue;
          const content = f.content || '';
          let newContent, count = 0;
          try {
            const flags = 'g' + (caseSensitive ? '' : 'i');
            const re = regex
              ? new RegExp(pattern, flags)
              : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
            const matches = content.match(re);
            count = matches?.length || 0;
            newContent = count > 0 ? content.replace(re, replacement) : content;
          } catch (e) {
            return { ok: false, error: `Regex error: ${e.message}` };
          }
          if (count > 0) {
            changes.push({ ok: true, action: 'edit', path, content: newContent, lines: newContent.split('\n').length, replacements: count });
          }
        }
        return {
          ok: true,
          filesChanged: changes.length,
          totalReplacements: changes.reduce((a, r) => a + r.replacements, 0),
          changes,
          note: changes.length > 0
            ? `Replaced "${pattern}" → "${replacement}" in ${changes.length} file(s) (${changes.reduce((a, r) => a + r.replacements, 0)} occurrences)`
            : `No matches for "${pattern}"`,
        };
      }
      case 'npmInstall': {
        const { packages = '', dev = false } = args;
        let pkg = {};
        try { pkg = JSON.parse(currentFS['package.json']?.content || '{}'); } catch { /* ignore */ }
        const packageManager = String(pkg.packageManager || '').toLowerCase();
        const hasPnpmLock = !!currentFS['pnpm-lock.yaml'];
        const hasYarnLock = !!currentFS['yarn.lock'];
        const hasBunLock = !!currentFS['bun.lockb'];

        let pm = 'npm';
        if (packageManager.startsWith('pnpm') || hasPnpmLock) pm = 'pnpm';
        else if (packageManager.startsWith('yarn') || hasYarnLock) pm = 'yarn';
        else if (packageManager.startsWith('bun') || hasBunLock) pm = 'bun';

        const trimmed = packages.trim();
        let cmd;
        if (trimmed) {
          if (pm === 'pnpm') cmd = `pnpm add${dev ? ' -D' : ''} ${trimmed}`;
          else if (pm === 'yarn') cmd = `yarn add${dev ? ' -D' : ''} ${trimmed}`;
          else if (pm === 'bun') cmd = `bun add${dev ? ' -d' : ''} ${trimmed}`;
          else cmd = `npm install --include=dev${dev ? ' --save-dev' : ''} ${trimmed}`;
        } else {
          if (pm === 'pnpm') cmd = 'pnpm install --prod=false';
          else if (pm === 'yarn') cmd = 'yarn install';
          else if (pm === 'bun') cmd = 'bun install';
          else cmd = 'npm install --include=dev';
        }

        return { ok: true, action: 'runCommand', command: cmd, note: `Dispatched (${pm}): ${cmd}` };
      }
      case 'getTerminalOutput': {
        const maxLines = Math.min(args.lines || 60, 200);
        const buf = terminalOutputRef.current;
        const recent = buf.slice(-maxLines);
        if (args.errorsOnly) {
          const errors = recent.filter(l => /error|warn|fail|exception|cannot|unexpected|undefined is not|null is not|SyntaxError|TypeError|ReferenceError/i.test(l));
          return { ok: true, lines: errors.length, output: errors.join('\n'), note: `Filtered ${maxLines} lines for errors/warnings` };
        }
        return { ok: true, lines: recent.length, output: recent.join('\n'), note: `Last ${recent.length} terminal lines` };
      }
      case 'getProblems': {
        const maxLines = Math.min(args.lines || 120, 400);
        const buf = terminalOutputRef.current;
        const recent = buf.slice(-maxLines);
        const problems = [];
        for (const [idx, line] of recent.entries()) {
          const text = String(line || '');
          if (/\berror\b|TypeError|ReferenceError|SyntaxError|Cannot find module|Failed to compile|TS\d+:/i.test(text)) {
            problems.push({ severity: 'error', line: idx + 1, text });
          } else if (/\bwarn(ing)?\b|deprecated|lint/i.test(text)) {
            problems.push({ severity: 'warning', line: idx + 1, text });
          }
        }
        return {
          ok: true,
          scannedLines: recent.length,
          problemCount: problems.length,
          problems: problems.slice(0, 120),
          summary: problems.length === 0
            ? 'No obvious errors/warnings detected in recent terminal output.'
            : `${problems.filter(p => p.severity === 'error').length} error(s), ${problems.filter(p => p.severity === 'warning').length} warning(s)`,
        };
      }
      case 'autoFix': {
        const targetPath = args.path || activeFile;
        const f = currentFS[targetPath];
        if (!f) return { ok: false, error: `File not found: ${targetPath}` };
        const tools = createSharedAgentTools(currentFS, targetPath);
        const analysis = tools.analyzeFile.execute(targetPath);
        if (!analysis.ok || analysis.issues.length === 0) {
          return { ok: true, path: targetPath, fixed: 0, message: 'No auto-fixable issues found.' };
        }
        let lines = (f.content || '').split('\n');
        const applied = [];
        lines = lines.map((line, idx) => {
          let l = line;
          const lineIssues = analysis.issues.filter(iss => iss.line === idx + 1);
          for (const iss of lineIssues) {
            if (iss.msg.includes('var declaration')) {
              const before = l;
              l = l.replace(/\bvar\b/g, 'const');
              if (l !== before) applied.push({ line: idx + 1, fix: 'var → const' });
            }
            if (iss.msg.includes('Loose equality')) {
              const before = l;
              l = l.replace(/([^!<>=])={2}(?!=)/g, '$1===');
              if (l !== before) applied.push({ line: idx + 1, fix: '== → ===' });
            }
            if (iss.msg.includes('debugger statement')) {
              applied.push({ line: idx + 1, fix: 'removed debugger' });
              return '';
            }
          }
          return l;
        });
        const newContent = lines.join('\n');
        const unfixed = analysis.issues.filter(iss => !applied.some(a => a.line === iss.line));
        return {
          ok: true, action: 'edit', path: targetPath, content: newContent,
          fixed: applied.length, applied,
          remaining: unfixed.length, remainingIssues: unfixed.slice(0, 10),
          note: `Auto-fixed ${applied.length} issue(s). ${unfixed.length} issue(s) need manual attention.`,
        };
      }
      case 'explainError': {
        const errorText = (args.error || '').trim();
        if (!errorText) return { ok: false, error: 'error text is required' };
        const typeMatch = errorText.match(/(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|Error):\s*(.+)/);
        const lineMatch = errorText.match(/:(\d+):(\d+)/);
        const moduleMatch = errorText.match(/Cannot find module ['"](.+?)['"]/);
        const errorType = typeMatch?.[1] || 'Error';
        const errorMessage = (typeMatch?.[2] || errorText).slice(0, 120);
        const line = lineMatch?.[1] ? parseInt(lineMatch[1]) : null;
        let cause = '', fix = '', example = '';
        if (moduleMatch) {
          const mod = moduleMatch[1];
          cause = `Module "${mod}" is not installed or the import path is wrong.`;
          fix = mod.startsWith('.') || mod.startsWith('/')
            ? `Check the relative path is correct — file may have moved or been renamed.`
            : `Run: npm install ${mod}\nThen check it's listed in package.json dependencies.`;
          example = `// Wrong\nimport x from '../wrong-path'\n// Correct — check the actual file location\nimport x from './correct-path'`;
        } else if (/null|undefined/.test(errorMessage) && errorType === 'TypeError') {
          cause = 'You tried to read a property or call a method on null or undefined.';
          fix = '1. Add a guard before accessing: if (!obj) return;\n2. Use optional chaining: obj?.property\n3. Check the variable is initialized before use';
          example = `// Crashes if obj is null\nconst x = obj.value;\n// Safe\nconst x = obj?.value ?? defaultValue;`;
        } else if (errorType === 'ReferenceError') {
          const varName = errorMessage.replace(/is not defined.*/, '').trim();
          cause = `"${varName}" is used before it's declared, or it's not imported.`;
          fix = `1. Add the import at the top of the file\n2. Check for typos in the name\n3. Make sure it's declared in the correct scope`;
        } else if (errorType === 'SyntaxError') {
          cause = 'The code has a syntax error — usually a missing bracket, brace, comma, or unclosed string.';
          fix = line ? `Check around line ${line} for:\n• Missing ) ] }\n• Missing comma in object/array literal\n• Unclosed string or template literal` : 'Check the indicated line for missing brackets, commas, or quotes.';
        } else if (/\bCORS\b|Access-Control/i.test(errorMessage)) {
          cause = 'A CORS policy is blocking the request — the server doesn\'t allow requests from this origin.';
          fix = '1. On your server, add the CORS header: Access-Control-Allow-Origin: *\n2. Or use a proxy to forward the request server-side\n3. Check the API endpoint URL is correct';
        } else if (/fetch|network/i.test(errorMessage)) {
          cause = 'A network request failed — the server may be down, the URL is wrong, or there\'s a CORS issue.';
          fix = '1. Check the request URL is correct\n2. Verify the server is running\n3. Open DevTools → Network tab to inspect the failed request';
        }
        return {
          ok: true, errorType, errorMessage,
          line, cause: cause || errorMessage,
          fix: fix || 'Inspect the stack trace and check the indicated file/line.',
          example: example || null,
          nextStep: line ? `Use readFile to read the file around line ${line}, then editFile to apply the fix.` : 'Use analyzeFile on the relevant file, then editFile to fix.',
        };
      }
      case 'getGitStatus': {
        return {
          ok: true, action: 'runCommand',
          command: 'git status && echo "---DIFF---" && git diff --stat HEAD 2>/dev/null || echo "Not a git repo"',
          note: 'Git status dispatched to terminal. Check the terminal panel for output, or call getTerminalOutput after a moment.',
        };
      }
      case 'createComponent': {
        const { name, type = 'react', path: compPath, props: compProps = [] } = args;
        if (!name) return { ok: false, error: 'name is required' };
        const pascal = name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_](\w)/g, (_, c) => c.toUpperCase());
        const isTs = compPath?.endsWith('.tsx') || compPath?.endsWith('.ts');
        const ext = isTs ? '.tsx' : '.jsx';
        const outputPath = compPath || `src/components/${pascal}${ext}`;
        const propsType = isTs && compProps.length ? `interface ${pascal}Props {\n  ${compProps.map(p => `${p}: unknown;`).join('\n  ')}\n}\n\n` : '';
        const propsParam = compProps.length ? (isTs ? `{ ${compProps.join(', ')} }: ${pascal}Props` : `{ ${compProps.join(', ')} }`) : 'props';
        let content = '';
        if (type === 'react' || type === 'react-functional') {
          content = `import React from 'react';\n\n${propsType}export default function ${pascal}(${propsParam}) {\n  return (\n    <div>\n      <h2>${pascal}</h2>\n    </div>\n  );\n}\n`;
        } else if (type === 'react-hook' || type === 'hook') {
          content = `import { useState, useEffect } from 'react';\n\nexport function use${pascal}() {\n  const [state, setState] = useState(null);\n\n  useEffect(() => {\n    // initialize\n  }, []);\n\n  return { state, setState };\n}\n`;
        } else if (type === 'context') {
          content = `import { createContext, useContext, useState } from 'react';\n\nconst ${pascal}Context = createContext(null);\n\nexport function ${pascal}Provider({ children }) {\n  const [state, setState] = useState(null);\n  return (\n    <${pascal}Context.Provider value={{ state, setState }}>\n      {children}\n    </${pascal}Context.Provider>\n  );\n}\n\nexport function use${pascal}() {\n  const ctx = useContext(${pascal}Context);\n  if (!ctx) throw new Error('use${pascal} must be inside ${pascal}Provider');\n  return ctx;\n}\n`;
        } else {
          content = `export function ${pascal}() {\n  // Implementation\n}\n\nexport default ${pascal};\n`;
        }
        const lang = outputPath.endsWith('.tsx') || outputPath.endsWith('.ts') ? 'typescript' : 'javascript';
        return { ok: true, action: 'write', path: outputPath, language: lang, content, lines: content.split('\n').length };
      }
      case 'diagnoseProject': {
        const files = Object.keys(currentFS);
        const issues = [];
        const info = [];
        let pkg = {};
        let allDeps = {};
        let detectedPm = 'npm';
        let installCmd = 'npm install --include=dev';
        let devCmd = 'npm run dev';

        // ── package.json ──────────────────────────────────────────────────
        const pkgFile = currentFS['package.json'];
        if (!pkgFile) {
          issues.push({ severity: 'error', category: 'setup', msg: 'No package.json found — this may not be a Node.js project root' });
        } else {
          try { pkg = JSON.parse(pkgFile.content || '{}'); } catch { /* malformed */ }
          allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          info.push(`package.json: ${pkg.name || 'unnamed'} v${pkg.version || '?'}`);
          if (pkg.scripts?.dev)   info.push(`dev script: "${pkg.scripts.dev}"`);
          if (pkg.scripts?.start) info.push(`start script: "${pkg.scripts.start}"`);

          const pmField = String(pkg.packageManager || '').toLowerCase();
          const hasPnpmLock = !!currentFS['pnpm-lock.yaml'];
          const hasYarnLock = !!currentFS['yarn.lock'];
          const hasBunLock = !!currentFS['bun.lockb'];
          if (pmField.startsWith('pnpm') || hasPnpmLock) {
            detectedPm = 'pnpm';
            installCmd = 'pnpm install --prod=false';
            devCmd = 'pnpm run dev';
          } else if (pmField.startsWith('yarn') || hasYarnLock) {
            detectedPm = 'yarn';
            installCmd = 'yarn install';
            devCmd = 'yarn dev';
          } else if (pmField.startsWith('bun') || hasBunLock) {
            detectedPm = 'bun';
            installCmd = 'bun install';
            devCmd = 'bun run dev';
          }
          info.push(`detected package manager: ${detectedPm}`);

          // CSS frameworks present
          const cssFrameworks = ['tailwindcss', 'bootstrap', '@mui/material', 'antd', '@chakra-ui/react', 'styled-components', '@emotion/react', 'daisyui'];
          const usedFrameworks = cssFrameworks.filter(f => allDeps[f]);
          if (usedFrameworks.length) info.push(`CSS/UI frameworks in deps: ${usedFrameworks.join(', ')}`);

          const devScript = String(pkg.scripts?.dev || '');
          if (/\bvite\b/.test(devScript) && !allDeps['vite']) {
            issues.push({ severity: 'error', category: 'setup', msg: 'dev script uses vite but package.json has no vite dependency' });
          }
          if (allDeps['tailwindcss'] && !allDeps['postcss']) {
            issues.push({ severity: 'error', category: 'css', msg: 'tailwindcss detected but postcss dependency is missing' });
          }
          if (allDeps['tailwindcss'] && !allDeps['autoprefixer']) {
            issues.push({ severity: 'warning', category: 'css', msg: 'tailwindcss detected but autoprefixer dependency is missing' });
          }

          // Tailwind-specific checks
          if (allDeps['tailwindcss']) {
            const hasTwConfig  = files.some(f => /^tailwind\.config\.(js|ts|cjs|mjs)$/.test(f));
            const hasPostCSSCfg = files.some(f => /^postcss\.config\.(js|ts|cjs|mjs)$/.test(f));
            if (!hasTwConfig)   issues.push({ severity: 'error', category: 'css', msg: 'tailwindcss in deps but no tailwind.config.js — create one (npx tailwindcss init -p)' });
            if (!hasPostCSSCfg) issues.push({ severity: 'error', category: 'css', msg: 'tailwindcss requires postcss.config.js — create one with the tailwindcss plugin' });
            // Check for @tailwind directives in any CSS file
            const hasTwDirective = files.some(f => f.endsWith('.css') && (currentFS[f]?.content || '').includes('@tailwind'));
            if (!hasTwDirective) issues.push({ severity: 'error', category: 'css', msg: 'No CSS file contains @tailwind directives — add @tailwind base/components/utilities to your main CSS file' });
          }
        }

        // ── node_modules ──────────────────────────────────────────────────
        const hasNodeModules = files.some(f => f.startsWith('node_modules/'));
        if (!hasNodeModules) {
          issues.push({ severity: 'critical', category: 'setup', msg: `node_modules not found — dependencies are not installed. Run ${installCmd} in the terminal.` });
        } else {
          info.push('node_modules present');
          const hasViteBin = files.some(f => f === 'node_modules/.bin/vite' || f.endsWith('/node_modules/.bin/vite'));
          const hasTailwindBin = files.some(f => f === 'node_modules/.bin/tailwindcss' || f.endsWith('/node_modules/.bin/tailwindcss'));
          if (/\bvite\b/.test(String(pkg.scripts?.dev || '')) && !hasViteBin) {
            issues.push({ severity: 'critical', category: 'setup', msg: `vite binary missing in node_modules/.bin. Reinstall devDependencies with ${installCmd}.` });
          }
          if (allDeps['tailwindcss'] && !hasTailwindBin) {
            issues.push({ severity: 'critical', category: 'css', msg: `tailwindcss binary missing in node_modules/.bin. Reinstall devDependencies with ${installCmd}.` });
          }
        }

        // ── index.html ────────────────────────────────────────────────────
        const htmlFile = currentFS['index.html'];
        if (htmlFile) {
          const html = htmlFile.content || '';
          const hasModuleScript = /<script[^>]+type=["']module["']/.test(html);
          const hasCSSLink       = /<link[^>]+\.css/.test(html);
          if (!hasModuleScript && !hasCSSLink) {
            issues.push({ severity: 'warning', category: 'html', msg: 'index.html has no <script type="module"> or <link> CSS — styles may not load at all' });
          } else if (!hasCSSLink && hasModuleScript) {
            info.push('index.html uses JS module entry (CSS likely imported in JS)');
          }
        } else {
          issues.push({ severity: 'warning', category: 'setup', msg: 'No index.html found — project entry point may be elsewhere' });
        }

        // ── CSS files ─────────────────────────────────────────────────────
        const cssFiles = files.filter(f => f.endsWith('.css'));
        if (cssFiles.length === 0) {
          issues.push({ severity: 'warning', category: 'css', msg: 'No .css files found in workspace' });
        } else {
          info.push(`CSS files: ${cssFiles.join(', ')}`);
          // Check that the main CSS file is imported in a JS/TS entry
          const mainCssImported = cssFiles.some(cssPath => {
            const base = cssPath.replace(/^.*\//, '');
            return files.some(f => (f.endsWith('.js') || f.endsWith('.jsx') || f.endsWith('.ts') || f.endsWith('.tsx'))
              && (currentFS[f]?.content || '').includes(base));
          });
          if (!mainCssImported && cssFiles.length > 0) {
            issues.push({ severity: 'warning', category: 'css', msg: `CSS file(s) found but none appear to be imported in a JS/TS file — styles won't load unless imported` });
          }
        }

        // ── Vite / build tool ─────────────────────────────────────────────
        const hasViteConfig = files.some(f => /^vite\.config\.(js|ts|mjs|cjs)$/.test(f));
        if (hasViteConfig) info.push('vite.config found');

        // ── Summary ───────────────────────────────────────────────────────
        const criticalCount = issues.filter(i => i.severity === 'critical').length;
        const errorCount    = issues.filter(i => i.severity === 'error').length;
        const warnCount     = issues.filter(i => i.severity === 'warning').length;

        let recommendation = 'Project setup looks good';
        if (criticalCount > 0) {
          recommendation = `CRITICAL: Run \`${installCmd}\` in the terminal to install dependencies, then start the dev server with \`${devCmd}\`.`;
        } else if (errorCount > 0) {
          recommendation = 'Fix the CSS configuration errors above, then restart the dev server.';
        } else if (warnCount > 0) {
          recommendation = 'Review the warnings above — they may explain missing styles.';
        }

        const suggestedCommands = [installCmd, devCmd];
        if (allDeps['tailwindcss']) {
          if (detectedPm === 'pnpm') suggestedCommands.push('pnpm add -D tailwindcss postcss autoprefixer');
          else if (detectedPm === 'yarn') suggestedCommands.push('yarn add -D tailwindcss postcss autoprefixer');
          else if (detectedPm === 'bun') suggestedCommands.push('bun add -d tailwindcss postcss autoprefixer');
          else suggestedCommands.push('npm install --include=dev --save-dev tailwindcss postcss autoprefixer');
        }

        return {
          ok: true,
          totalFiles: files.length,
          issues,
          info,
          packageManager: detectedPm,
          installCommand: installCmd,
          devCommand: devCmd,
          suggestedCommands,
          issueCount: issues.length,
          criticalCount,
          errorCount,
          warnCount,
          summary: issues.length === 0
            ? 'No setup issues detected'
            : `${criticalCount} critical, ${errorCount} error, ${warnCount} warning`,
          recommendation,
        };
      }
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  }, [activeFile]);

  // ── Apply file mutations from tool calls ────────────────────────────────
  const applyToolMutations = useCallback((toolCalls, results, currentFS) => {
    let newFS = { ...currentFS };
    let changed = false;
    const cmdsToRun = [];
    const changeItems = [];
    toolCalls.forEach((tc, i) => {
      const r = results[i]?.result;
      if (!r?.ok) return;
      if (tc.name === 'writeFile') {
        // Use r.content (validated inside executeToolCall) rather than
        // tc.arguments.content directly — prevents empty files when the
        // model hits max_tokens and the OpenAI arguments JSON is truncated.
        const before = currentFS[tc.arguments.path]
          ? { ...currentFS[tc.arguments.path] }
          : null;
        const after = { name: tc.arguments.path.split('/').pop(), language: r.language, content: r.content ?? '' };
        newFS[tc.arguments.path] = { name: tc.arguments.path.split('/').pop(), language: r.language, content: r.content ?? '' };
        changed = true;
        changeItems.push({ path: tc.arguments.path, action: before ? 'edit' : 'create', before, after });
      } else if ((tc.name === 'editFile' || tc.name === 'patchLines') && typeof r.content === 'string') {
        const fPath = tc.name === 'patchLines' ? r.path : tc.arguments.path;
        const before = currentFS[fPath] ? { ...currentFS[fPath] } : null;
        const after = before ? { ...before, content: r.content } : null;
        newFS[fPath] = { ...newFS[fPath], content: r.content };
        changed = true;
        if (before && after) changeItems.push({ path: fPath, action: 'edit', before, after });
      } else if (tc.name === 'deleteFile') {
        const before = currentFS[tc.arguments.path]
          ? { ...currentFS[tc.arguments.path] }
          : null;
        delete newFS[tc.arguments.path];
        changed = true;
        if (before) changeItems.push({ path: tc.arguments.path, action: 'delete', before, after: null });
      } else if (tc.name === 'runCommand' && r.action === 'runCommand') {
        cmdsToRun.push(tc.arguments.command);
      } else if (tc.name === 'npmInstall' && r.action === 'runCommand') {
        cmdsToRun.push(r.command);
      } else if ((tc.name === 'runBuild' || tc.name === 'runTests' || tc.name === 'runLint' || tc.name === 'runTypecheck') && r.action === 'runCommand') {
        cmdsToRun.push(r.command);
      } else if (tc.name === 'getGitStatus' && r.action === 'runCommand') {
        cmdsToRun.push(r.command);
      } else if (tc.name === 'autoFix' && r.action === 'edit' && typeof r.content === 'string') {
        const before = currentFS[r.path] ? { ...currentFS[r.path] } : null;
        const after = before ? { ...before, content: r.content } : null;
        newFS[r.path] = { ...newFS[r.path], content: r.content };
        changed = true;
        if (before && after) changeItems.push({ path: r.path, action: 'edit', before, after });
      } else if (tc.name === 'createComponent' && r.action === 'write' && typeof r.content === 'string') {
        const before = currentFS[r.path] ? { ...currentFS[r.path] } : null;
        newFS[r.path] = { content: r.content, language: r.language || 'javascript', name: r.path.split('/').pop() };
        changed = true;
        changeItems.push({ path: r.path, action: before ? 'edit' : 'write', before: before || null, after: newFS[r.path] });
      } else if (tc.name === 'searchAndReplace' && r.changes?.length) {
        for (const change of r.changes) {
          if (change.ok && change.action === 'edit' && typeof change.content === 'string') {
            const before = currentFS[change.path] ? { ...currentFS[change.path] } : null;
            const after = before ? { ...before, content: change.content } : null;
            newFS[change.path] = { ...newFS[change.path], content: change.content };
            changed = true;
            if (before && after) changeItems.push({ path: change.path, action: 'edit', before, after });
          }
        }
      }
    });
    return { newFS, changed, cmdsToRun, changeItems };
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
      setIsTyping(false);
      setAgentRunState(AGENT_RUN_STATES.IDLE);
      agentSubmitRef.current?.({ preventDefault: () => {} }, steering);
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

  const handleCopyMessage = useCallback(async (content, key) => {
    try {
      await navigator.clipboard?.writeText(content || '');
      setCopiedMsgKey(key);
      setTimeout(() => setCopiedMsgKey(prev => (prev === key ? '' : prev)), 1800);
    } catch {
      // no-op: clipboard may be blocked by browser policy
    }
  }, []);

  const handleQuoteToPrompt = useCallback((content) => {
    const safe = (content || '').trim();
    if (!safe) return;
    const quote = safe.split('\n').map(line => `> ${line}`).join('\n');
    setChatInput(prev => (prev ? `${prev}\n\n${quote}\n\n` : `${quote}\n\n`));
  }, []);

  const summarizeFileChanges = useCallback((changeMap) => {
    const files = Array.from(changeMap.values()).map((c) => {
      const beforeLines = c.before?.content ? c.before.content.split('\n').length : 0;
      const afterLines = c.after?.content ? c.after.content.split('\n').length : 0;
      return {
        path: c.path,
        action: c.action,
        plus: Math.max(0, afterLines - beforeLines),
        minus: Math.max(0, beforeLines - afterLines),
      };
    });
    const totalPlus = files.reduce((n, f) => n + f.plus, 0);
    const totalMinus = files.reduce((n, f) => n + f.minus, 0);
    return { files, totalPlus, totalMinus };
  }, []);

  const handleMarkChangeSet = useCallback((msgId, status) => {
    setMessages(prev => prev.map(m => m.id === msgId ? { ...m, changeStatus: status } : m));
    setConversations(prev => prev.map(c => c.id === activeConvoId
      ? { ...c, messages: c.messages.map(m => m.id === msgId ? { ...m, changeStatus: status } : m) }
      : c));
  }, [activeConvoId]);

  const handleKeepChangeSet = useCallback((msgId) => {
    changeLedgerRef.current.delete(msgId);
    handleMarkChangeSet(msgId, 'kept');
  }, [handleMarkChangeSet]);

  const handleUndoChangeSet = useCallback((msgId) => {
    const changes = changeLedgerRef.current.get(msgId);
    if (!changes?.length) return;
    const snapshot = getLatest();
    const reverted = { ...snapshot };
    changes.forEach((c) => {
      if (c.before) reverted[c.path] = { ...c.before };
      else delete reverted[c.path];
    });
    replaceAll(reverted);
    changeLedgerRef.current.delete(msgId);
    handleMarkChangeSet(msgId, 'undone');
  }, [getLatest, replaceAll, handleMarkChangeSet]);

  const handlePinActiveFile = useCallback(() => {
    if (!fileSystem[CANONICAL_GUIDANCE_FILE]) return;
    setPinnedFilePath(CANONICAL_GUIDANCE_FILE);
    setPinnedFileOpen(true);
  }, [fileSystem]);

  const pendingChangeSets = useMemo(() => {
    return messages
      .filter((m) => m.role === 'assistant' && m.changeStatus === 'pending' && m.changedFiles?.length > 0)
      .map((m) => ({
        id: m.id,
        timestamp: m.timestamp,
        files: m.changedFiles,
        plus: m.changedPlus || 0,
        minus: m.changedMinus || 0,
      }));
  }, [messages]);

  const sessionChangeTimeline = useMemo(() => {
    return messages
      .filter((m) => m.role === 'assistant' && m.changedFiles?.length > 0)
      .map((m) => ({
        id: m.id,
        timestamp: m.timestamp,
        status: m.changeStatus || 'kept',
        files: m.changedFiles || [],
        plus: m.changedPlus || 0,
        minus: m.changedMinus || 0,
        excerpt: (m.content || '').slice(0, 140),
      }))
      .reverse();
  }, [messages]);

  useEffect(() => {
    if (pendingChangeSets.length === 0) {
      if (selectedChangeMsgId) setSelectedChangeMsgId('');
      return;
    }
    if (!selectedChangeMsgId || !pendingChangeSets.some((s) => s.id === selectedChangeMsgId)) {
      setSelectedChangeMsgId(pendingChangeSets[0].id);
    }
  }, [pendingChangeSets, selectedChangeMsgId]);

  useEffect(() => {
    const priority = [pinnedFilePath, CANONICAL_GUIDANCE_FILE].filter(Boolean);
    const next = priority.find((p) => !!fileSystem[p]);
    if (next && next !== pinnedFilePath) {
      setPinnedFilePath(next);
      return;
    }
    if (!next && pinnedFilePath) setPinnedFilePath(null);
  }, [fileSystem, pinnedFilePath]);

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
        if (!dataUrl) {
          try { dataUrl = await fileToDataUrl(file); } catch { /* best-effort */ }
        }
        const mime = imageMimeFromFile(file);
        await writeBinaryFile(targetPath, bytes, 'binary', { dataUrl, mime });
      } catch (err) {
        logger.warn('explorer', `drop import failed: ${file?.name || 'image'}`, err);
      }
    }
  }, [getLatest, writeBinaryFile]);

  // ── Slash command expansion ────────────────────────────────────────────
  const SLASH_COMMANDS = {
    '/fix':     `Fix all bugs and errors in the active file. Call getTerminalOutput first to check for runtime errors, then analyzeFile, then autoFix to apply automatic patches, then address any remaining issues with editFile.`,
    '/debug':   `Debug the active file. Call getTerminalOutput to see recent terminal output/errors, then analyzeFile, then fix every issue found.`,
    '/explain': `Explain the active file thoroughly: what it does, how it's structured, what each major section does, and any notable patterns or potential improvements.`,
    '/test':    `Write comprehensive unit tests for the active file. Use the project's existing test framework (check package.json). Create the test file alongside the source file.`,
    '/doc':     `Add JSDoc/TSDoc comments to all exported functions and components in the active file. Do not change any logic — only add documentation.`,
    '/refactor':`Refactor the active file: improve readability, reduce complexity, fix code smells, modernize syntax. Make the edits first with tools, then summarize why each change was made.`,
    '/commit':  `Generate a git commit message for the current changes. Call getGitStatus to see what changed, then write a conventional commit message (type: description).`,
    '/new':     `Scaffold a new component or module for this project.`,
    '/deps':    `Check for missing or outdated dependencies. Call diagnoseProject, then list any packages that need to be installed.`,
    '/review':  `Do a thorough code review of the active file. Check for bugs, security issues, performance problems, and code style. Provide a prioritized list of findings.`,
  };

  const expandSlashCommand = useCallback((msg, file) => {
    const trimmed = msg.trim();
    for (const [cmd, expansion] of Object.entries(SLASH_COMMANDS)) {
      if (trimmed === cmd || trimmed.startsWith(cmd + ' ')) {
        const extra = trimmed.slice(cmd.length).trim();
        const base = expansion.replace('the active file', file ? `\`${file}\`` : 'the active file');
        return extra ? `${base}\n\nAdditional context: ${extra}` : base;
      }
    }
    return msg;
  }, [activeFile]);

  // ── Chat handler (agent-aware with tool loop) ──────────────────────────
  const handleAgentSubmit = useCallback((e, overrideMessage, options = {}) => {
    e.preventDefault();
    const userMessage = (overrideMessage ?? chatInput).trim();
    if ((!userMessage && !chatImage) || isTyping) return;
    const resumeFromMessageId = options?.resumeFromMessageId || null;
    // Abort any in-flight request before starting a new one
    chatAbortRef.current?.abort();
    chatAbortRef.current = new AbortController();
    // Expand slash commands for API (display keeps original)
    const expandedMessage = normalizeLargeErrorBlock(expandSlashCommand(userMessage, activeFile));
    const apiUserContent = toModelUserContent(expandedMessage, chatImage, activeAgent);
    const displayContent = userMessage || `Image attached: ${chatImage?.name || 'image'}`;
    const userMsg = { id: makeMessageId('user'), role: 'user', content: displayContent, agent: activeAgent, timestamp: Date.now(), imageDataUrl: chatImage?.dataUrl || null };
    setMessages(prev => [...prev, userMsg]);
    setConversations(prev => prev.map(c => c.id === activeConvoId ? { ...c, messages: [...c.messages, userMsg] } : c));
    if (!overrideMessage) setChatInput('');
    setChatImage(null);
    setShowLiveProgressDetails(false);
    setIsTyping(true);
    setAgentRunState(AGENT_RUN_STATES.PLANNING);

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
    // Auto-inject terminal output when the user asks to fix/debug something
    const isFixDebugRequest = /\b(fix|debug|error|bug|broken|crash|not work|fail|exception|undefined|cannot|issue)\b/i.test(userMessage);
    if (isFixDebugRequest && terminalOutputRef.current.length > 0) {
      const recentOutput = terminalOutputRef.current.slice(-40).join('\n');
      context.terminalOutput = recentOutput;
    }

    const pinnedEntry = pinnedFilePath === CANONICAL_GUIDANCE_FILE ? fileSystem[pinnedFilePath] : null;
    if (pinnedEntry && typeof pinnedEntry.content === 'string' && pinnedEntry.content.trim()) {
      context.pinnedRules = {
        path: CANONICAL_GUIDANCE_FILE,
        content: pinnedEntry.content.slice(0, 12000),
      };
    }
    const convo = conversations.find(c => c.id === activeConvoId);
    const resumeMsg = resumeFromMessageId
      ? (convo?.messages || []).find((m) => m.id === resumeFromMessageId)
      : null;
    const resumeState = resumeMsg?.resumeState || null;
    const commandPipelineRequested = chatMode === 'agent' && looksLikeCommandExecutionRequest(userMessage);
    const commandPipelineSeed = commandPipelineRequested || !!resumeState?.commandPipelineMode;
    const reasonerPreflightRequested =
      chatMode === 'agent' &&
      (commandPipelineSeed || activeAgent === 'backend-architect' || activeAgent === 'deepseek');
    const shouldAttachReasonerContext = reasonerPreflightRequested;
    if (shouldAttachReasonerContext) {
      const maxFiles = activeAgent === 'backend-architect' ? 12 : REASONER_CONTEXT_FILE_LIMIT;
      context.reasonerRelevantFiles = buildReasonerRelevantFiles(fileSystem, activeFile, userMessage, pinnedFilePath, maxFiles);
    }

    const historyAgent = commandPipelineSeed ? 'deepseek' : activeAgent;
    const historyLimits = historyLimitsForAgent(historyAgent, chatMode);
    const historyPackLimit = historyLimits.pack;
    const historySliceLimit = historyLimits.slice;

    const websiteBuildMode = (typeof resumeState?.websiteBuildMode === 'boolean')
      ? resumeState.websiteBuildMode
      : looksLikeWebsiteBuildRequest(userMessage);
    const appBuildMode = (typeof resumeState?.appBuildMode === 'boolean')
      ? resumeState.appBuildMode
      : looksLikeAppBuildRequest(userMessage);
    const forceBatchForBuild = websiteBuildMode || appBuildMode;
    const batchChangeMode = (typeof resumeState?.batchChangeMode === 'boolean')
      ? (resumeState.batchChangeMode || forceBatchForBuild)
      : (looksLikeBatchChangeRequest(userMessage) || forceBatchForBuild);

    let history = resumeState?.history
      ? [...resumeState.history, { role: 'user', content: apiUserContent }]
      : [...(convo?.messages || []), { ...userMsg, content: apiUserContent }]
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .slice(-historyPackLimit)
          .map(m => ({ role: m.role, content: m.content }));

    if ((activeAgent === 'deepseek' || commandPipelineSeed) && resumeState) {
      history = [
        ...history,
        {
          role: 'user',
          content: 'Resume mode: continue from previous tool state. Do NOT restart by reading files again. Your next action must be a write tool unless blocked.',
        },
      ].slice(-historySliceLimit);
    }
    history = packChatHistory(history, activeFile, userMessage, historyPackLimit);

    (async () => {
      let allSteps = [];
      let allToolCalls = [];
      const allFileChanges = new Map();
      let currentFS = { ...fileSystem };
      let pendingToolCalls = Array.isArray(resumeState?.pendingToolCalls) ? resumeState.pendingToolCalls : null;
      let toolResults = Array.isArray(resumeState?.toolResults) ? resumeState.toolResults : null;
      let lastToolCallSig = resumeState?.lastToolCallSig || null;
      let activeWorkFile = typeof resumeState?.activeWorkFile === 'string' ? resumeState.activeWorkFile : null;
      let supportReadFiles = Array.isArray(resumeState?.supportReadFiles)
        ? resumeState.supportReadFiles.filter((p) => typeof p === 'string')
        : [];
      let stagnationRounds = Number(resumeState?.stagnationRounds || 0);
      let verificationFailures = 0;
      const executionStartedAt = Date.now();
      const stateTransitions = [{ state: AGENT_RUN_STATES.PLANNING, at: executionStartedAt }];
      const MAX_ROUNDS_DEFAULT = 16;
      const MAX_ROUNDS_DEEPSEEK = 24;
      const MAX_ROUNDS_BACKEND = 32;
      const DEEPSEEK_ANALYSIS_MODEL = 'deepseek-reasoner';
      const DEEPSEEK_EXECUTION_MODEL = 'deepseek-chat';
      let commandPipelineMode = commandPipelineSeed;
      const executionAgent = commandPipelineMode ? 'deepseek' : activeAgent;
      const isDeepSeekAgent = executionAgent === 'deepseek';
      const isBackendArchitectAgent = executionAgent === 'backend-architect';
      const needsReasonerPreflight = reasonerPreflightRequested;
      const roundLimit = isDeepSeekAgent
        ? MAX_ROUNDS_DEEPSEEK
        : isBackendArchitectAgent
          ? MAX_ROUNDS_BACKEND
          : MAX_ROUNDS_DEFAULT;
      const effectiveModel = (isDeepSeekAgent || commandPipelineMode) && chatMode === 'agent'
        ? DEEPSEEK_EXECUTION_MODEL
        : activeModel;
      const MAX_SUPPORT_READ_FILES = isDeepSeekAgent ? 6 : isBackendArchitectAgent ? 10 : 3;
      let consecToolRounds = 0; // consecutive tool-call rounds without user input
      let consecReadOnlyRounds = Number(resumeState?.consecReadOnlyRounds || 0); // rounds where ONLY read tools were called (no writes)
      let totalWriteSuccesses = Number(resumeState?.totalWriteSuccesses || 0);
      let noWriteRounds = Number(resumeState?.noWriteRounds || 0);
      let autoResumeAttempts = Number(resumeState?.autoResumeAttempts || 0);
      let deepseekReasonerPrimed = !!resumeState?.deepseekReasonerPrimed;
      let pendingBatchVerification = !!resumeState?.pendingBatchVerification;
      let backendVerificationSatisfied = !!resumeState?.backendVerificationSatisfied;
      let buildVerified = !!resumeState?.buildVerified;
      let typecheckVerified = !!resumeState?.typecheckVerified;
      let planMajorSteps = Array.isArray(resumeState?.planMajorSteps)
        ? resumeState.planMajorSteps.filter((s) => typeof s === 'string' && s.trim())
        : [];
      let planStepIndex = Math.max(0, Number(resumeState?.planStepIndex || 0));
      let planAwaitingApproval = !!resumeState?.planAwaitingApproval;
      let deepseekPlanSummary = typeof resumeState?.deepseekPlanSummary === 'string' ? resumeState.deepseekPlanSummary : '';
      const commandFailureCounts = new Map(Object.entries(resumeState?.commandFailureCounts || {}));
      const commandBlocked = new Set(Array.isArray(resumeState?.commandBlocked) ? resumeState.commandBlocked : []);
      const commandFamilyFailureCounts = new Map(Object.entries(resumeState?.commandFamilyFailureCounts || {}));
      const commandFamilyBlocked = new Set(Array.isArray(resumeState?.commandFamilyBlocked) ? resumeState.commandFamilyBlocked : []);

      if (Array.isArray(resumeState?.allSteps)) allSteps = [...resumeState.allSteps];
      if (Array.isArray(resumeState?.allToolCalls)) allToolCalls = [...resumeState.allToolCalls];

      if ((websiteBuildMode || appBuildMode) && planAwaitingApproval) {
        const approved = userApprovedNextPlanStep(userMessage);
        const rejected = userRejectedNextPlanStep(userMessage);
        if (rejected) {
          const msgId = makeMessageId('assistant');
          const pauseMsg = {
            id: msgId,
            role: 'assistant',
            content: `Paused at plan step ${Math.max(1, planStepIndex)}/${Math.max(1, planMajorSteps.length)}. Send "continue" when you want me to build the next step.`,
            agent: activeAgent,
            agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
            mode: chatMode,
            timestamp: Date.now(),
            canContinue: true,
            resumeState: {
              ...resumeState,
              planAwaitingApproval: true,
              planStepIndex,
              planMajorSteps,
            },
          };
          setMessages(prev => [...prev.filter(m => !m._progress), pauseMsg]);
          setConversations(prev => prev.map(c => c.id === activeConvoId ? { ...c, messages: [...c.messages.filter(m => !m._progress), pauseMsg] } : c));
          setIsTyping(false);
          setAgentRunState(AGENT_RUN_STATES.IDLE);
          return;
        }
        if (!approved) {
          const msgId = makeMessageId('assistant');
          const askMsg = {
            id: msgId,
            role: 'assistant',
            content: `Step ${Math.max(1, planStepIndex + 1)}/${Math.max(1, planMajorSteps.length)} is queued: ${planMajorSteps[planStepIndex] || 'next major step'}. Reply "continue" to build it, or "pause" to hold.`,
            agent: activeAgent,
            agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
            mode: chatMode,
            timestamp: Date.now(),
            canContinue: true,
            resumeState: {
              ...resumeState,
              planAwaitingApproval: true,
              planStepIndex,
              planMajorSteps,
            },
          };
          setMessages(prev => [...prev.filter(m => !m._progress), askMsg]);
          setConversations(prev => prev.map(c => c.id === activeConvoId ? { ...c, messages: [...c.messages.filter(m => !m._progress), askMsg] } : c));
          setIsTyping(false);
          setAgentRunState(AGENT_RUN_STATES.IDLE);
          return;
        }
        planAwaitingApproval = false;
      }

      try {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        const requestChatRound = async (payload) => {
          const MAX_ATTEMPTS = (commandPipelineMode || executionAgent === 'deepseek' || isBackendArchitectAgent) ? 1 : 2;
          let lastErr = null;
          for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
              const _fetchFn = (p, sig) => fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(p),
                signal: sig,
              });

              const { response: res, usedRoute: _autoRoute } = await autoFetch(
                payload,
                userMessage,
                chatAbortRef.current?.signal,
                _fetchFn
              );

              if (_autoRoute && !commandPipelineMode) {
                payload.agent = _autoRoute.agent;
                payload.model = _autoRoute.model;
              }

              const data = await res.json();
              if (res.ok) return data;

              const hint = data.missingKey
                ? ` Go to Vercel → Project → Settings → Environment Variables, add ${data.missingKey}, and redeploy.`
                : '';
              const e = new Error((data.error || `API error ${res.status}`) + hint);
              e.retryable = !!data.retryable;
              e.code = data.code;
              lastErr = e;

              if (!data.retryable || attempt === MAX_ATTEMPTS - 1) throw e;

              allSteps.push(`🔁 Upstream retry ${attempt + 1}/${MAX_ATTEMPTS - 1} after ${data.code || 'error'}`);
              await sleep(Math.min(4000, 700 * (2 ** attempt)));
            } catch (err) {
              lastErr = err;
              if (attempt === MAX_ATTEMPTS - 1) throw err;
              await sleep(Math.min(4000, 700 * (2 ** attempt)));
            }
          }
          throw lastErr || new Error('Chat round failed');
        };

        const runDeepSeekReasonerPreflight = async () => {
          if (!needsReasonerPreflight || deepseekReasonerPrimed) return;

          allSteps.push(commandPipelineMode
            ? '🧠 DeepSeek R1 pre-analysis before DeepSeek V3 command execution'
            : '🧠 DeepSeek R1 pre-analysis before backend execution');

          const analysisRequest = {
            agent: 'deepseek',
            model: DEEPSEEK_ANALYSIS_MODEL,
            messages: [
              ...history,
              {
                role: 'user',
                content: isBackendArchitectAgent
                  ? 'This is a backend-architect execution. Before any tool calls, analyze this task using the active file plus every relevant file bundle in context. Return a hidden execution contract for the next model pass. Start with one line in the exact format `Summary: ...` using 1 short sentence describing what you will work on. Then include: 1) Goal, 2) API/data contracts, 3) Relevant files and why, 4) Risks/blockers, 5) Numbered implementation steps, 6) Verification steps (must include runBuild and runTypecheck first), 7) Stop condition. Do not call tools, do not write code, and do not claim completion.'
                  : commandPipelineMode
                    ? 'This is a command execution request. Before any tool calls, analyze this task using the active file plus relevant context and return a hidden execution contract for DeepSeek V3. Start with one line in the exact format `Summary: ...` using 1 short sentence. Then include: 1) Goal, 2) Required commands and order, 3) Relevant files and why, 4) Risks/blockers, 5) Numbered implementation steps, 6) Verification steps, 7) Stop condition. Do not call tools, do not write code, and do not claim completion.'
                  : 'Before any tool calls, analyze this task using the active file plus every relevant file bundle provided in context. Return a hidden execution contract for the next model pass. Start with one line in the exact format `Summary: ...` using 1 short sentence describing what you will work on. After that, include the full execution contract with: 1) Goal, 2) Relevant files and why, 3) Risks/blockers, 4) Numbered implementation steps, 5) Verification steps, 6) Stop condition. Do not call tools, do not write code, and do not claim completion.',
              },
            ],
            context,
            mode: 'ask',
          };

          const analysis = await requestChatRound(analysisRequest);
          const analysisText = typeof analysis?.content === 'string' && analysis.content.trim()
            ? analysis.content.trim()
            : 'No analysis returned.';
          deepseekPlanSummary = extractReasonerVisibleSummary(analysisText);
          const extractedSteps = extractMajorPlanSteps(analysisText);
          if (extractedSteps.length > 0) {
            planMajorSteps = extractedSteps;
            if (planStepIndex <= 0) planStepIndex = 0;
          }
          allSteps.push(`🧠 Plan summary: ${deepseekPlanSummary}`);

          history = [
            ...history,
            { role: 'assistant', content: `[DeepSeek Reasoner execution contract]\n${analysisText}` },
            {
              role: 'user',
              content: isBackendArchitectAgent
                ? 'Use the hidden DeepSeek Reasoner execution contract above as the execution contract. Execute it strictly with Backend Architect and workspace tools. Read and modify only what the contract requires unless direct code evidence or verification disproves it. Do not finalize backend work until runBuild and runTypecheck have executed successfully, plus any additional verification needed by the contract.'
                : commandPipelineMode
                  ? 'Use the hidden DeepSeek Reasoner execution contract above as the execution contract. Execute it strictly with DeepSeek V3 and workspace tools. Do not switch providers or models. Read and modify only what the contract requires unless verification disproves it. Keep execution concise and avoid extra think-only loops.'
                : 'Use the hidden DeepSeek Reasoner execution contract above as the execution contract. Execute it strictly with DeepSeek V3 and workspace tools. Read and modify only what the contract requires unless direct code evidence or verification disproves it. When every planned implementation and verification step is complete, stop immediately and return the final completion response without adding extra work.',
            },
          ].slice(-historySliceLimit);
          history = packChatHistory(history, activeFile, userMessage, historyPackLimit);
          deepseekReasonerPrimed = true;
          allSteps.push(`✅ Reasoner analysis complete; ${(isBackendArchitectAgent && !commandPipelineMode) ? 'Backend Architect' : 'DeepSeek V3'} execution unlocked`);
        };

        const isLikelyLongRunningCmd = (cmd) => {
          const text = String(cmd || '').toLowerCase();
          return /(\b(run|npm run|pnpm|yarn|bun run)\s+(dev|start|serve|watch)\b|\bnext\s+dev\b|\bvite\b|--watch\b|\btail\s+-f\b)/.test(text);
        };
        const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const normalizeCommand = (cmd) => String(cmd || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const commandFamily = (cmd) => {
          const raw = String(cmd || '').trim().toLowerCase();
          if (!raw) return 'unknown';
          const cleaned = raw.replace(/[(){}]/g, ' ');
          const tokens = cleaned.split(/\s+/).filter(Boolean);
          if (!tokens.length) return 'unknown';
          const wrappers = new Set(['sudo', 'env', 'command', 'time', 'nohup', 'builtin']);
          const shellKeywords = new Set([
            'if', 'then', 'fi', 'else', 'elif',
            'for', 'in', 'do', 'done',
            'while', 'until', 'case', 'esac',
            'function', 'select', 'coproc', 'let',
          ]);
          const skipTokens = new Set(['[', ']', '[[', ']]', 'test', '!', ':']);

          const isExecutableToken = (t) => {
            if (!t) return false;
            if (t.startsWith('-')) return false;
            if (t.includes('=')) return false;
            if (shellKeywords.has(t) || skipTokens.has(t)) return false;
            if (wrappers.has(t)) return false;
            return /^[a-z0-9_./+-]+$/.test(t);
          };

          for (let i = 0; i < tokens.length; i += 1) {
            const t = tokens[i];
            // Handle "command -v <bin>" wrapper patterns.
            if (t === 'command' && tokens[i + 1] === '-v' && isExecutableToken(tokens[i + 2])) {
              return tokens[i + 2];
            }

            if (!isExecutableToken(t)) continue;

            // Group common port/process control utilities into one family to avoid thrash.
            if (t === 'fuser' || t === 'lsof' || t === 'kill' || t === 'pkill' || t === 'netstat' || t === 'ss') {
              return 'port-process';
            }

            return t;
          }

          return 'unknown';
        };
        const detectPackageManagerFromFS = (fs) => {
          let pkg = {};
          try { pkg = JSON.parse(fs?.['package.json']?.content || '{}'); } catch { pkg = {}; }
          const pmField = String(pkg.packageManager || '').toLowerCase();
          if (pmField.startsWith('pnpm') || fs?.['pnpm-lock.yaml']) return 'pnpm';
          if (pmField.startsWith('yarn') || fs?.['yarn.lock']) return 'yarn';
          if (pmField.startsWith('bun') || fs?.['bun.lockb']) return 'bun';
          return 'npm';
        };
        const readPackageScripts = (fs) => {
          try {
            const pkg = JSON.parse(fs?.['package.json']?.content || '{}');
            return (pkg && typeof pkg.scripts === 'object' && pkg.scripts) ? pkg.scripts : {};
          } catch {
            return {};
          }
        };
        const buildCommandAlternatives = (cmd, runStatus, fs) => {
          const raw = String(cmd || '').trim();
          const lower = raw.toLowerCase();
          const pm = detectPackageManagerFromFS(fs);
          const scripts = readPackageScripts(fs);
          const output = `${runStatus?.reason || ''}\n${runStatus?.outputSnippet || ''}`.toLowerCase();
          const out = [];

          if (/^npm\s+install\b/.test(lower) && pm === 'pnpm') {
            out.push(raw.replace(/^npm\s+install\b/i, 'pnpm add'));
            out.push('pnpm install --prod=false');
          }
          if (/^npm\s+install\b/.test(lower) && pm === 'yarn') {
            out.push(raw.replace(/^npm\s+install\b/i, 'yarn add'));
            out.push('yarn install');
          }
          if (/^pnpm\s+add\b/.test(lower) && pm === 'npm') {
            out.push(raw.replace(/^pnpm\s+add\b/i, 'npm install'));
          }
          if (/^yarn\s+add\b/.test(lower) && pm === 'npm') {
            out.push(raw.replace(/^yarn\s+add\b/i, 'npm install'));
          }

          const missingScriptMatch = output.match(/missing script:\s*"?([a-z0-9:_-]+)"?/i);
          const missingScript = missingScriptMatch?.[1];
          if (missingScript && !scripts[missingScript]) {
            if (scripts.dev) out.push(pm === 'npm' ? 'npm run dev' : `${pm} run dev`);
            if (scripts.build) out.push(pm === 'npm' ? 'npm run build' : `${pm} run build`);
            if (scripts.test) out.push(pm === 'npm' ? 'npm run test' : `${pm} run test`);
            if (missingScript === 'lint') out.push('npx eslint .');
          }

          if (/runtime not ready/.test(output)) {
            out.push('npm run dev');
          }

          const deduped = [];
          const seen = new Set();
          for (const c of out) {
            const n = normalizeCommand(c);
            if (!n || seen.has(n) || n === normalizeCommand(raw)) continue;
            seen.add(n);
            deduped.push(c);
          }
          return deduped;
        };

        const isHardCommandFailure = (status) => {
          const text = `${status?.reason || ''}\n${status?.outputSnippet || ''}`.toLowerCase();
          return /command not found|no such file or directory|enoent|is not recognized as an internal or external command|not found - type 'help'/.test(text);
        };

        const isMissingBinaryFailure = (status) => {
          const text = `${status?.reason || ''}\n${status?.outputSnippet || ''}`.toLowerCase();
          return /command not found|not found - type 'help'|is not recognized as an internal or external command/.test(text);
        };

        const dispatchAndWaitForCommand = async (cmd) => {
          const raw = String(cmd || '').trim();
          if (!raw) return { ok: false, route: 'none', reason: 'empty command' };

          // Always execute agent-issued commands in the Runtime terminal.
          setTerminalState('open');
          setActiveTerminalTab('runtime');

          // Keep dev/watch servers running; waiting for completion would block forever.
          if (isLikelyLongRunningCmd(raw)) {
            const activeRuntimeHandle = wcTermRefs.current.get(activeRuntimeTerminalIdRef.current);
            const sent = activeRuntimeHandle?.sendCommand(raw);
            if (sent === false) {
              return {
                ok: false,
                route: 'runtime',
                waited: false,
                reason: 'runtime not ready; start the runtime container first',
              };
            }
            return { ok: true, route: 'runtime', waited: false, longRunning: true };
          }

          const marker = `__ECS_AGENT_CMD_DONE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}__`;
          const wrapped = `{ ${raw}; }; __ecs_status=$?; echo "${marker}:$__ecs_status"`;
          const startIdx = terminalOutputRef.current.length;
          const activeRuntimeHandle = wcTermRefs.current.get(activeRuntimeTerminalIdRef.current);
          const sent = activeRuntimeHandle?.sendCommand(wrapped);

          if (sent === false) {
            return {
              ok: false,
              route: 'runtime',
              waited: false,
              reason: 'runtime not ready; start the runtime container first',
            };
          }

          const timeoutMs = 8 * 60 * 1000;
          const deadline = Date.now() + timeoutMs;
          const doneRegex = new RegExp(`${escapeRegExp(marker)}:(-?\\d+)`);

          while (Date.now() < deadline) {
            const tailLines = terminalOutputRef.current.slice(startIdx);
            const tail = tailLines.join('');
            const m = tail.match(doneRegex);
            if (m) {
              const status = Number.parseInt(m[1], 10) || 0;
              const outputSnippet = tailLines.slice(-30).join('\n');
              if (status === 0) {
                return {
                  ok: true,
                  route: 'runtime',
                  waited: true,
                  status,
                  outputSnippet,
                };
              }
              return {
                ok: false,
                route: 'runtime',
                waited: true,
                status,
                outputSnippet,
                reason: `command exited with status ${status}`,
              };
            }
            await sleep(250);
          }

          return {
            ok: false,
            route: 'runtime',
            waited: true,
            timeout: true,
            outputSnippet: terminalOutputRef.current.slice(startIdx).slice(-30).join('\n'),
            reason: `Timed out waiting for command to finish after ${Math.round(timeoutMs / 1000)}s`,
          };
        };

        await runDeepSeekReasonerPreflight();

        for (let round = 0; round < roundLimit; round++) {
          const payload = { agent: executionAgent, model: effectiveModel, messages: history, context, mode: chatMode };
          if (toolResults && pendingToolCalls) {
            payload.toolResults = toolResults;
            payload.pendingToolCalls = pendingToolCalls;
          }
          const data = await requestChatRound(payload);

          // If model returned text only, we're done
          if (data.type === 'text') {
            setAgentRunState(AGENT_RUN_STATES.RESPONDING);
            stateTransitions.push({ state: AGENT_RUN_STATES.RESPONDING, at: Date.now() });
            const pseudoToolText = typeof data.content === 'string'
              && /<\/?(read|write|edit|run|command|file|patch)>/i.test(data.content);
            const shouldForceToolRetry =
              chatMode === 'agent' &&
              round < 2 &&
              allToolCalls.length === 0 &&
              (looksLikeWorkspaceChangeRequest(userMessage) || pseudoToolText);
            const websiteStatus = websiteBuildMode ? assessWebsiteCoreCompletion(currentFS) : null;
            const shouldContinueWebsiteBuild =
              chatMode === 'agent' &&
              websiteBuildMode &&
              !websiteStatus?.complete;
            const shouldBlockBatchFinalize =
              chatMode === 'agent' &&
              batchChangeMode &&
              pendingBatchVerification &&
              summarizeFileChanges(allFileChanges).files.length > 0;
            const shouldBlockBuildTypecheckFinalize =
              chatMode === 'agent' &&
              (websiteBuildMode || appBuildMode) &&
              summarizeFileChanges(allFileChanges).files.length > 0 &&
              (!buildVerified || !typecheckVerified);

            if (shouldForceToolRetry) {
              history = [
                ...history,
                {
                  role: 'user',
                  content: 'System reminder: The user asked for a workspace change. Do not answer with prose only. Use workspace tools now: first inspect with readFile/listFiles/searchCode as needed, then apply edits with editFile/writeFile.',
                },
              ].slice(-historySliceLimit);
              allSteps.push('⚠️ Plain-text reply in agent mode; retrying once with forced tool-use reminder.');
              continue;
            }

            if (shouldContinueWebsiteBuild) {
              const missingText = (websiteStatus?.missing || []).join(', ') || 'core website aspects';
              history = [
                ...history,
                {
                  role: 'user',
                  content: `Continue building the website. Do not finalize yet. Remaining core aspects to implement: ${missingText}. Use tools to complete these now.`,
                },
              ].slice(-historySliceLimit);
              allSteps.push(`⚠️ Website build not complete yet (score ${websiteStatus?.score || 0}/5). Continuing implementation.`);
              continue;
            }

            if (shouldBlockBatchFinalize) {
              history = [
                ...history,
                {
                  role: 'user',
                  content: 'Batch mode still has unverified changes. Do not finalize yet. Run runBuild first, then runTypecheck/runLint/runTests if needed, inspect the results, fix any failures, and only then conclude.',
                },
              ].slice(-historySliceLimit);
              allSteps.push('⚠️ Batch-mode finalization blocked until build or verification commands complete.');
              continue;
            }

            if (shouldBlockBuildTypecheckFinalize) {
              const missing = [!buildVerified ? 'runBuild' : null, !typecheckVerified ? 'runTypecheck' : null].filter(Boolean).join(' + ');
              history = [
                ...history,
                {
                  role: 'user',
                  content: `Project build progression gate: do not finalize yet. Run ${missing}, inspect getProblems, fix failures, and continue.` ,
                },
              ].slice(-historySliceLimit);
              allSteps.push(`⚠️ Build progression gate: waiting for ${missing}.`);
              continue;
            }

            const lowWriteProgress =
              chatMode === 'agent' &&
              looksLikeWorkspaceChangeRequest(userMessage) &&
              allToolCalls.length >= 18 &&
              totalWriteSuccesses < 2;
            if (lowWriteProgress) {
              history = [
                ...history,
                {
                  role: 'user',
                  content: 'Progress policy: stop looping on analysis/commands. Apply concrete file edits now and verify them. Do not return prose-only until at least one meaningful write is completed.',
                },
              ].slice(-historySliceLimit);
              allSteps.push('⚠️ Low-write progress detected; forcing concrete edits before final response.');
              continue;
            }

            const msgId = makeMessageId('assistant');
            const summary = summarizeFileChanges(allFileChanges);
            const recap = buildExecutionRecap(allToolCalls, summary);
            if (summary.files.length > 0) {
              changeLedgerRef.current.set(msgId, Array.from(allFileChanges.values()));
            }
            const assistantMsg = {
              id: msgId,
              role: 'assistant',
              content: `${data.content || ''}${recap ? `\n\n---\n\n${recap}` : ''}`,
              agent: activeAgent,
              agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
              toolCalls: compactToolCalls(allToolCalls, 12),
              steps: allSteps,
              mode: chatMode,
              timestamp: Date.now(),
              usage: data.usage,          // surface cache-hit telemetry
              truncated: data._truncated, // set by the API on context-length fallback
              telemetry: {
                durationMs: Date.now() - executionStartedAt,
                rounds: round + 1,
                transitions: stateTransitions,
                toolCalls: allToolCalls.length,
              },
              changedFiles: summary.files,
              changedPlus: summary.totalPlus,
              changedMinus: summary.totalMinus,
              changeStatus: summary.files.length > 0 ? 'pending' : undefined,
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
            setAgentRunState(AGENT_RUN_STATES.TOOL_EXECUTION);
            stateTransitions.push({ state: AGENT_RUN_STATES.TOOL_EXECUTION, at: Date.now() });
            consecToolRounds++;

            // Soft warning after MAX_TOOL_ROUNDS — does NOT block continuation.
            if (consecToolRounds === MAX_TOOL_ROUNDS) {
              if (!chatQuietMode) {
                toast.warn?.(`⚠️ Warning: Approaching maximum tool rounds (${allToolCalls.length} calls). Consider summarizing or starting a new context soon. You can continue sending messages.`);
              }
            }

            // Show thinking text if present
            if (data.content) {
              allSteps.push(`💭 ${data.content.slice(0, 200)}`);
            }

            // Execute each tool call locally (sequential so lastToolCallSig stays accurate)
            toolResults = [];
            const isWriteTool = (name) => name === 'writeFile' || name === 'editFile' || name === 'patchLines' || name === 'deleteFile' || name === 'searchAndReplace' || name === 'autoFix' || name === 'createComponent';
            const isVerificationCommandTool = (name) => name === 'runBuild' || name === 'runTypecheck' || name === 'runLint' || name === 'runTests';
            const isReadTool = (name) => name === 'readFile' || name === 'analyzeFile' || name === 'searchCode' || name === 'getProjectStructure' || name === 'listFiles';
            const enforceDeepSeekWriteAfterRead = false;
            const enforceDeepSeekFocusBounds = !batchChangeMode;
            let roundReadBudgetSpent = false;
            let writeRequiredBeforeMoreReads = enforceDeepSeekWriteAfterRead && consecReadOnlyRounds > 0;
            let changedPathsInRound = [];
            let roundDeleteAttempts = 0;

            const proposedWritePaths = data.tool_calls
              .filter((tc) => isWriteTool(tc.name))
              .map((tc) => toolCallPath(tc))
              .filter((p) => typeof p === 'string' && p.length > 0);

            if (!batchChangeMode && !activeWorkFile && proposedWritePaths.length > 0) {
              activeWorkFile = proposedWritePaths[0];
              supportReadFiles = [];
              allSteps.push(`🎯 Primary work file: ${activeWorkFile}`);
            }

            for (const tc of data.tool_calls) {
              const signature = toolCallSignature(tc.name, tc.arguments);
              const isConsecutiveDuplicate = signature === lastToolCallSig;
              const tcPath = toolCallPath(tc);
              if (tc.name === 'deleteFile') roundDeleteAttempts += 1;
              const activeFileReadBlocked = tc.name === 'readFile' && tcPath === activeFile;
              const deleteBlocked = tc.name === 'deleteFile' && !userExplicitlyRequestedDeletion(userMessage, tcPath);
              const destructiveSweepApproved = userExplicitlyApprovedDestructiveSweep(userMessage);
              const multiDeleteSweepBlocked = tc.name === 'deleteFile' && roundDeleteAttempts > 1 && !destructiveSweepApproved;
              const workspaceReplaceBlocked = tc.name === 'searchAndReplace' && !tc.arguments?.targetFile && !destructiveSweepApproved;
              const destructiveReplaceBlocked = tc.name === 'searchAndReplace' && !tc.arguments?.targetFile && String(tc.arguments?.replacement ?? '') === '' && !destructiveSweepApproved;
              const writeOutOfScope = enforceDeepSeekFocusBounds && !!activeWorkFile && isWriteTool(tc.name) && !!tcPath && tcPath !== activeWorkFile;
              const blockedForReadLoop = enforceDeepSeekWriteAfterRead && isReadTool(tc.name) && (writeRequiredBeforeMoreReads || roundReadBudgetSpent);

              let readOutOfScope = false;
              if (enforceDeepSeekFocusBounds && !!activeWorkFile && isReadTool(tc.name) && !!tcPath && tcPath !== activeWorkFile) {
                if (!supportReadFiles.includes(tcPath) && supportReadFiles.length >= MAX_SUPPORT_READ_FILES) {
                  readOutOfScope = true;
                }
              }

              const isOutOfScope = writeOutOfScope || readOutOfScope;
              const result = isOutOfScope
                ? {
                    ok: false,
                    blocked: true,
                    systemMessage: writeOutOfScope
                      ? `Stay focused on ${activeWorkFile} unless the task clearly requires writing ${tcPath} next.`
                      : `Support reads are limited to ${MAX_SUPPORT_READ_FILES} files while focused on ${activeWorkFile}.`,
                    error: writeOutOfScope
                      ? `Blocked cross-file write: ${tcPath}`
                      : `Blocked support read: ${tcPath}`,
                  }
                : activeFileReadBlocked
                ? {
                    ok: false,
                    blocked: true,
                    systemMessage: 'The active file is already in context with line numbers. Do not call readFile on it again. Write to it with patchLines, editFile, or writeFile.',
                    error: `Blocked active-file read: ${tcPath}`,
                  }
                : deleteBlocked
                ? {
                    ok: false,
                    blocked: true,
                    systemMessage: 'Destructive file deletion is blocked unless the user explicitly asked to delete that specific file. Repair in place instead.',
                    error: `Blocked deleteFile: ${tcPath}`,
                  }
                : multiDeleteSweepBlocked
                ? {
                    ok: false,
                    blocked: true,
                    systemMessage: 'Bulk delete sweep blocked. Explicit destructive sweep approval is required before deleting multiple files in one round.',
                    error: 'Blocked multi-file delete sweep',
                  }
                : destructiveReplaceBlocked
                ? {
                    ok: false,
                    blocked: true,
                    systemMessage: 'Workspace-wide removal replace blocked. Empty replacement across multiple files requires explicit destructive sweep approval.',
                    error: 'Blocked destructive searchAndReplace sweep',
                  }
                : workspaceReplaceBlocked
                ? {
                    ok: false,
                    blocked: true,
                    systemMessage: 'Workspace-wide searchAndReplace is blocked by default. Scope it to a targetFile or provide explicit destructive sweep approval.',
                    error: 'Blocked workspace-wide searchAndReplace',
                  }
                : isConsecutiveDuplicate
                ? {
                    ok: false,
                    duplicate: true,
                    systemMessage: 'You just read this file, please proceed with the data provided',
                  }
                : blockedForReadLoop
                ? {
                    ok: false,
                    blocked: true,
                    systemMessage: writeRequiredBeforeMoreReads
                      ? 'Read-only progress already happened in the prior round. Your next successful tool call must be a file write in the active work file.'
                      : 'DeepSeek read budget exhausted for this round. Your next successful tool call must be patchLines, editFile, writeFile, autoFix, or createComponent.',
                    error: writeRequiredBeforeMoreReads
                      ? 'Blocked read: file write required before more reads'
                      : 'Blocked read: consecutive reads in one round are not allowed',
                  }
                : await executeToolCall(tc.name, tc.arguments, currentFS);

              if (!isOutOfScope && !!activeWorkFile && isReadTool(tc.name) && !!tcPath && tcPath !== activeWorkFile && !supportReadFiles.includes(tcPath)) {
                supportReadFiles.push(tcPath);
                allSteps.push(`📎 support read ${supportReadFiles.length}/${MAX_SUPPORT_READ_FILES}: ${tcPath}`);
              }

              if (enforceDeepSeekWriteAfterRead && isReadTool(tc.name) && result?.ok) {
                roundReadBudgetSpent = true;
              }

              if (isWriteTool(tc.name) && result?.ok) {
                writeRequiredBeforeMoreReads = false;
              }

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
              const icon = tc.name === 'writeFile' ? '📝' : tc.name === 'editFile' ? '✏️' : tc.name === 'deleteFile' ? '🗑️' : tc.name === 'readFile' ? '📖' : tc.name === 'searchCode' ? '🔍' : tc.name === 'analyzeFile' ? '🔬' : tc.name === 'runCommand' ? '💻' : '📋';
              const resultSummary = isConsecutiveDuplicate
                ? '⚠️ duplicate blocked'
                : activeFileReadBlocked
                  ? '🚫 blocked (active file already in context)'
                : deleteBlocked
                  ? '🚫 blocked (destructive delete requires explicit user request)'
                : multiDeleteSweepBlocked
                  ? '🚫 blocked (multi-file delete sweep requires explicit approval)'
                : destructiveReplaceBlocked
                  ? '🚫 blocked (destructive workspace replace requires explicit approval)'
                : workspaceReplaceBlocked
                  ? '🚫 blocked (workspace-wide replace requires explicit approval)'
                : isOutOfScope
                  ? `🚫 blocked (focus ${activeWorkFile})`
                : tc.name === 'analyzeFile' && result.ok
                  ? `${result.issueCount} issue(s) [${result.summary}]`
                  : tc.name === 'diagnoseProject' && result.ok
                    ? `${result.summary}`
                  : result.ok ? '✅' : '❌ ' + result.error;
              allSteps.push(`${icon} **${tc.name}**(${argSummary}) → ${resultSummary}`);
              allToolCalls.push({ tool: tc.name, args: tc.arguments });
              toolResults.push({ id: tc.id, name: tc.name, result });
            }

            const roundWriteSuccesses = data.tool_calls.reduce((count, tc, idx) => {
              const policyWrite = isFileWriteTool(tc.name);
              const ok = !!toolResults?.[idx]?.result?.ok;
              return policyWrite && ok ? count + 1 : count;
            }, 0);
            totalWriteSuccesses += roundWriteSuccesses;
            noWriteRounds = roundWriteSuccesses > 0 ? 0 : noWriteRounds + 1;

            if (
              chatMode === 'agent' &&
              looksLikeWorkspaceChangeRequest(userMessage) &&
              allToolCalls.length >= 24 &&
              totalWriteSuccesses < 3 &&
              noWriteRounds >= 2
            ) {
              history = [
                ...history,
                {
                  role: 'user',
                  content: 'Progress gate: too many tool calls without concrete edits. Stop command retries and read loops. Perform file writes now (editFile/writeFile/patchLines), then verify.',
                },
              ].slice(-historySliceLimit);
              allSteps.push(`⚠️ Progress gate triggered: ${allToolCalls.length} calls with ${totalWriteSuccesses} file write(s). Forcing write-first behavior.`);
            }

            // Apply filesystem mutations
            const { newFS, changed, cmdsToRun, changeItems } = applyToolMutations(data.tool_calls, toolResults, currentFS);
            changeItems.forEach((item) => {
              const prev = allFileChanges.get(item.path);
              if (!prev) {
                allFileChanges.set(item.path, item);
                return;
              }
              allFileChanges.set(item.path, {
                ...item,
                before: prev.before,
              });
            });
            if (changed) {
              currentFS = newFS;
              changedPathsInRound = Array.from(new Set(changeItems.map((c) => c.path)));
              replaceAll(newFS);
              data.tool_calls.forEach(tc => {
                if (tc.name === 'writeFile') {
                  setOpenTabs(prev => prev.includes(tc.arguments.path) ? prev : [...prev, tc.arguments.path]);
                  setActiveFile(tc.arguments.path);
                }
              });

              if (batchChangeMode) {
                if (!pendingBatchVerification) {
                  history = [
                    ...history,
                    {
                      role: 'user',
                      content: 'Batch mode is active. Keep applying related multi-file patches without verifying after each file. When the patch batch is complete, runBuild first, then runTypecheck/runLint/runTests if needed.',
                    },
                  ].slice(-historySliceLimit);
                }
                pendingBatchVerification = true;
                allSteps.push(`🧩 Batch mode: deferred verification across ${changedPathsInRound.length} changed file(s).`);
              } else {
                setAgentRunState(AGENT_RUN_STATES.VERIFYING);
                stateTransitions.push({ state: AGENT_RUN_STATES.VERIFYING, at: Date.now() });
                const verificationIssues = [];
                for (const path of changedPathsInRound) {
                  const check = await executeToolCall('analyzeFile', { path }, currentFS);
                  if (check?.ok) {
                    const errorCount = (check.issues || []).filter((i) => i.type === 'error').length;
                    if (errorCount > 0) verificationIssues.push({ path, errorCount, summary: check.summary });
                    allSteps.push(`✅ **verify**(${path}) → ${check.issueCount ?? 0} issue(s), ${errorCount} error(s)`);
                  }
                }
                if (activeWorkFile && changedPathsInRound.includes(activeWorkFile)) {
                  const lockedFileHasErrors = verificationIssues.some((v) => v.path === activeWorkFile && v.errorCount > 0);
                  if (!lockedFileHasErrors) {
                    allSteps.push(`✅ Single-file step complete: ${activeWorkFile}`);
                    activeWorkFile = null;
                    supportReadFiles = [];
                  }
                }
                if (verificationIssues.length > 0 && verificationFailures < 2) {
                  verificationFailures++;
                  const issueText = verificationIssues
                    .map((v) => `${v.path}: ${v.errorCount} error(s) [${v.summary}]`)
                    .join('; ');
                  history = [
                    ...history,
                    {
                      role: 'user',
                      content: `Post-edit verification found remaining errors. Fix these before finalizing: ${issueText}. Use write tools now.`,
                    },
                  ].slice(-historySliceLimit);
                } else if (verificationIssues.length === 0 && changedPathsInRound.length > 0 && !activeWorkFile) {
                  const runtimeCheck = await executeToolCall('getProblems', { lines: 120 }, currentFS);
                  const runtimeErrors = runtimeCheck?.ok
                    ? (runtimeCheck.problems || []).filter((p) => p.severity === 'error').length
                    : 0;
                  if (runtimeErrors === 0) {
                    if (isBackendArchitectAgent && !backendVerificationSatisfied) {
                      history = [
                        ...history,
                        {
                          role: 'user',
                          content: 'Backend completion gate: run runBuild and runTypecheck now, inspect getProblems, fix any failures, and only then finalize.',
                        },
                      ].slice(-historySliceLimit);
                      allSteps.push('🛡️ Backend gate: analyzer checks are clean, but command verification has not completed yet.');
                      continue;
                    }
                    if (websiteBuildMode) {
                      const websiteStatus = assessWebsiteCoreCompletion(currentFS);
                      if (!websiteStatus.complete) {
                        const missingText = websiteStatus.missing.join(', ') || 'core website aspects';
                        history = [
                          ...history,
                          {
                            role: 'user',
                            content: `Keep going. Website build is still in progress. Implement remaining core aspects: ${missingText}. Continue until these are complete.`,
                          },
                        ].slice(-historySliceLimit);
                        allSteps.push(`🏗️ Website workflow continuing (${websiteStatus.score}/5 complete).`);
                        continue;
                      }
                    }
                    const msgId = makeMessageId('assistant');
                    const summary = summarizeFileChanges(allFileChanges);
                    const recap = buildExecutionRecap(allToolCalls, summary);
                    if (summary.files.length > 0) {
                      changeLedgerRef.current.set(msgId, Array.from(allFileChanges.values()));
                    }
                    const assistantMsg = {
                      id: msgId,
                      role: 'assistant',
                      content: `✅ Project roundup complete. Implemented and verified ${summary.files.length} file(s) with no analyzer/runtime errors detected in the latest checks.${recap ? `\n\n---\n\n${recap}` : ''}`,
                      agent: activeAgent,
                      agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
                      toolCalls: compactToolCalls(allToolCalls, 12),
                      steps: allSteps,
                      mode: chatMode,
                      timestamp: Date.now(),
                      changedFiles: summary.files,
                      changedPlus: summary.totalPlus,
                      changedMinus: summary.totalMinus,
                    };
                    setMessages(prev => [...prev.filter(m => !m._progress), assistantMsg]);
                    setConversations(prev => prev.map(c => c.id === activeConvoId
                      ? { ...c, messages: [...c.messages.filter(m => !m._progress), assistantMsg] }
                      : c));
                    return;
                  }
                }
              }
            }
            // Run terminal commands requested by agent and wait for completion
            // (for finite runtime commands) before the next tool-call round.
            if (cmdsToRun.length > 0) {
              const uniqueCmdsToRun = [];
              const seenCmds = new Set();
              for (const cmd of cmdsToRun) {
                const key = normalizeCommand(cmd);
                if (seenCmds.has(key)) continue;
                seenCmds.add(key);
                uniqueCmdsToRun.push(cmd);
              }
              const commandStatuses = [];
              const verificationCommandsRequested = data.tool_calls.some((tc) => isVerificationCommandTool(tc.name));
              for (const cmd of uniqueCmdsToRun) {
                const normalized = normalizeCommand(cmd);
                const family = commandFamily(cmd);
                let runStatus;

                if (commandBlocked.has(normalized) || commandFamilyBlocked.has(family)) {
                  runStatus = {
                    ok: false,
                    blocked: true,
                    reason: commandFamilyBlocked.has(family)
                      ? `blocked command family '${family}' after repeated failures; switch to code edits or a different command family`
                      : 'blocked after repeated failures; choose a different command',
                  };
                } else {
                  runStatus = await dispatchAndWaitForCommand(cmd);
                }

                if (!runStatus.ok && !runStatus.blocked) {
                  const prevFails = Number(commandFailureCounts.get(normalized) || 0);
                  const failCount = prevFails + 1;
                  commandFailureCounts.set(normalized, failCount);
                  const prevFamilyFails = Number(commandFamilyFailureCounts.get(family) || 0);
                  const familyFailCount = prevFamilyFails + 1;
                  commandFamilyFailureCounts.set(family, familyFailCount);
                  const hardFailure = isHardCommandFailure(runStatus);
                  const missingBinary = isMissingBinaryFailure(runStatus);

                  const alternatives = (hardFailure || missingBinary)
                    ? []
                    : buildCommandAlternatives(cmd, runStatus, currentFS)
                      .filter((alt) => {
                        const altNorm = normalizeCommand(alt);
                        const altFamily = commandFamily(alt);
                        return !commandBlocked.has(altNorm) && !commandFamilyBlocked.has(altFamily);
                      });
                  if (!(hardFailure || missingBinary) && alternatives.length > 0) {
                    allSteps.push(`🧭 **command**(\`${cmd}\`) failed; trying fallback \`${alternatives[0]}\``);
                    const altStatus = await dispatchAndWaitForCommand(alternatives[0]);
                    if (altStatus.ok) {
                      runStatus = { ...altStatus, fallbackFrom: cmd, command: alternatives[0] };
                      commandFailureCounts.delete(normalized);
                      commandFamilyFailureCounts.delete(family);
                    } else {
                      const altNorm = normalizeCommand(alternatives[0]);
                      const altFamily = commandFamily(alternatives[0]);
                      const altFails = Number(commandFailureCounts.get(altNorm) || 0) + 1;
                      commandFailureCounts.set(altNorm, altFails);
                      const altFamilyFails = Number(commandFamilyFailureCounts.get(altFamily) || 0) + 1;
                      commandFamilyFailureCounts.set(altFamily, altFamilyFails);
                    }
                  }

                  if (!runStatus.ok && (hardFailure || missingBinary || runStatus.reason === 'runtime not ready' || failCount >= 2)) {
                    commandBlocked.add(normalized);
                  }
                  if (hardFailure || missingBinary || familyFailCount >= 2) {
                    commandFamilyBlocked.add(family);
                  }
                } else if (runStatus.ok) {
                  commandFailureCounts.delete(normalized);
                  commandBlocked.delete(normalized);
                  commandFamilyFailureCounts.delete(family);
                }

                commandStatuses.push({ cmd, ...runStatus });
                if (runStatus.ok) {
                  const shownCmd = runStatus.command || cmd;
                  const outputSnippet = formatCommandOutputSnippet(runStatus.outputSnippet);
                  if (runStatus.longRunning) {
                    allSteps.push(`🧵 **command**(\`${shownCmd}\`) → started (long-running)`);
                  } else if (runStatus.waited) {
                    allSteps.push(`⏳ **command**(\`${shownCmd}\`) → finished (exit ${runStatus.status ?? 0})${outputSnippet ? `\n\`\`\`\n${outputSnippet}\n\`\`\`` : ''}`);
                  } else {
                    allSteps.push(`✅ **command**(\`${shownCmd}\`) → finished`);
                  }
                } else if (runStatus.timeout) {
                  allSteps.push(`⏱️ **command**(\`${cmd}\`) → timeout waiting for completion`);
                } else {
                  const outputSnippet = formatCommandOutputSnippet(runStatus.outputSnippet);
                  allSteps.push(`❌ **command**(\`${cmd}\`) → ${runStatus.reason || 'failed to dispatch'}${outputSnippet ? `\n\`\`\`\n${outputSnippet}\n\`\`\`` : ''}`);
                }
              }

              const familyBlockedText = Array.from(commandFamilyBlocked).slice(-4).join(', ');
              if (familyBlockedText) {
                history = [
                  ...history,
                  {
                    role: 'user',
                    content: `Command retry guard engaged. Stop repeating blocked command families (${familyBlockedText}). If terminal tooling is unavailable, update code/config instead and surface one clear blocker.`,
                  },
                ].slice(-historySliceLimit);
              }

              const blockers = commandStatuses.filter((s) => !s.ok && (s.timeout || s.reason === 'runtime not ready'));
              if (blockers.length > 0) {
                const blockerText = blockers
                  .map((s) => `${s.cmd}: ${s.reason || 'command did not finish'}`)
                  .join('; ');
                history = [
                  ...history,
                  {
                    role: 'user',
                    content: `System command barrier: do not proceed to new tool calls until command execution is resolved. Blocked commands: ${blockerText}`,
                  },
                ].slice(-historySliceLimit);
              }

              if (verificationCommandsRequested && commandStatuses.every((s) => s.ok)) {
                const requestedBuild = data.tool_calls.some((tc) => tc.name === 'runBuild');
                const requestedTypecheck = data.tool_calls.some((tc) => tc.name === 'runTypecheck');
                if (requestedBuild) buildVerified = true;
                if (requestedTypecheck) typecheckVerified = true;
                setAgentRunState(AGENT_RUN_STATES.VERIFYING);
                stateTransitions.push({ state: AGENT_RUN_STATES.VERIFYING, at: Date.now() });
                const verificationIssues = [];
                const changedPaths = Array.from(allFileChanges.keys());
                for (const path of changedPaths) {
                  const check = await executeToolCall('analyzeFile', { path }, currentFS);
                  if (check?.ok) {
                    const errorCount = (check.issues || []).filter((i) => i.type === 'error').length;
                    if (errorCount > 0) verificationIssues.push({ path, errorCount, summary: check.summary });
                    allSteps.push(`✅ **verify**(${path}) → ${check.issueCount ?? 0} issue(s), ${errorCount} error(s)`);
                  }
                }

                const runtimeCheck = await executeToolCall('getProblems', { lines: 120 }, currentFS);
                const runtimeErrors = runtimeCheck?.ok
                  ? (runtimeCheck.problems || []).filter((p) => p.severity === 'error').length
                  : 0;

                if (verificationIssues.length > 0 && verificationFailures < 2) {
                  pendingBatchVerification = true;
                  verificationFailures++;
                  const issueText = verificationIssues
                    .map((v) => `${v.path}: ${v.errorCount} error(s) [${v.summary}]`)
                    .join('; ');
                  history = [
                    ...history,
                    {
                      role: 'user',
                      content: `Post-build verification found remaining file errors. Fix these before finalizing: ${issueText}.`,
                    },
                  ].slice(-historySliceLimit);
                } else if (runtimeErrors > 0) {
                  pendingBatchVerification = true;
                  history = [
                    ...history,
                    {
                      role: 'user',
                      content: 'Build or terminal verification still shows runtime/build errors. Read the problems, fix them, and rerun verification before finalizing.',
                    },
                  ].slice(-historySliceLimit);
                } else if (changedPaths.length > 0) {
                  if ((websiteBuildMode || appBuildMode) && (!buildVerified || !typecheckVerified)) {
                    pendingBatchVerification = true;
                    const missing = [!buildVerified ? 'runBuild' : null, !typecheckVerified ? 'runTypecheck' : null].filter(Boolean).join(' + ');
                    history = [
                      ...history,
                      {
                        role: 'user',
                        content: `Do not finalize yet. Complete verification with ${missing}, inspect getProblems, fix any failures, then continue.`,
                      },
                    ].slice(-historySliceLimit);
                    allSteps.push(`⚠️ Build verification incomplete: waiting for ${missing}.`);
                    continue;
                  }
                  if (isBackendArchitectAgent) {
                    backendVerificationSatisfied = true;
                  }
                  pendingBatchVerification = false;
                  if (websiteBuildMode) {
                    const websiteStatus = assessWebsiteCoreCompletion(currentFS);
                    if (!websiteStatus.complete) {
                      const missingText = websiteStatus.missing.join(', ') || 'core website aspects';
                      history = [
                        ...history,
                        {
                          role: 'user',
                          content: `Keep going. Website build is still in progress. Implement remaining core aspects: ${missingText}. Continue until these are complete.`,
                        },
                      ].slice(-historySliceLimit);
                      allSteps.push(`🏗️ Website workflow continuing (${websiteStatus.score}/5 complete).`);
                      continue;
                    }
                  }
                  if ((websiteBuildMode || appBuildMode) && planMajorSteps.length > 0) {
                    const completedIdx = Math.min(planStepIndex, planMajorSteps.length - 1);
                    const completedStep = planMajorSteps[completedIdx] || `Step ${completedIdx + 1}`;
                    const hasNextStep = completedIdx + 1 < planMajorSteps.length;
                    if (hasNextStep) {
                      planStepIndex = completedIdx + 1;
                      planAwaitingApproval = true;
                      const checkpointMsg = {
                        id: makeMessageId('assistant'),
                        role: 'assistant',
                        content: `Plan progress: completed step ${completedIdx + 1}/${planMajorSteps.length}: ${completedStep}.\n\nDo you want me to build the next step now (${planStepIndex + 1}/${planMajorSteps.length}: ${planMajorSteps[planStepIndex]})? Reply \"continue\" to proceed or \"pause\" to stop here.`,
                        agent: activeAgent,
                        agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
                        toolCalls: compactToolCalls(allToolCalls, 12),
                        steps: allSteps,
                        mode: chatMode,
                        timestamp: Date.now(),
                        canContinue: true,
                        resumeState: {
                          history: packChatHistory(history, activeFile, userMessage, historyPackLimit),
                          pendingToolCalls: Array.isArray(pendingToolCalls) ? pendingToolCalls : [],
                          toolResults: Array.isArray(toolResults)
                            ? toolResults.map((tr) => ({ ...tr, result: compactToolResultPayload(tr.result) }))
                            : [],
                          lastToolCallSig,
                          websiteBuildMode,
                          appBuildMode,
                          commandPipelineMode,
                          batchChangeMode,
                          totalWriteSuccesses,
                          noWriteRounds,
                          pendingBatchVerification,
                          backendVerificationSatisfied,
                          buildVerified,
                          typecheckVerified,
                          planMajorSteps,
                          planStepIndex,
                          planAwaitingApproval,
                          deepseekReasonerPrimed,
                          deepseekPlanSummary,
                          commandFailureCounts: Object.fromEntries(commandFailureCounts),
                          commandBlocked: Array.from(commandBlocked),
                          commandFamilyFailureCounts: Object.fromEntries(commandFamilyFailureCounts),
                          commandFamilyBlocked: Array.from(commandFamilyBlocked),
                          activeWorkFile,
                          supportReadFiles,
                          consecReadOnlyRounds,
                          stagnationRounds,
                          allSteps: allSteps.slice(-120),
                          allToolCalls: allToolCalls.slice(-120),
                        },
                      };
                      setMessages(prev => [...prev.filter(m => !m._progress), checkpointMsg]);
                      setConversations(prev => prev.map(c => c.id === activeConvoId
                        ? { ...c, messages: [...c.messages.filter(m => !m._progress), checkpointMsg] }
                        : c));
                      return;
                    }
                  }
                  const msgId = makeMessageId('assistant');
                  const summary = summarizeFileChanges(allFileChanges);
                  const recap = buildExecutionRecap(allToolCalls, summary);
                  if (summary.files.length > 0) {
                    changeLedgerRef.current.set(msgId, Array.from(allFileChanges.values()));
                  }
                  const assistantMsg = {
                    id: msgId,
                    role: 'assistant',
                    content: `✅ Project roundup complete. Implemented ${summary.files.length} file(s) and verified the batch with command execution and follow-up checks.${recap ? `\n\n---\n\n${recap}` : ''}`,
                    agent: activeAgent,
                    agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
                    toolCalls: compactToolCalls(allToolCalls, 12),
                    steps: allSteps,
                    mode: chatMode,
                    timestamp: Date.now(),
                    changedFiles: summary.files,
                    changedPlus: summary.totalPlus,
                    changedMinus: summary.totalMinus,
                  };
                  setMessages(prev => [...prev.filter(m => !m._progress), assistantMsg]);
                  setConversations(prev => prev.map(c => c.id === activeConvoId
                    ? { ...c, messages: [...c.messages.filter(m => !m._progress), assistantMsg] }
                    : c));
                  return;
                }
              }
            }

            // ── Read-loop detection ───────────────────────────────────────────
            // If the model called ONLY read tools this round (nothing was written),
            // track it. After 2 consecutive read-only rounds inject a hard user
            // message into history so the model is forced to write next round.
            const roundHasWrite = data.tool_calls.some((tc, i) => {
              if (!isWritePolicy(tc.name)) return false;
              return !!toolResults?.[i]?.result?.ok;
            });
            consecReadOnlyRounds = roundHasWrite ? 0 : consecReadOnlyRounds + 1;

            const roundMadeProgress = !!changed || roundHasWrite || cmdsToRun.length > 0;
            stagnationRounds = roundMadeProgress ? 0 : stagnationRounds + 1;

            if (stagnationRounds >= 4) {
              allSteps.push(`⚠️ Low-progress detected (${stagnationRounds} rounds). Auto-steering to finish one concrete ${batchChangeMode ? 'batch' : 'file'} outcome.`);
              history = [
                ...history,
                {
                  role: 'user',
                  content: batchChangeMode
                    ? 'System steering: No interruption. Continue coordinated multi-file implementation for this app build. Do not stop after one file. Complete a coherent batch, then verify and conclude.'
                    : 'System steering: No interruption. Finish one concrete file outcome now. Do not branch to new files. Implement, verify, and conclude.',
                },
              ].slice(-historySliceLimit);
              // Reset so this steering can take effect without repetitive spam.
              stagnationRounds = 0;
            }

            if (consecReadOnlyRounds >= 3) {
              const msg = `🚨 You are stuck in a read loop (${consecReadOnlyRounds} read-only rounds). Use available context and perform a concrete change now (patchLines/editFile/writeFile), or runBuild/runTests/runLint/runTypecheck if verification is the blocker.`;
              history = [...history, { role: 'user', content: msg }].slice(-historySliceLimit);
              allSteps.push(`⚠️ Read-loop (${consecReadOnlyRounds} read-only rounds) — forcing write on next round.`);
            }
            // ─────────────────────────────────────────────────────────────────

            pendingToolCalls = data.tool_calls;

            // Update steps in real-time with a progress message
            setMessages(prev => {
              const progressMsg = prev.find(m => m._progress && m.agent === activeAgent);
              const msg = {
                role: 'assistant', _progress: true,
                content: `Working (${agentRunState})... (${allToolCalls.length} tool call${allToolCalls.length > 1 ? 's' : ''})${deepseekPlanSummary ? `\nPlan: ${deepseekPlanSummary}` : ''}`,
                agent: activeAgent, agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
                toolCalls: compactToolCalls(allToolCalls, 12), steps: [...allSteps],
                mode: chatMode, timestamp: Date.now(),
              };
              return progressMsg ? prev.map(m => m._progress && m.agent === activeAgent ? msg : m) : [...prev, msg];
            });

            continue; // next round
          }

          // Unexpected response shape — treat as text
          const msgId = makeMessageId('assistant');
          const summary = summarizeFileChanges(allFileChanges);
          const recap = buildExecutionRecap(allToolCalls, summary);
          if (summary.files.length > 0) {
            changeLedgerRef.current.set(msgId, Array.from(allFileChanges.values()));
          }
          const assistantMsg = {
            id: msgId,
            role: 'assistant',
            content: `${data.content || 'Done.'}${recap ? `\n\n---\n\n${recap}` : ''}`,
            agent: activeAgent, agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
            toolCalls: compactToolCalls(allToolCalls, 12), steps: allSteps, mode: chatMode, timestamp: Date.now(),
            changedFiles: summary.files,
            changedPlus: summary.totalPlus,
            changedMinus: summary.totalMinus,
            telemetry: {
              durationMs: Date.now() - executionStartedAt,
              rounds: round + 1,
              transitions: stateTransitions,
              toolCalls: allToolCalls.length,
            },
            changeStatus: summary.files.length > 0 ? 'pending' : undefined,
          };
          setMessages(prev => [...prev.filter(m => !m._progress), assistantMsg]);
          setConversations(prev => prev.map(c => c.id === activeConvoId ? { ...c, messages: [...c.messages.filter(m => !m._progress), assistantMsg] } : c));
          return;
        }

        // Max rounds reached — always show a Continue / Done prompt
        {
          const msgId = makeMessageId('assistant');
          const summary = summarizeFileChanges(allFileChanges);
          const recap = buildExecutionRecap(allToolCalls, summary);
          if (summary.files.length > 0) {
            changeLedgerRef.current.set(msgId, Array.from(allFileChanges.values()));
          }
          const finalMsg = {
            id: msgId,
            role: 'assistant',
            content: `I've completed ${allToolCalls.length} operation${allToolCalls.length !== 1 ? 's' : ''} and reached the round limit. There may be more work remaining.${recap ? `\n\n---\n\n${recap}` : ''}`,
            agent: activeAgent, agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
            toolCalls: compactToolCalls(allToolCalls, 12), steps: allSteps, mode: chatMode, timestamp: Date.now(),
            changedFiles: summary.files,
            changedPlus: summary.totalPlus,
            changedMinus: summary.totalMinus,
            telemetry: {
              durationMs: Date.now() - executionStartedAt,
              rounds: roundLimit,
              transitions: stateTransitions,
              toolCalls: allToolCalls.length,
            },
            changeStatus: summary.files.length > 0 ? 'pending' : undefined,
            resumeState: {
              history: packChatHistory(history, activeFile, userMessage, historyPackLimit),
              pendingToolCalls: Array.isArray(pendingToolCalls) ? pendingToolCalls : [],
              toolResults: Array.isArray(toolResults)
                ? toolResults.map((tr) => ({ ...tr, result: compactToolResultPayload(tr.result) }))
                : [],
              lastToolCallSig,
              websiteBuildMode,
              appBuildMode,
              commandPipelineMode,
              batchChangeMode,
              totalWriteSuccesses,
              noWriteRounds,
              pendingBatchVerification,
              backendVerificationSatisfied,
              buildVerified,
              typecheckVerified,
              planMajorSteps,
              planStepIndex,
              planAwaitingApproval,
              deepseekReasonerPrimed,
              deepseekPlanSummary,
              commandFailureCounts: Object.fromEntries(commandFailureCounts),
              commandBlocked: Array.from(commandBlocked),
              commandFamilyFailureCounts: Object.fromEntries(commandFamilyFailureCounts),
              commandFamilyBlocked: Array.from(commandFamilyBlocked),
              activeWorkFile,
              supportReadFiles,
              consecReadOnlyRounds,
              stagnationRounds,
              allSteps: allSteps.slice(-120),
              allToolCalls: allToolCalls.slice(-120),
            },
            canContinue: true,
          };
          setMessages(prev => [...prev.filter(m => !m._progress), finalMsg]);
          setConversations(prev => prev.map(c => c.id === activeConvoId ? { ...c, messages: [...c.messages.filter(m => !m._progress), finalMsg] } : c));
        }
      } catch (err) {
        // AbortError is a deliberate user stop — don't show the fallback.
        if (err?.name === 'AbortError') {
          setMessages(prev => prev.filter(m => !m._progress));
          return;
        }
        logger.error('chat', 'API call failed', { message: err?.message, code: err?.code, retryable: err?.retryable });
        setAgentRunState(AGENT_RUN_STATES.FAILED);
        stateTransitions.push({ state: AGENT_RUN_STATES.FAILED, at: Date.now() });
        const msgId = makeMessageId('assistant');
        const summary = summarizeFileChanges(allFileChanges);
        const recap = buildExecutionRecap(allToolCalls, summary);
        if (summary.files.length > 0) {
          changeLedgerRef.current.set(msgId, Array.from(allFileChanges.values()));
        }
        const shouldAutoResume = !!err?.retryable
          && autoResumeAttempts < 1
          && !commandPipelineMode
          && activeAgent !== 'deepseek';
        const assistantMsg = {
          id: msgId,
          role: 'assistant',
          content: (shouldAutoResume
            ? `Temporary upstream issue (${err.code || 'UPSTREAM_ERROR'}). Retrying automatically...`
            : err?.retryable
              ? `Temporary upstream issue (${err.code || 'UPSTREAM_ERROR'}). Please try again in a moment.`
              : `API error: ${err?.message || 'Unknown error'}.`) + (recap ? `\n\n---\n\n${recap}` : ''),
          agent: activeAgent,
          agentName: AGENT_REGISTRY[activeAgent]?.name || 'Agent',
          toolCalls: compactToolCalls(allToolCalls, 12),
          steps: [...allSteps, `⚠️ API error: ${err?.message || 'Unknown error'}`],
          mode: chatMode,
          timestamp: Date.now(),
          changedFiles: summary.files,
          changedPlus: summary.totalPlus,
          changedMinus: summary.totalMinus,
          canContinue: false,
          resumeState: {
            history: packChatHistory(history, activeFile, userMessage, historyPackLimit),
            pendingToolCalls: Array.isArray(pendingToolCalls) ? pendingToolCalls : [],
            toolResults: Array.isArray(toolResults)
              ? toolResults.map((tr) => ({ ...tr, result: compactToolResultPayload(tr.result) }))
              : [],
            lastToolCallSig,
            websiteBuildMode,
            appBuildMode,
            commandPipelineMode,
            batchChangeMode,
            totalWriteSuccesses,
            noWriteRounds,
            pendingBatchVerification,
            backendVerificationSatisfied,
            buildVerified,
            typecheckVerified,
            planMajorSteps,
            planStepIndex,
            planAwaitingApproval,
            autoResumeAttempts: autoResumeAttempts + 1,
            deepseekReasonerPrimed,
            deepseekPlanSummary,
            commandFailureCounts: Object.fromEntries(commandFailureCounts),
            commandBlocked: Array.from(commandBlocked),
            commandFamilyFailureCounts: Object.fromEntries(commandFamilyFailureCounts),
            commandFamilyBlocked: Array.from(commandFamilyBlocked),
            activeWorkFile,
            supportReadFiles,
            consecReadOnlyRounds,
            stagnationRounds,
            allSteps: allSteps.slice(-120),
            allToolCalls: allToolCalls.slice(-120),
          },
        };
        setMessages(prev => [...prev.filter(m => !m._progress), assistantMsg]);
        setConversations(prev => prev.map(c => c.id === activeConvoId ? { ...c, messages: [...c.messages.filter(m => !m._progress), assistantMsg] } : c));

        if (shouldAutoResume) {
          const delayMs = 1200 * (autoResumeAttempts + 1);
          setTimeout(() => {
            handleAgentSubmit(
              { preventDefault: () => {} },
              'Resume automatically from the last stable step. Continue the task without repeating already exhausted upstream retries or re-reading already inspected files.',
              { resumeFromMessageId: msgId }
            );
          }, delayMs);
        }
      } finally {
        setIsTyping(false);
        setAgentRunState(AGENT_RUN_STATES.IDLE);
      }
    })();
  }, [chatInput, chatImage, isTyping, sessionTokens, fileSystem, activeFile, activeAgent, activeModel, activeConvoId, chatMode, pinnedFilePath, executeToolCall, applyToolMutations, conversations, summarizeFileChanges, agentRunState, chatQuietMode]);

  useEffect(() => {
    agentSubmitRef.current = handleAgentSubmit;
  }, [handleAgentSubmit]);

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
  const onTerminalOutput = useCallback((line) => {
    const buf = terminalOutputRef.current;
    buf.push(line);
    if (buf.length > 300) terminalOutputRef.current = buf.slice(-300);

    const detectedDirectUrl = extractDirectPreviewUrl(line);
    if (detectedDirectUrl) {
      setDirectPreviewUrl((prev) => (prev === detectedDirectUrl ? prev : detectedDirectUrl));
    }
  }, []);

  const handleCreateRuntimeTerminal = useCallback(() => {
    runtimeTerminalSeqRef.current += 1;
    const nextId = `runtime-${runtimeTerminalSeqRef.current}`;
    const nextLabel = `Runtime ${runtimeTerminalSeqRef.current}`;
    setRuntimeTerminals((prev) => [...prev, { id: nextId, label: nextLabel }]);
    setActiveRuntimeTerminalId(nextId);
    setTerminalState('open');
    setActiveTerminalTab('runtime');
  }, []);

  const handleCloseRuntimeTerminal = useCallback((terminalId) => {
    setRuntimeTerminals((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((t) => t.id === terminalId);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== terminalId);
      if (activeRuntimeTerminalIdRef.current === terminalId) {
        const fallback = next[Math.max(0, idx - 1)]?.id || next[0]?.id || 'runtime-1';
        setActiveRuntimeTerminalId(fallback);
      }
      return next;
    });
  }, []);

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
      { label: 'Import Backup / Project...', icon: FolderOpen, action: handleImportProject },
      { type: 'separator' },
      { label: 'Save', shortcut: 'Ctrl+S', icon: Save, action: handleSave },
      { label: 'Save As...', shortcut: 'Ctrl+Shift+S', disabled: true },
      { label: 'Save All', shortcut: 'Ctrl+K S', action: handleSave },
      { label: 'Create Snapshot', icon: Save, action: () => handleSaveSnapshot({ manual: true }) },
      { label: 'Restore Latest Snapshot', icon: RotateCcw, action: handleRestoreLatestSnapshot },
      { type: 'separator' },
      { label: 'Export Compressed Backup...', action: handleExportProject },
      { label: 'Deploy Project…', icon: Rocket, action: () => setShowDeployModal(true) },
      { label: 'Manage Connections…', icon: Settings, action: () => setShowConnectionsManager(true) },
      { type: 'separator' },
      { label: 'Close Editor', shortcut: 'Ctrl+W', action: () => setActiveFile(Object.keys(fileSystem)[0] || null) },
    ],
    Edit: [
      { label: 'Undo', shortcut: 'Ctrl+Z', icon: Undo2, action: handleEditorUndo },
      { label: 'Redo', shortcut: 'Ctrl+Y', icon: Redo2, action: handleEditorRedo },
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
      { label: liteModeEnabled ? 'Disable Lite Performance Mode' : 'Enable Lite Performance Mode', action: handleToggleLiteMode },
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
      { label: 'New Runtime Terminal', action: handleCreateRuntimeTerminal },
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
  }), [handleNewFile, handleNewProject, handleImportProject, handleExportProject, handleSave, handleSaveSnapshot, handleRestoreLatestSnapshot, handleTerminalCommand, editorCut, editorCopy, editorPaste, editorSelectAll, handleStartDebug, handleRunBuild, handleRunActiveFile, handleCreateRuntimeTerminal, fileSystem, handleEditorUndo, handleEditorRedo, liteModeEnabled, handleToggleLiteMode]);

  // ═════════════════════════════════════════════════════════════════════════
  //  RENDER
  // ═════════════════════════════════════════════════════════════════════════
  return (
    <div className="app-shell flex flex-col bg-[#0a0412] text-purple-100 font-sans overflow-hidden selection:bg-fuchsia-500/30" style={{ height: '100dvh' }}>

      {isDragging && <div className={`fixed inset-0 z-50 ${isDragging === 'terminal' ? 'cursor-row-resize' : 'cursor-col-resize'}`} style={{ touchAction: 'none' }} />}

      {/* ── Top Bar ───────────────────────────────────────────────────────── */}
      <header className="flex items-end justify-between px-2 sm:px-3 bg-[#15092a] border-b border-fuchsia-500/20 z-20 shrink-0 shadow-[0_4px_20px_rgba(192,38,211,0.05)]" style={{ paddingTop: 'var(--sat)', minHeight: 'calc(44px + var(--sat))', paddingBottom: '6px' }}>
        <div className="flex items-center gap-1.5 sm:gap-2 text-sm">
          <button onClick={() => sm ? setActiveMobileTab(t => t === 'explorer' ? 'editor' : 'explorer') : setSidebarOpen(!sidebarOpen)} aria-label="Toggle Explorer" className="p-2 sm:p-1.5 hover:bg-[#25104a] rounded-md transition-colors text-purple-300">
            <Menu size={18} />
          </button>
          <div className="flex items-center gap-1.5 sm:gap-2 text-fuchsia-50 font-semibold px-1 sm:px-2">
            <Cpu className="text-fuchsia-400 drop-shadow-[0_0_8px_rgba(232,121,249,0.6)]" size={sm ? 16 : 18} />
            <span className="tracking-wide font-bold bg-clip-text text-transparent bg-gradient-to-r from-fuchsia-300 to-purple-300 text-xs sm:text-sm">EpiCodeSpace</span>
          </div>
          {/* Mobile menu trigger */}
          {sm && (
            <button
              onClick={() => { setShowMobileMenu(p => !p); setActiveMobileMenuName(null); }}
              className="ml-1 p-2 hover:bg-[#25104a] rounded-md transition-colors text-purple-300"
              aria-label="Open menu"
              aria-expanded={showMobileMenu}
            >
              <ChevronDown size={16} />
            </button>
          )}
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
          {!isPwaInstalled && (canInstallPwa || isIpad) && (
            <button
              type="button"
              onClick={handleInstallPwa}
              className="px-2 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider border border-cyan-500/30 text-cyan-300/90 hover:bg-cyan-500/10 transition-colors"
              title="Install EpiCodeSpace"
            >
              Install
            </button>
          )}
          {isIpad && (
            <button
              type="button"
              onClick={handleToggleLiteMode}
              className={`px-2 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider border transition-colors ${
                liteModeEnabled
                  ? 'bg-amber-500/15 border-amber-500/40 text-amber-200'
                  : 'border-purple-500/20 text-purple-300/80 hover:bg-[#25104a]'
              }`}
              title="Toggle lightweight editor settings for large iPad projects"
            >
              Lite {liteModeEnabled ? 'On' : 'Off'}
            </button>
          )}
          <button
            onClick={() => sm ? setActiveMobileTab(t => t === 'chat' ? 'editor' : 'chat') : setRightSidebarOpen(!rightSidebarOpen)}
            className={`p-2 sm:p-1.5 rounded-md transition-colors ${(sm ? activeMobileTab === 'chat' : rightSidebarOpen) ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'hover:bg-[#25104a] text-purple-300'}`}
            aria-label="Toggle AI Chat"
          >
            {sm ? <MessageSquare size={18} /> : <Layout size={18} />}
          </button>
        </div>
      </header>

      {/* ── Mobile Menu Sheet ─────────────────────────────────────────────── */}
      {sm && showMobileMenu && (
        <div className="shrink-0 bg-[#15092a] border-b border-fuchsia-500/20 z-30 overflow-y-auto" style={{ maxHeight: '65vh' }}>
          {/* Backdrop tap-to-close */}
          <div className="fixed inset-0 z-[-1]" onClick={() => { setShowMobileMenu(false); setActiveMobileMenuName(null); }} />
          {activeMobileMenuName === null ? (
            /* Top-level menu list */
            <div className="flex flex-col py-1">
              {Object.keys(menuDefinitions).map(menuName => (
                <button
                  key={menuName}
                  onClick={() => setActiveMobileMenuName(menuName)}
                  className="flex items-center justify-between w-full px-4 py-3 text-sm text-purple-200 hover:bg-[#25104a] transition-colors border-b border-fuchsia-500/10 last:border-0"
                >
                  <span className="font-semibold">{menuName}</span>
                  <ChevronRight size={14} className="text-purple-500/50" />
                </button>
              ))}
            </div>
          ) : (
            /* Sub-menu items */
            <div className="flex flex-col py-1">
              <button
                onClick={() => setActiveMobileMenuName(null)}
                className="flex items-center gap-2 w-full px-4 py-3 text-xs text-fuchsia-300 hover:bg-[#25104a] transition-colors border-b border-fuchsia-500/20 font-semibold uppercase tracking-wider"
              >
                <ChevronRight size={13} className="rotate-180" /> {activeMobileMenuName}
              </button>
              {menuDefinitions[activeMobileMenuName].map((item, idx) =>
                item.type === 'separator'
                  ? <div key={idx} className="my-1 border-t border-fuchsia-500/10" />
                  : (
                    <button
                      key={idx}
                      disabled={item.disabled}
                      onClick={() => { if (item.action) item.action(); setShowMobileMenu(false); setActiveMobileMenuName(null); }}
                      className={`w-full flex items-center justify-between px-4 py-3 text-sm transition-colors ${item.disabled ? 'text-purple-500/35 cursor-not-allowed' : 'text-purple-200 hover:bg-[#25104a] cursor-pointer'}`}
                    >
                      <span className="flex items-center gap-3">
                        {item.icon ? <item.icon size={15} className="text-fuchsia-400/70 shrink-0" /> : <span className="w-[15px] shrink-0" />}
                        {item.label}
                      </span>
                      {item.shortcut && <span className="text-[11px] text-purple-500/50 font-mono">{item.shortcut}</span>}
                    </button>
                  )
              )}
            </div>
          )}
        </div>
      )}

      {isIpad && (
        <div className="shrink-0 px-2 py-1.5 bg-[#120825] border-b border-fuchsia-500/20 overflow-x-auto no-scrollbar">
          <div className="flex items-center gap-1.5 min-w-max">
            <button type="button" onClick={handleSave} className="touch-target px-2 rounded-md text-[11px] border border-fuchsia-500/25 text-fuchsia-200 hover:bg-fuchsia-500/10 transition-colors">Save</button>
            <button type="button" onClick={handleEditorUndo} className="touch-target px-2 rounded-md text-[11px] border border-white/10 text-purple-200 hover:bg-white/5 transition-colors">Undo</button>
            <button type="button" onClick={handleEditorRedo} className="touch-target px-2 rounded-md text-[11px] border border-white/10 text-purple-200 hover:bg-white/5 transition-colors">Redo</button>
            <button type="button" onClick={() => { setTerminalState('open'); setActiveTerminalTab('preview'); }} className="touch-target px-2 rounded-md text-[11px] border border-cyan-500/25 text-cyan-200 hover:bg-cyan-500/10 transition-colors">Preview</button>
            <button type="button" onClick={handlePinActiveFile} className="touch-target px-2 rounded-md text-[11px] border border-amber-500/25 text-amber-200 hover:bg-amber-500/10 transition-colors">Pin Rules</button>
          </div>
        </div>
      )}

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
        {(sm ? activeMobileTab === 'explorer' : sidebarOpen) && (
          <>
            <aside className={`${sm ? 'flex-1 relative' : 'absolute md:relative z-10'} h-full bg-[#15092a] border-r border-fuchsia-500/20 flex flex-col shrink-0 panel-transition`} style={sm ? {} : { width: leftWidth }} aria-label="File explorer">
              {!sm && <div className="absolute top-0 -right-[2px] w-1.5 h-full cursor-col-resize drag-handle hover:bg-fuchsia-400/50 active:bg-fuchsia-400 z-20 transition-colors" onMouseDown={(e) => { e.preventDefault(); setIsDragging('left'); }} onTouchStart={(e) => { e.preventDefault(); setIsDragging('left'); }} />}
              <PanelErrorBoundary scope="Explorer">
                <FileExplorer
                  fileSystem={fileSystem}
                  activeFile={activeFile}
                  projectName={projectName}
                  projectRepoUrl={projectRepoUrl}
                  onFileClick={handleFileClick}
                  onCreateFile={handleCreateFileAt}
                  onDeleteFile={handleDeleteFile}
                  onRenameFile={handleRenameFile}
                  onMoveFile={handleMoveFile}
                  onDropFiles={handleExplorerDropFiles}
                  onProjectRename={setProjectName}
                  onProjectRepoUrl={setProjectRepoUrl}
                  onImport={handleImportProject}
                  onExport={handleExportProject}
                  onGitClone={handleGitClone}
                  onNewProjectTemplate={(template) => setNewProjectDialog({ template })}
                />
              </PanelErrorBoundary>
            </aside>
          </>
        )}

        {/* Middle Column */}
        <main className={`${sm && activeMobileTab !== 'editor' && activeMobileTab !== 'terminal' ? 'hidden' : ''} flex-1 flex flex-col min-w-0 bg-[#0a0412]`}>
          <div className={`${sm && activeMobileTab === 'terminal' ? 'hidden' : 'flex-1'} flex flex-col min-h-0`}>
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
                      liteMode={liteModeEnabled}
                    />
                  </Suspense>
                );
              })()}
              </>
              )}
            </div>
          </div>

          {/* Terminal Pane */}
          {(terminalState === 'open' || (sm && activeMobileTab === 'terminal')) && (
            <div className={`border-t border-fuchsia-500/20 bg-[#0a0412] flex flex-col shrink-0 relative ${sm && activeMobileTab === 'terminal' ? 'flex-1' : ''}`} style={sm && activeMobileTab === 'terminal' ? undefined : { height: sm ? Math.min(termHeight, window.innerHeight * 0.4) : Math.min(termHeight, Math.floor(window.innerHeight * 0.65)) }}>
              <div className="absolute top-0 left-0 w-full h-3 sm:h-1.5 -mt-[2px] cursor-row-resize drag-handle hover:bg-fuchsia-400/50 active:bg-fuchsia-400 z-20 transition-colors" onMouseDown={(e) => { e.preventDefault(); setIsDragging('terminal'); }} onTouchStart={(e) => { e.preventDefault(); setIsDragging('terminal'); }} />
              <div role="tablist" aria-label="Panel tabs" className="flex items-center px-2 sm:px-4 pt-2 gap-1 sm:gap-3 shrink-0 overflow-x-auto no-scrollbar">
                {[
                  { id: 'problems', label: 'PROBLEMS', badge: allProblems.length > 0 ? allProblems.length : null },
                  { id: 'output', label: 'OUTPUT' },
                  { id: 'terminal', label: 'TERMINAL' },
                  { id: 'runtime', label: 'RUNTIME', badge: runtimeTerminals.length > 1 ? runtimeTerminals.length : null },
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
                  <button
                    className="p-1 hover:bg-[#25104a] rounded text-purple-400/60 transition-colors"
                    title={activeTerminalTab === 'runtime' ? 'New runtime terminal' : 'New terminal'}
                    onClick={() => {
                      if (activeTerminalTab === 'runtime') {
                        handleCreateRuntimeTerminal();
                      } else {
                        setTerminalState('open');
                        setActiveTerminalTab('terminal');
                      }
                    }}
                  ><Plus size={14} /></button>
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
                      <div className="flex-1 min-w-0">
                        <span className="text-purple-200">{p.msg}</span>
                        <span className="text-purple-500/60 ml-2">{p.file}:{p.line}</span>
                      </div>
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 shrink-0 text-[10px] text-fuchsia-300 hover:text-fuchsia-100 bg-fuchsia-500/15 hover:bg-fuchsia-500/30 border border-fuchsia-500/30 px-1.5 py-0.5 rounded transition-all"
                        onClick={(ev) => { ev.stopPropagation(); handleFileClick(p.file); setChatInput(`Fix this ${p.severity} in \`${p.file}\` (line ${p.line}): "${p.msg}"`); }}
                        title="Fix with AI"
                      >Fix</button>
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
                <div className="flex items-center gap-1 px-2 py-1 border-b border-fuchsia-500/10 bg-[#0f0620] overflow-x-auto no-scrollbar">
                  {runtimeTerminals.map((terminal) => {
                    const isActiveRuntime = activeRuntimeTerminalId === terminal.id;
                    return (
                      <div
                        key={terminal.id}
                        className={`inline-flex items-center rounded border text-[10px] ${isActiveRuntime ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-100' : 'bg-[#1a0b35] border-fuchsia-500/20 text-purple-300 hover:text-purple-100'}`}
                      >
                        <button
                          type="button"
                          onClick={() => setActiveRuntimeTerminalId(terminal.id)}
                          className="px-2 py-1 whitespace-nowrap"
                        >
                          {terminal.label}
                        </button>
                        {runtimeTerminals.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleCloseRuntimeTerminal(terminal.id)}
                            className="px-1.5 py-1 border-l border-current/20 hover:bg-black/20"
                            title={`Close ${terminal.label}`}
                            aria-label={`Close ${terminal.label}`}
                          >
                            <X size={11} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={handleCreateRuntimeTerminal}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-fuchsia-500/25 text-[10px] text-purple-300 hover:text-purple-100 hover:bg-[#25104a]"
                    title="Open another runtime terminal"
                  >
                    <Plus size={11} /> New
                  </button>
                </div>
                <Suspense fallback={<div className="p-3 text-xs text-purple-400/60">Loading runtime…</div>}>
                  {runtimeTerminals.map((terminal) => (
                    <div
                      key={terminal.id}
                      className={`flex-1 min-h-0 ${activeRuntimeTerminalId === terminal.id ? 'flex flex-col' : 'hidden'}`}
                    >
                      <WebContainerTerminal
                        ref={(instance) => {
                          if (instance) wcTermRefs.current.set(terminal.id, instance);
                          else wcTermRefs.current.delete(terminal.id);
                        }}
                        sessionStorageKey={`epicodespace.terminalSessionId.${terminal.id}`}
                        files={fileSystem}
                        sink={{ writeFile, getLatest: () => fileSystem }}
                        onServerUrl={(url) => setPreviewUrl(url)}
                        onOutput={onTerminalOutput}
                      />
                    </div>
                  ))}
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
                  {(() => {
                    const showLive = !!wcServerUrl && (previewRenderMode === 'live' || !previewDoc);
                    const showStatic = !!previewDoc && !showLive;
                    return (
                      <>
                  {/* Preview toolbar */}
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-fuchsia-500/10 bg-[#0f0620] shrink-0">
                    <div className="flex-1 flex items-center gap-2 bg-[#1a0b35] rounded px-3 py-1 text-[11px] text-purple-300/50 border border-fuchsia-500/10 min-w-0">
                      <Globe size={11} className="text-fuchsia-400/60 shrink-0" />
                      <span className="truncate">
                        {showLive
                          ? `Live Preview — ${wcServerUrl}`
                          : previewDoc
                            ? `Preview — ${previewSourcePath || 'index.html'}`
                            : 'No preview source available'}
                      </span>
                    </div>
                    {wcServerUrl && previewDoc && (
                      <div className="flex items-center rounded border border-fuchsia-500/20 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setPreviewRenderMode('static')}
                          className={`px-2 py-1 text-[10px] transition-colors ${previewRenderMode === 'static' ? 'bg-fuchsia-500/20 text-fuchsia-200' : 'text-purple-300/70 hover:bg-white/5'}`}
                          title="Show static/generated HTML preview"
                        >
                          Static
                        </button>
                        <button
                          type="button"
                          onClick={() => setPreviewRenderMode('live')}
                          className={`px-2 py-1 text-[10px] transition-colors border-l border-fuchsia-500/20 ${previewRenderMode === 'live' ? 'bg-fuchsia-500/20 text-fuchsia-200' : 'text-purple-300/70 hover:bg-white/5'}`}
                          title="Show live runtime preview"
                        >
                          Live
                        </button>
                      </div>
                    )}
                    <button
                      onClick={() => setPreviewKey(k => k + 1)}
                      className="p-1.5 hover:bg-[#25104a] rounded text-purple-400/60 hover:text-purple-200 transition-colors"
                      title="Refresh preview (re-inlines CSS + JS)"
                    >
                      <RotateCcw size={13} />
                    </button>
                    <button
                      onClick={() => { setPreviewRenderMode('live'); setTerminalState('open'); setActiveTerminalTab('runtime'); }}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-green-400/70 hover:text-green-300 hover:bg-green-500/10 border border-green-500/20 transition-colors"
                      title="Open Runtime tab to boot WebContainer and run npm run dev"
                    >
                      <Play size={11} /> Runtime
                    </button>
                    <button
                      onClick={openPreviewTab}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-cyan-400/70 hover:text-cyan-300 hover:bg-cyan-500/10 border border-cyan-500/20 transition-colors"
                      title="Open preview in a new browser tab (no server required)"
                    >
                      <ExternalLink size={11} /> Open Tab
                    </button>
                    {directPreviewUrl && (
                      <a
                        href={directPreviewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-amber-300/80 hover:text-amber-200 hover:bg-amber-500/10 border border-amber-500/20 transition-colors"
                        title="Open direct app URL from runtime output"
                      >
                        <ExternalLink size={11} /> Direct Link
                      </a>
                    )}
                  </div>

                  {/* Preview content */}
                  {showLive && !previewLoaded ? (
                    /* Lazy-load gate — don't load the iframe until the user taps.
                       Immediate loading spikes WebContainer WASM memory on Safari
                       and aborts the shell process right after server-ready. */
                    <div className="flex-1 flex flex-col items-center justify-center gap-5 bg-[#080614] p-6">
                      <MonitorPlay size={52} className="text-fuchsia-400/30" />
                      <div className="text-center space-y-1">
                        <div className="text-sm font-semibold text-purple-200">Dev server is running</div>
                        <div className="text-[11px] text-purple-400/60 max-w-xs leading-relaxed">
                          Wait a moment for Next.js to fully settle, then tap Load Preview.
                          Loading too early can abort the shell on Safari.
                        </div>
                      </div>
                      <button
                        onClick={() => setPreviewLoaded(true)}
                        className="flex items-center gap-2 px-5 py-2.5 bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-sm font-medium rounded-lg transition-colors shadow-lg shadow-fuchsia-900/40"
                      >
                        <Play size={14} /> Load Preview
                      </button>
                      <div className="text-[10px] text-purple-500/40 text-center max-w-xs">
                        If the preview shows blank after loading, go back to Runtime tab,
                        tap <strong className="text-purple-400/60">Restart</strong> in the terminal toolbar, then run
                        <code className="mx-1 text-fuchsia-400/60">npm run dev</code> again
                        — SWC is cached so the second start is fast and stable.
                      </div>
                    </div>
                  ) : showLive && previewLoaded ? (
                    <iframe
                      key={`${previewKey}:${wcServerUrl}`}
                      src={wcServerUrl}
                      className="flex-1 w-full border-none"
                      style={{ background: '#fff' }}
                      sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-top-navigation-by-user-activation"
                      referrerPolicy="no-referrer"
                      title="EpiCodeSpace Live Runtime Preview"
                    />
                  ) : showStatic ? (
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
                      </>
                    );
                  })()}
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
        {(sm ? activeMobileTab === 'chat' : rightSidebarOpen) && (
          <>
            <aside className={`${sm ? 'flex-1 relative' : 'relative'} border-l border-fuchsia-500/20 bg-[#15092a] flex flex-col min-h-0 shrink-0 shadow-[-4px_0_20px_rgba(192,38,211,0.03)] panel-transition overflow-hidden`} style={sm ? {} : { width: rightWidth }}>
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
                <button onClick={handlePinActiveFile} className="p-1.5 sm:p-1 hover:text-purple-200 hover:bg-[#25104a] rounded transition-colors" title={activeFile ? `Pin ${activeFile}` : 'Pin active file'}><BookOpen size={14} /></button>
                <button className="p-1.5 sm:p-1 hover:text-purple-200 hover:bg-[#25104a] rounded transition-colors"><Settings size={14} /></button>
                <button className="p-1.5 sm:p-1 hover:text-purple-200 hover:bg-[#25104a] rounded transition-colors" onClick={() => sm ? setActiveMobileTab('editor') : setRightSidebarOpen(false)}><X size={14} /></button>
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

            {/* Pinned Guidance File */}
            {pinnedFilePath && fileSystem[pinnedFilePath] && (
              <div className="shrink-0 border-b border-cyan-500/20 bg-[#0d1322]">
                <div className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-cyan-500/5 transition-colors">
                  <BookOpen size={13} className="text-cyan-300" />
                  <span className="text-[10px] uppercase tracking-wider text-cyan-200 font-semibold">Pinned Guidance</span>
                  <span className="text-[10px] text-cyan-300/70 truncate">{pinnedFilePath}</span>
                  <span className="ml-auto flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => setPinnedFileOpen(v => !v)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-cyan-500/30 text-cyan-200/80 hover:bg-cyan-500/15"
                      title={pinnedFileOpen ? 'Collapse' : 'Expand'}
                    >
                      {pinnedFileOpen ? 'Collapse' : 'Expand'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPinnedFilePath(null)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-cyan-500/30 text-cyan-200/80 hover:bg-cyan-500/15"
                      title="Unpin"
                    >
                      Unpin
                    </button>
                    <ChevronDown size={12} className={`text-cyan-300/70 transition-transform ${pinnedFileOpen ? 'rotate-180' : ''}`} />
                  </span>
                </div>
                {pinnedFileOpen && (
                  <div className="px-3 pb-2">
                    <div className="max-h-44 overflow-auto rounded-md border border-cyan-500/20 bg-[#0a0f1a]">
                      {(fileSystem[pinnedFilePath]?.content || '').split('\n').slice(0, 80).map((line, idx) => (
                        <div key={idx} className="grid grid-cols-[44px_1fr] text-[11px] font-mono leading-relaxed border-b border-cyan-500/5">
                          <span className="select-none text-right pr-2 py-0.5 text-cyan-500/60 border-r border-cyan-500/10">{idx + 1}</span>
                          <span className="py-0.5 px-2 text-cyan-100/85 whitespace-pre-wrap break-words">{line || ' '}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Top Files Changed Bar (GitHub-style) */}
            {pendingChangeSets.length > 0 && (
              <div className="shrink-0 border-b border-fuchsia-500/20 bg-[#120825]">
                <button
                  type="button"
                  onClick={() => setChangesBarOpen(v => !v)}
                  className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-fuchsia-500/5 transition-colors"
                >
                  <GitCommit size={13} className="text-fuchsia-300" />
                  <span className="text-[10px] uppercase tracking-wider text-fuchsia-200 font-semibold">Files Changed</span>
                  {(() => {
                    const totalFiles = pendingChangeSets.reduce((n, s) => n + s.files.length, 0);
                    const totalPlus = pendingChangeSets.reduce((n, s) => n + s.plus, 0);
                    const totalMinus = pendingChangeSets.reduce((n, s) => n + s.minus, 0);
                    return (
                      <span className="text-[10px] text-fuchsia-300/80 normal-case">
                        {totalFiles} file{totalFiles !== 1 ? 's' : ''} changed <span className="text-green-400/80">+{totalPlus}</span> <span className="text-red-400/80">-{totalMinus}</span>
                      </span>
                    );
                  })()}
                  <ChevronDown size={12} className={`ml-auto text-fuchsia-300/70 transition-transform ${changesBarOpen ? 'rotate-180' : ''}`} />
                </button>
                {changesBarOpen && (
                  <div className="px-3 pb-2 space-y-2">
                    {pendingChangeSets.length > 1 && (
                      <select
                        value={selectedChangeMsgId}
                        onChange={(e) => setSelectedChangeMsgId(e.target.value)}
                        className="w-full bg-[#1a0b35] border border-fuchsia-500/20 rounded px-2 py-1 text-[11px] text-purple-100 outline-none"
                      >
                        {pendingChangeSets.map((s, idx) => (
                          <option key={s.id} value={s.id}>
                            Change set {idx + 1} · {s.files.length} file{s.files.length !== 1 ? 's' : ''}
                          </option>
                        ))}
                      </select>
                    )}
                    {(() => {
                      const set = pendingChangeSets.find((s) => s.id === selectedChangeMsgId) || pendingChangeSets[0];
                      if (!set) return null;
                      return (
                        <>
                          <div className="max-h-36 overflow-auto rounded-md border border-fuchsia-500/20 bg-[#0e0620] p-2 space-y-1">
                            {set.files.map((f, fi) => (
                              <div key={`${f.path}-${fi}`} className="flex items-center gap-2 text-[11px] text-purple-200/80">
                                <span className={`shrink-0 ${f.action === 'delete' ? 'text-red-400/80' : f.action === 'create' ? 'text-green-400/80' : 'text-fuchsia-300/80'}`}>
                                  {f.action === 'delete' ? '−' : f.action === 'create' ? '+' : '±'}
                                </span>
                                <span className="truncate flex-1">{f.path}</span>
                                <span className="text-green-400/70">+{f.plus}</span>
                                <span className="text-red-400/70">-{f.minus}</span>
                              </div>
                            ))}
                          </div>
                          <div className="flex justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => handleKeepChangeSet(set.id)}
                              className="px-2 py-0.5 text-[10px] rounded bg-cyan-500/20 text-cyan-200 border border-cyan-500/30 hover:bg-cyan-500/30 transition-colors"
                            >
                              Keep
                            </button>
                            <button
                              type="button"
                              onClick={() => handleUndoChangeSet(set.id)}
                              className="px-2 py-0.5 text-[10px] rounded bg-amber-500/20 text-amber-200 border border-amber-500/30 hover:bg-amber-500/30 transition-colors"
                            >
                              Undo
                            </button>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}

            {sessionChangeTimeline.length > 0 && (
              <div className="shrink-0 border-b border-fuchsia-500/20 bg-[#100720]">
                <button
                  type="button"
                  onClick={() => setTimelineOpen((v) => !v)}
                  className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-fuchsia-500/5 transition-colors"
                >
                  <GitCommit size={13} className="text-cyan-300" />
                  <span className="text-[10px] uppercase tracking-wider text-cyan-200 font-semibold">Session Timeline</span>
                  <span className="text-[10px] text-cyan-300/70 normal-case">{sessionChangeTimeline.length} change set{sessionChangeTimeline.length !== 1 ? 's' : ''}</span>
                  <ChevronDown size={12} className={`ml-auto text-cyan-300/70 transition-transform ${timelineOpen ? 'rotate-180' : ''}`} />
                </button>
                {timelineOpen && (
                  <div className="px-3 pb-2">
                    <div className="max-h-44 overflow-auto rounded-md border border-cyan-500/20 bg-[#0d0520] p-2 space-y-2">
                      {sessionChangeTimeline.map((set) => (
                        <div key={set.id} className="rounded border border-white/10 bg-white/5 p-2">
                          <div className="flex items-center gap-2 text-[10px]">
                            <span className="text-cyan-200">{new Date(set.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            <span className={`px-1.5 py-0.5 rounded uppercase tracking-wide ${set.status === 'pending' ? 'bg-amber-500/20 text-amber-200' : set.status === 'undone' ? 'bg-red-500/20 text-red-200' : 'bg-green-500/20 text-green-200'}`}>
                              {set.status}
                            </span>
                            <span className="ml-auto text-green-300/80">+{set.plus}</span>
                            <span className="text-red-300/80">-{set.minus}</span>
                          </div>
                          <div className="mt-1 text-[11px] text-purple-200/85">
                            {set.files.length} file{set.files.length !== 1 ? 's' : ''}: {set.files.slice(0, 2).map((f) => f.path).join(', ')}{set.files.length > 2 ? '…' : ''}
                          </div>
                          {set.excerpt && <div className="mt-1 text-[10px] text-purple-400/70 line-clamp-2">{set.excerpt}</div>}
                          {set.status === 'pending' && (
                            <div className="mt-1.5 flex justify-end gap-1">
                              <button type="button" onClick={() => handleKeepChangeSet(set.id)} className="px-2 py-0.5 text-[10px] rounded bg-cyan-500/20 text-cyan-100 border border-cyan-500/30 hover:bg-cyan-500/30 transition-colors">Keep</button>
                              <button type="button" onClick={() => handleUndoChangeSet(set.id)} className="px-2 py-0.5 text-[10px] rounded bg-amber-500/20 text-amber-100 border border-amber-500/30 hover:bg-amber-500/30 transition-colors">Undo</button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Chat Messages */}
            <div className="relative flex-1 min-h-0">
            <div
              ref={chatScrollRef}
              onScroll={handleChatScroll}
              onWheelCapture={(e) => e.stopPropagation()}
              onTouchMoveCapture={(e) => e.stopPropagation()}
              className="h-full min-h-0 overflow-y-auto scroll-touch overscroll-contain p-4 space-y-5 font-sans text-[13px] bg-gradient-to-b from-[#15092a] to-[#0a0412]"
              role="log"
              aria-live="polite"
              aria-label="Chat history"
              style={{ touchAction: 'pan-y' }}
            >
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
                    {msg.role === 'assistant' && (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleCopyMessage(msg.content || '', `copy-${i}-${msg.timestamp || 0}`)}
                          className="inline-flex items-center gap-1 rounded-md border border-fuchsia-500/20 bg-fuchsia-500/5 px-1.5 py-0.5 text-[9px] normal-case text-fuchsia-300/80 hover:bg-fuchsia-500/15 hover:text-fuchsia-200 transition-colors"
                          title="Copy response"
                        >
                          <Copy size={9} />
                          {copiedMsgKey === `copy-${i}-${msg.timestamp || 0}` ? 'Copied' : 'Copy'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleQuoteToPrompt(msg.content || '')}
                          className="inline-flex items-center rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] normal-case text-purple-300/80 hover:bg-white/10 hover:text-purple-200 transition-colors"
                          title="Quote into input"
                        >
                          Reply
                        </button>
                      </div>
                    )}
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
                  <div className={`rounded-xl px-4 py-3 ${msg.role === 'user' ? 'bg-[#1f0e40] border border-purple-500/30 text-purple-100 shadow-md' : 'bg-[#100724] border border-fuchsia-500/25 text-purple-100/95 shadow-[0_8px_24px_rgba(0,0,0,0.28)]'} text-[13px]`}>
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
                  {msg.role === 'assistant' && msg.usage && (
                    <div className="text-[9px] text-purple-500/60 px-1">
                      Tokens: {msg.usage.total_tokens ?? ((msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0)) ?? msg.usage.totalTokenCount ?? 'n/a'}
                    </div>
                  )}
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
                  {/* Continue / Done prompt when agent hit round limit */}
                  {msg.role === 'assistant' && msg.canContinue && (
                    <div className="flex items-center gap-2 mt-2 p-2.5 rounded-lg bg-fuchsia-500/8 border border-fuchsia-500/25">
                      <span className="text-[11px] text-purple-300/70 flex-1">Continue where I left off?</span>
                      <button
                        type="button"
                        onClick={() => {
                          setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, canContinue: false } : m));
                          handleAgentSubmit(
                            { preventDefault: () => {} },
                            'Continue from where you left off. Pick up remaining tasks and complete them fully without re-reading already inspected files.',
                            { resumeFromMessageId: msg.id }
                          );
                        }}
                        className="inline-flex items-center gap-1.5 rounded-md bg-fuchsia-600/80 hover:bg-fuchsia-500 px-3 py-1.5 text-[11px] font-semibold text-white transition-colors shadow"
                      >
                        ▶ Continue
                      </button>
                      <button
                        type="button"
                        onClick={() => setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, canContinue: false } : m))}
                        className="inline-flex items-center gap-1.5 rounded-md border border-purple-500/30 bg-purple-500/10 hover:bg-purple-500/20 px-3 py-1.5 text-[11px] text-purple-300 transition-colors"
                      >
                        ✓ Done
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {isTyping && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-purple-400/80 text-[11px] font-semibold uppercase tracking-wider">
                    <Sparkles size={12} className={`${AGENT_REGISTRY[activeAgent]?.color || 'text-fuchsia-400'} animate-pulse`} /> {AGENT_REGISTRY[activeAgent]?.name}
                  </div>
                  {/* Live status block — optionally expand details in quiet mode */}
                  {(() => {
                    const progressMsg = messages.find(m => m._progress && m.agent === activeAgent);
                    const liveSteps = progressMsg?.steps || [];
                    const liveCalls = progressMsg?.toolCalls || [];
                    const hasLiveDetails = liveSteps.length > 0 || liveCalls.length > 0;
                    if (!hasLiveDetails) {
                      return (
                        <div className="bg-transparent border border-fuchsia-500/20 text-purple-400 rounded-xl px-4 py-2.5 flex items-center gap-2 w-fit">
                          <Loader2 size={13} className={`animate-spin ${AGENT_REGISTRY[activeAgent]?.color || 'text-fuchsia-400'}`} />
                          <span className="text-[11px] font-semibold uppercase tracking-wider">Thinking...</span>
                        </div>
                      );
                    }
                    if (chatQuietMode && !showLiveProgressDetails) {
                      return (
                        <div className="bg-transparent border border-fuchsia-500/20 text-purple-300 rounded-xl px-4 py-2.5 flex items-center gap-2 w-fit">
                          <Loader2 size={13} className={`animate-spin ${AGENT_REGISTRY[activeAgent]?.color || 'text-fuchsia-400'}`} />
                          <span className="text-[11px] font-semibold">Working quietly</span>
                          <span className="text-[10px] text-purple-500/80">{liveCalls.length} calls · {liveSteps.length} steps</span>
                        </div>
                      );
                    }
                    return <ThinkingBlock steps={liveSteps} toolCalls={liveCalls} inProgress mode={chatMode} />;
                  })()}
                  {/* Stop / Steer controls */}
                  <div className="flex items-center gap-1 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setShowLiveProgressDetails((v) => !v)}
                      className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/25 hover:text-purple-100 transition-colors"
                    >
                      {showLiveProgressDetails ? <EyeOff size={10} /> : <Eye size={10} />}
                      {showLiveProgressDetails ? 'Hide live log' : 'Show live log'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setChatQuietMode((v) => !v)}
                      className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/25 hover:text-purple-100 transition-colors"
                    >
                      {chatQuietMode ? 'Quiet mode on' : 'Quiet mode off'}
                    </button>
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
            {!isNearBottom && (
              <button
                type="button"
                onClick={() => {
                  chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
                  setIsNearBottom(true);
                }}
                className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full border border-fuchsia-500/30 bg-[#120825]/95 px-3 py-1.5 text-[10px] font-semibold text-fuchsia-200 shadow-[0_8px_20px_rgba(0,0,0,0.45)] hover:bg-[#1a0b35] transition-colors"
              >
                <ChevronDown size={12} /> Latest
              </button>
            )}
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
              {sessionTokens >= tokenCeiling && !chatQuietMode && activeAgent !== 'deepseek' && (
                <div className="mb-2 flex items-center gap-2 rounded-lg bg-amber-900/20 border border-amber-500/30 px-3 py-2 text-amber-300 text-[11px]">
                  <span className="text-base leading-none">⚠️</span>
                  <span>
                    Warning only: high token usage (~{Math.round(sessionTokens / 1000)}k used of ~{Math.round(tokenCeiling / 1000)}k budget). Consider summarizing or{' '}
                    <button type="button" className="underline hover:text-amber-100 transition-colors" onClick={handleNewConversation}>starting a new context</button> soon.
                    You can keep sending messages; this does not hard-stop the agent.
                  </span>
                </div>
              )}
              {/* Quick-action chips */}
              {!isTyping && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {[
                    { label: '🔴 Fix errors', cmd: '/fix' },
                    { label: '🐛 Debug', cmd: '/debug' },
                    { label: '💡 Explain', cmd: '/explain' },
                    { label: '🧪 Write tests', cmd: '/test' },
                    { label: '📝 Document', cmd: '/doc' },
                    { label: '🔄 Refactor', cmd: '/refactor' },
                    { label: '🔀 Commit msg', cmd: '/commit' },
                    { label: '👁 Review', cmd: '/review' },
                  ].map(({ label, cmd }) => (
                    <button
                      key={cmd}
                      type="button"
                      onClick={() => { setChatInput(cmd); }}
                      className="text-[10px] px-2 py-0.5 rounded-full bg-fuchsia-500/10 border border-fuchsia-500/20 text-purple-300/70 hover:bg-fuchsia-500/25 hover:text-fuchsia-200 hover:border-fuchsia-400/40 transition-all"
                    >{label}</button>
                  ))}
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
                    className="w-full bg-transparent p-3 text-[13px] text-purple-100 outline-none placeholder:text-purple-400/40 resize-none min-h-[80px]"
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
                      disabled={(!chatInput.trim() && !chatImage) || isTyping}
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

      {/* ── Mobile Bottom Navigation ──────────────────────────────────────── */}
      {sm && (
        <nav
          aria-label="Mobile panels"
          className="sm:hidden flex items-stretch bg-[#15092a] border-t border-fuchsia-500/20 z-30 shrink-0"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
          {[
            { id: 'explorer', icon: Folder,        label: 'Explorer' },
            { id: 'editor',   icon: Code2,          label: 'Editor'   },
            { id: 'terminal', icon: Terminal,        label: 'Terminal' },
            { id: 'chat',     icon: MessageSquare,   label: 'Chat'     },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveMobileTab(tab.id)}
              aria-current={activeMobileTab === tab.id ? 'page' : undefined}
              className={`flex-1 flex flex-col items-center justify-center gap-1 py-2.5 text-[10px] font-semibold tracking-wide transition-colors border-t-2 ${
                activeMobileTab === tab.id
                  ? 'text-fuchsia-300 bg-fuchsia-500/10 border-t-fuchsia-400'
                  : 'text-purple-400/55 hover:text-purple-200 border-t-transparent'
              }`}
            >
              <tab.icon size={20} />
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
      )}

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

      {/* Deploy Modal */}
      {showDeployModal && (
        <DeployModal
          projectName={projectName}
          fileSystem={fileSystem}
          onClose={() => setShowDeployModal(false)}
          connections={deployConnections}
          onManageConnections={() => { setShowDeployModal(false); setShowConnectionsManager(true); }}
        />
      )}

      {/* Connections Manager */}
      {showConnectionsManager && (
        <ConnectionsManager
          connections={deployConnections}
          onChange={(next) => { saveConnections(next); setDeployConnections(next); }}
          onClose={() => setShowConnectionsManager(false)}
          fileSystem={fileSystem}
          projectName={projectName}
          projectRepoUrl={projectRepoUrl}
          onGistPull={(result) => {
            if (result?.files) {
              replaceAll(result.files);
              if (result.projectName) setProjectName(result.projectName);
              if (result.repoUrl !== undefined) setProjectRepoUrl(result.repoUrl || '');
              setShowConnectionsManager(false);
            }
          }}
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
      <footer className="hidden sm:flex items-start justify-between px-1 sm:px-2 bg-[#15092a] border-t border-fuchsia-500/30 text-[10px] sm:text-[11px] text-purple-300 z-20 shrink-0 overflow-x-auto no-scrollbar" style={{ paddingTop: '4px', paddingBottom: 'var(--sab)', minHeight: 'calc(24px + var(--sab))' }}>
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
          {/* Gist Sync status badge */}
          {gistSyncStatus !== 'idle' && (
            <button
              type="button"
              onClick={() => setShowConnectionsManager(true)}
              title={gistSyncStatus === 'syncing' ? 'Syncing to Gist…' : gistSyncStatus === 'ok' ? 'Synced to Gist' : 'Gist sync error — click to configure'}
              className={`px-2 h-full flex items-center gap-1 border-l border-fuchsia-500/10 transition-colors hover:bg-[#25104a] ${
                gistSyncStatus === 'error' ? 'text-red-400' : gistSyncStatus === 'syncing' ? 'text-fuchsia-300' : 'text-emerald-400'
              }`}
            >
              {gistSyncStatus === 'syncing'
                ? <><Loader2 size={11} className="animate-spin" /><span className="hidden sm:inline text-[10px]">Syncing…</span></>
                : gistSyncStatus === 'ok'
                  ? <><Cloud size={11} /><span className="hidden sm:inline text-[10px]">Synced</span></>
                  : <><CloudOff size={11} /><span className="hidden sm:inline text-[10px]">Sync error</span></>}
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowStorageMonitor((p) => !p)}
            className={`px-2 h-full flex items-center gap-1 border-l border-fuchsia-500/10 transition-colors hover:bg-[#25104a] ${storageMonitor.percent >= 90 ? 'text-red-300' : storageMonitor.percent >= 80 ? 'text-amber-300' : 'text-purple-300'}`}
            title={`Storage monitor (${storageMonitor.source})`}
          >
            <Save size={11} />
            <span className="hidden sm:inline">Storage {storageMonitor.percent || 0}%</span>
          </button>
          <div className="hidden lg:flex px-2 h-full items-center hover:bg-[#25104a] cursor-pointer transition-colors">Layout: U.S.</div>
          <div className={`px-2 h-full flex items-center border-l border-fuchsia-500/10 ${AGENT_REGISTRY[activeAgent]?.color || 'text-fuchsia-400'}`}>⚡ <span className="hidden sm:inline ml-1">{AGENT_REGISTRY[activeAgent]?.name || 'Agent'}</span></div>
        </div>
      </footer>

      {showStorageMonitor && (
        <div className="fixed bottom-8 right-3 z-[80] w-72 bg-[#15092a] border border-fuchsia-500/30 rounded-lg shadow-[0_12px_28px_rgba(0,0,0,0.55)] p-3 text-xs">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-fuchsia-200">Storage Monitor</span>
            <button type="button" onClick={() => setShowStorageMonitor(false)} className="text-purple-400/70 hover:text-fuchsia-300 transition-colors"><X size={13} /></button>
          </div>
          <div className="space-y-1 text-purple-300/80">
            <div>Usage: {(storageMonitor.usage / 1024 / 1024).toFixed(2)} MB</div>
            <div>Quota: {storageMonitor.quota > 0 ? `${(storageMonitor.quota / 1024 / 1024).toFixed(2)} MB` : 'Unknown'}</div>
            <div>Source: {storageMonitor.source === 'opfs' ? 'OPFS' : 'Browser estimate'}</div>
            <div>localStorage: {(storageMonitor.localBytes / 1024 / 1024).toFixed(2)} MB</div>
            <div>Snapshots: {storageMonitor.snapshotCount}</div>
            {storageMonitor.reserved > 0 && <div>Reserved headroom: {(storageMonitor.reserved / 1024 / 1024).toFixed(2)} MB</div>}
          </div>
          <div className="mt-2 h-2 rounded bg-[#0a0412] border border-fuchsia-500/15 overflow-hidden">
            <div
              className={`${storageMonitor.percent >= 90 ? 'bg-red-500/80' : storageMonitor.percent >= 80 ? 'bg-amber-500/80' : 'bg-cyan-500/80'} h-full transition-all`}
              style={{ width: `${Math.max(4, Math.min(100, storageMonitor.percent || 0))}%` }}
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => void refreshStorageMonitor()} className="px-2 py-1 rounded bg-white/5 border border-white/10 text-purple-200 hover:bg-white/10 transition-colors">Refresh</button>
            <button type="button" onClick={handlePruneSnapshots} className="px-2 py-1 rounded bg-white/5 border border-white/10 text-purple-200 hover:bg-white/10 transition-colors">Prune old snapshots</button>
            <button type="button" onClick={handleClearSnapshots} className="col-span-2 px-2 py-1 rounded bg-red-500/10 border border-red-500/30 text-red-200 hover:bg-red-500/20 transition-colors">Clear all snapshots</button>
          </div>
          <div className="mt-2 text-[10px] text-purple-500/70">Updated {storageMonitor.lastUpdated ? new Date(storageMonitor.lastUpdated).toLocaleTimeString() : 'just now'}</div>
        </div>
      )}
    </div>
  );
}

/* ─── Wrapped Export with Error Boundary ─────────────────────────────────── */
function EpiCodeSpaceWithBoundary() {
  return <ErrorBoundary><EpiCodeSpaceApp /></ErrorBoundary>;
}

export default EpiCodeSpaceWithBoundary;
