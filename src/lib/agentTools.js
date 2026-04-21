import { AGENT_REGISTRY } from './agentRegistry.js';

// ─── Agent Tools (function calling) ──────────────────────────────────────────
/**
 * Build the in-browser tool implementations for a given workspace snapshot.
 *
 * @param {import('../types').FileSystem} fileSystem
 * @param {string} activeFile
 */
export function createAgentTools(fileSystem, activeFile) {
  return {
    readFile: {
      name: 'readFile',
      description: 'Read file contents',
      execute: (path) => {
        const f = fileSystem[path];
        return f
          ? { ok: true, content: f.content, language: f.language }
          : { ok: false, error: `File '${path}' not found` };
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
          f.content.split('\n').forEach((line, i) => {
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
        const lines = f.content.split('\n');
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
          if (/\.then\(|\.catch\(|new Promise/.test(t) && !/await/.test(t) && /async/.test(lines.slice(Math.max(0, i - 5), i).join('')))
            issues.push({ line: n, type: 'info', category: 'async', msg: '.then()/.catch() inside async fn — consider await instead' });
          if (/async\s+\w+.*=>/.test(t) && !/catch|try/.test(lines.slice(i, i + 10).join('')))
            issues.push({ line: n, type: 'warning', category: 'async', msg: 'Async arrow fn without error handling (try/catch)' });
          if (/await\s+\w+/.test(t) && !/try/.test(lines.slice(Math.max(0, i - 3), i).join('')) && !/\.catch/.test(lines.slice(i, i + 3).join('')))
            issues.push({ line: n, type: 'info', category: 'async', msg: 'await without surrounding try/catch' });
          if (/Promise\.all\(/.test(t) && !/catch|try/.test(lines.slice(i, i + 5).join('')))
            issues.push({ line: n, type: 'warning', category: 'async', msg: 'Promise.all() without .catch() — one rejection will silently swallow others' });

          // ── React-specific ────────────────────────────────────────
          if (/useEffect\s*\(/.test(t) && !/\[\s*\]/.test(lines.slice(i, i + 6).join('')))
            issues.push({ line: n, type: 'warning', category: 'react', msg: 'useEffect with no dependency array — runs on every render' });
          if (/setState.*setState/.test(t) || (/set[A-Z]\w+\(/.test(t) && (t.match(/set[A-Z]\w+\(/g) || []).length > 1))
            issues.push({ line: n, type: 'info', category: 'react', msg: 'Multiple setState calls on one line — consider batching' });
          if (/\.map\([^)]+\)(?!\s*\.\w)/.test(t) && !/key=/.test(lines.slice(i, i + 3).join('')))
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

        // ── Stack trace / error paste detector ──────────────────────
        const content = f.content;
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

        const byCategory = issues.reduce((acc, issue) => {
          (acc[issue.category] = acc[issue.category] || []).push(issue);
          return acc;
        }, {});

        return {
          ok: true,
          file: path || activeFile,
          language: lang,
          lines: lines.length,
          chars: content.length,
          issueCount: issues.length,
          issues,
          summary:
            Object.entries(byCategory)
              .map(([cat, arr]) => `${cat}: ${arr.length}`)
              .join(', ') || 'No issues',
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
          path: p,
          language: f.language,
          lines: f.content.split('\n').length,
        })),
      }),
    },
  };
}

// ─── Offline / Simulated Agent Response Engine ────────────────────────────────
/**
 * Produces a simulated agent response when the real API is unavailable.
 * Uses intent detection + local tool execution against the virtual FS.
 *
 * @param {string} agentId
 * @param {string} query
 * @param {ReturnType<typeof createAgentTools>} tools
 * @param {import('../types').FileSystem} fileSystem
 * @param {string} activeFile
 */
export function buildAgentResponse(agentId, query, tools, fileSystem, activeFile) {
  const q = query.toLowerCase();
  const ctx = tools.getContext.execute();
  const activeContent = fileSystem[activeFile]?.content || '';
  const activeLines = activeContent.split('\n').length;

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

  const toolCalls = [];
  const steps = [];

  if (intents.search) {
    const words = q
      .split(/\s+/)
      .filter((w) => w.length > 3 && !['find', 'search', 'where', 'which', 'file', 'locate', 'does', 'the'].includes(w));
    const pattern = words[words.length - 1] || 'function';
    const result = tools.searchCode.execute(pattern);
    toolCalls.push({ tool: 'searchCode', args: pattern, result });
    if (result.matches > 0) {
      steps.push(`🔍 **searchCode**("${pattern}") → ${result.matches} match(es)`);
      const matchList = result.results
        .slice(0, 8)
        .map((r) => `  \`${r.file}:${r.line}\` → ${r.text}`)
        .join('\n');
      return {
        steps,
        toolCalls,
        response: `Found **${result.matches}** occurrences of "${pattern}":\n\n${matchList}${result.matches > 8 ? `\n  _...and ${result.matches - 8} more_` : ''}`,
      };
    }
    steps.push(`🔍 **searchCode**("${pattern}") → 0 matches`);
    return { steps, toolCalls, response: `No matches for "${pattern}" across ${ctx.totalFiles} files.` };
  }

  if (intents.review || intents.debug) {
    const analysis = tools.analyzeFile.execute(activeFile);
    toolCalls.push({ tool: 'analyzeFile', args: activeFile, result: analysis });
    steps.push(
      `🔬 **analyzeFile**(${activeFile}) → ${analysis.issueCount ?? analysis.issues?.length ?? 0} issue(s) [${analysis.summary || ''}]`
    );
    if (analysis.ok && analysis.issues?.length > 0) {
      const categoryIcon = { quality: '🔧', async: '⚡', react: '⚛️', safety: '🛡️', security: '🔒', perf: '🚀', runtime: '💥', debug: '🐛' };
      const issueList = analysis.issues
        .slice(0, 15)
        .map(
          (i) =>
            `  ${i.type === 'error' ? '🔴' : i.type === 'warning' ? '🟡' : 'ℹ️'} ${categoryIcon[i.category] || ''} Line ${i.line}: ${i.msg}`
        )
        .join('\n');
      const extras = analysis.issues.length > 15 ? `\n  _...and ${analysis.issues.length - 15} more_` : '';
      const advice =
        agentId === 'claude'
          ? `\n\n**Recommendation:** Address 🔴 errors first (security, runtime, debugger). Then 🟡 warnings.`
          : agentId === 'copilot'
          ? `\n\n**Quick fix available.** I can auto-fix ${analysis.issues.filter((i) => i.type === 'warning').length} warning(s) and ${analysis.issues.filter((i) => i.type === 'error').length} error(s). Want me to apply?`
          : agentId === 'deepseek'
          ? `\n\n**Auto-fix ready:** \`var→const\`, \`==→===\`, add optional chaining, wrap awaits in try/catch, strip console statements. Confirm to proceed.`
          : `\n\nI can fix these automatically or walk you through each one. What would you prefer?`;
      return {
        steps,
        toolCalls,
        response: `**Debug Analysis:** \`${activeFile}\` (${analysis.lines} lines, ${analysis.language})\n**Summary:** ${analysis.summary}\n\n${issueList}${extras}${advice}`,
      };
    }
    steps.push(`✅ No issues found in \`${activeFile}\``);
  }

  if (intents.explain) {
    toolCalls.push({ tool: 'readFile', args: activeFile, result: { ok: true, lines: activeLines } });
    steps.push(`📖 **readFile**(${activeFile}) → ${activeLines} lines`);
    const lang = fileSystem[activeFile]?.language || 'text';
    const explanations = {
      'epicode-agent': `**\`${activeFile}\`** (${lang}, ${activeLines} lines)\n\nThis file ${
        lang === 'markdown'
          ? 'documents project configuration and business logic.'
          : lang === 'css'
          ? 'defines the base styles using Tailwind CSS directives and custom properties.'
          : `defines a ${lang === 'typescript' ? 'TypeScript' : 'JavaScript'} module. It exports ${activeContent.includes('export default') ? 'a default component/function' : 'named exports'} and contains ${activeLines} lines of logic.`
      }\n\nWant me to break down any specific section?`,
      copilot: `Here's a breakdown of \`${activeFile}\`:\n\n• **Language:** ${lang}\n• **Lines:** ${activeLines}\n• **Exports:** ${activeContent.match(/export/g)?.length || 0}\n• **Imports:** ${activeContent.match(/import/g)?.length || 0}\n\nI can generate inline comments or a JSDoc summary. Just say the word.`,
      claude: `Let me walk through \`${activeFile}\` systematically.\n\n**Structure:** ${activeLines} lines of ${lang}.\n\n**Key observation:** ${activeContent.length > 2000 ? 'This file is fairly large — consider breaking it into smaller modules if complexity grows.' : 'File size is manageable. Good modularity.'}\n\nWould you like me to analyze the control flow or data dependencies?`,
      gemini: `**Analysis of \`${activeFile}\`:**\n\n📊 **Metrics:** ${activeLines} lines | ${activeContent.length} chars | ${lang}\n\nThis file ${activeContent.includes('React') ? 'is a React component' : activeContent.includes('function') ? 'contains utility functions' : 'holds configuration data'}.`,
      deepseek: `\`\`\`analysis\nFile: ${activeFile}\nLang: ${lang}\nLines: ${activeLines}\nSize: ${activeContent.length} bytes\nImports: ${(activeContent.match(/import/g) || []).length}\nExports: ${(activeContent.match(/export/g) || []).length}\n\`\`\`\n\nShall I generate type annotations or refactor suggestions?`,
    };
    return { steps, toolCalls, response: explanations[agentId] || explanations['epicode-agent'] };
  }

  if (intents.generate || intents.test) {
    const ctxResult = tools.getContext.execute();
    toolCalls.push({ tool: 'getContext', result: ctxResult });
    steps.push(`📋 **getContext**() → ${ctxResult.totalFiles} files`);
    if (intents.test) {
      const testCode = `import { describe, it, expect } from 'vitest';\n\ndescribe('${activeFile}', () => {\n  it('should exist and be importable', () => {\n    expect(true).toBe(true);\n  });\n});\n`;
      return {
        steps,
        toolCalls,
        response: `Here's a test scaffold for \`${activeFile}\`:\n\n\`\`\`javascript\n${testCode}\`\`\`\n\nWant me to write this to \`${activeFile.replace(/\.(jsx?|tsx?)$/, '.test$&')}\`?`,
      };
    }
    const nameMatch = q.match(/(?:create|make|build|add|write)\s+(?:a\s+)?(\w+)/i)?.[1] || 'newModule';
    return {
      steps,
      toolCalls,
      response: `Based on your workspace (${ctxResult.totalFiles} files), here's a scaffold:\n\n\`\`\`javascript\nexport function ${nameMatch}() {\n  // TODO: Implement\n  return null;\n}\n\`\`\`\n\nShall I expand this with full implementation?`,
    };
  }

  if (intents.refactor) {
    const analysis = tools.analyzeFile.execute(activeFile);
    toolCalls.push({ tool: 'analyzeFile', args: activeFile, result: analysis });
    steps.push(`🔬 **analyzeFile**(${activeFile}) → ${analysis.lines} lines, ${analysis.issues?.length || 0} issues`);
    return {
      steps,
      toolCalls,
      response: `**Refactoring plan for \`${activeFile}\`:**\n\n1. ${analysis.issues?.some((i) => i.msg.includes('var')) ? '✅ Convert `var` → `const`/`let`' : '◻️ Variables already use modern declarations'}\n2. ${analysis.issues?.some((i) => i.msg.includes('equality')) ? '✅ Fix loose equality `==` → `===`' : '◻️ Strict equality in use'}\n3. ${analysis.issues?.some((i) => i.msg.includes('Console')) ? '✅ Remove console statements' : '◻️ No console statements'}\n4. ${analysis.lines > 100 ? '✅ Consider extracting functions (file is ' + analysis.lines + ' lines)' : '◻️ File length is fine'}\n\nWant me to apply these changes now?`,
    };
  }

  if (intents.architecture) {
    const ctxResult = tools.getContext.execute();
    toolCalls.push({ tool: 'getContext', result: ctxResult });
    steps.push(`📋 **getContext**() → ${ctxResult.totalFiles} files`);
    const fileBreakdown = ctxResult.files.map((f) => `  \`${f.path}\` (${f.language}, ${f.lines} lines)`).join('\n');
    return {
      steps,
      toolCalls,
      response: `**Workspace Architecture Overview:**\n\n📁 **${ctxResult.totalFiles} files:**\n${fileBreakdown}\n\n**Observations:**\n• ${ctxResult.files.some((f) => f.language === 'typescript') ? 'TypeScript is in use — good for type safety' : 'Consider adding TypeScript for better DX'}\n• Total codebase: ~${ctxResult.files.reduce((a, f) => a + f.lines, 0)} lines\n\nWant me to suggest a restructuring plan?`,
    };
  }

  // Fallback
  const ctxResult = tools.getContext.execute();
  toolCalls.push({ tool: 'getContext', result: ctxResult });
  steps.push(`📋 **getContext**() → ${ctxResult.totalFiles} files, active: ${activeFile}`);
  return {
    steps,
    toolCalls,
    response: `I've reviewed your workspace (${ctxResult.totalFiles} files, active: \`${activeFile}\`). Regarding "${query}":\n\nI can help with that. Want me to start with a specific file, or work across the whole project?`,
  };
}
