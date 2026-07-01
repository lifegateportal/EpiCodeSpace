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
      execute: (path, startLine, endLine, maxChars = 60000) => {
        const f = fileSystem[path];
        if (!f) return { ok: false, error: `File '${path}' not found` };
        const safe = f.content ?? '';
        const lines = safe.split('\n');
        const totalLines = lines.length;
        const hasRange = Number.isFinite(startLine) || Number.isFinite(endLine);
        const s = hasRange ? Math.max(1, Math.min(parseInt(startLine, 10) || 1, totalLines)) : 1;
        const e = hasRange ? Math.max(s, Math.min(parseInt(endLine, 10) || totalLines, totalLines)) : totalLines;
        const chunk = lines.slice(s - 1, e).join('\n');
        const cap = Math.max(1000, Math.min(parseInt(maxChars, 10) || 60000, 200000));
        const limited = chunk.length > cap ? `${chunk.slice(0, cap)}\n... [truncated ${chunk.length - cap} chars]` : chunk;
        return {
          ok: true,
          content: limited,
          language: f.language,
          lines: totalLines,
          startLine: s,
          endLine: e,
          truncated: chunk.length > cap,
        };
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
          lines: (f.content ?? '').split('\n').length,
        })),
      }),
    },
    getTerminalOutput: {
      name: 'getTerminalOutput',
      description: 'Read recent terminal output',
      execute: () => ({ ok: true, lines: 0, output: '', note: 'Terminal output is only available in the live runtime.' }),
    },
    autoFix: {
      name: 'autoFix',
      description: 'Auto-fix common code issues',
      execute: (path) => {
        const f = fileSystem[path || activeFile];
        if (!f) return { ok: false, error: 'File not found' };
        const tools2 = createAgentTools(fileSystem, path || activeFile);
        const analysis = tools2.analyzeFile.execute(path || activeFile);
        if (!analysis.ok || analysis.issues.length === 0) return { ok: true, fixed: 0, message: 'No auto-fixable issues found.' };
        let lines = (f.content || '').split('\n');
        const applied = [];
        lines = lines.map((line, idx) => {
          let l = line;
          analysis.issues.filter(iss => iss.line === idx + 1).forEach(iss => {
            if (iss.msg.includes('var declaration')) { l = l.replace(/\bvar\b/g, 'const'); applied.push({ line: idx + 1, fix: 'var → const' }); }
            if (iss.msg.includes('Loose equality')) { l = l.replace(/([^!<>=])={2}(?!=)/g, '$1==='); applied.push({ line: idx + 1, fix: '== → ===' }); }
            if (iss.msg.includes('debugger')) { applied.push({ line: idx + 1, fix: 'removed debugger' }); l = null; }
          });
          return l;
        }).filter(l => l !== null);
        return { ok: true, fixed: applied.length, applied, message: `Fixed ${applied.length} issue(s).` };
      },
    },
    explainError: {
      name: 'explainError',
      description: 'Explain an error message',
      execute: (errorText) => {
        if (!errorText) return { ok: false, error: 'error text required' };
        const typeMatch = errorText.match(/(TypeError|ReferenceError|SyntaxError|RangeError|Error):\s*(.+)/);
        const lineMatch = errorText.match(/:(\d+):\d+/);
        const errorType = typeMatch?.[1] || 'Error';
        const errorMessage = (typeMatch?.[2] || errorText).slice(0, 100);
        let cause = 'Unknown error — check the stack trace.', fix = 'Inspect the indicated file and line.';
        if (/Cannot find module/.test(errorText)) { cause = 'Missing import/module.'; fix = 'Run npm install or fix the import path.'; }
        else if (/null|undefined/.test(errorMessage) && errorType === 'TypeError') { cause = 'Property accessed on null/undefined.'; fix = 'Add a null check or use optional chaining (?.)'; }
        else if (errorType === 'ReferenceError') { cause = 'Variable not declared/imported.'; fix = 'Check imports and variable scope.'; }
        else if (errorType === 'SyntaxError') { cause = 'Syntax error.'; fix = `Check around line ${lineMatch?.[1] || '?'} for missing brackets/commas.`; }
        return { ok: true, errorType, errorMessage, line: lineMatch?.[1] ? parseInt(lineMatch[1]) : null, cause, fix };
      },
    },
    getGitStatus: {
      name: 'getGitStatus',
      description: 'Get git status',
      execute: () => {
        const files = Object.keys(fileSystem);
        return { ok: true, branch: 'main', modifiedFiles: files.slice(0, 5), totalFiles: files.length, note: 'Simulated — run git status in the terminal for real output.' };
      },
    },
    createComponent: {
      name: 'createComponent',
      description: 'Scaffold a new component',
      execute: (name, type = 'react') => {
        if (!name) return { ok: false, error: 'name required' };
        const pascal = name.charAt(0).toUpperCase() + name.slice(1);
        const content = `import React from 'react';\n\nexport default function ${pascal}(props) {\n  return (\n    <div>\n      <h2>${pascal}</h2>\n    </div>\n  );\n}\n`;
        return { ok: true, action: 'write', path: `src/components/${pascal}.jsx`, content, lines: content.split('\n').length };
      },
    },
    diagnoseProject: {
      name: 'diagnoseProject',
      description: 'Diagnose common project setup issues: missing node_modules, broken CSS/styling, missing Tailwind config, missing CSS imports',
      execute: () => {
        const files = Object.keys(fileSystem);
        const issues = [];
        const info = [];
        let pkg = {};
        let allDeps = {};
        let detectedPm = 'npm';
        let installCmd = 'npm install --include=dev';
        let devCmd = 'npm run dev';

        const pkgFile = fileSystem['package.json'];
        if (!pkgFile) {
          issues.push({ severity: 'error', category: 'setup', msg: 'No package.json found' });
        } else {
          try { pkg = JSON.parse(pkgFile.content || '{}'); } catch { /* ignore */ }
          allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          info.push(`package.json: ${pkg.name || 'unnamed'}`);
          if (pkg.scripts?.dev)   info.push(`dev script: "${pkg.scripts.dev}"`);
          if (pkg.scripts?.start) info.push(`start script: "${pkg.scripts.start}"`);

          const pmField = String(pkg.packageManager || '').toLowerCase();
          const hasPnpmLock = !!fileSystem['pnpm-lock.yaml'];
          const hasYarnLock = !!fileSystem['yarn.lock'];
          const hasBunLock = !!fileSystem['bun.lockb'];
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

          const cssFrameworks = ['tailwindcss', 'bootstrap', '@mui/material', 'antd', '@chakra-ui/react', 'styled-components', '@emotion/react', 'daisyui'];
          const usedFrameworks = cssFrameworks.filter(f => allDeps[f]);
          if (usedFrameworks.length) info.push(`CSS/UI frameworks: ${usedFrameworks.join(', ')}`);

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

          if (allDeps['tailwindcss']) {
            const hasTwConfig   = files.some(f => /^tailwind\.config\.(js|ts|cjs|mjs)$/.test(f));
            const hasPostCSSCfg = files.some(f => /^postcss\.config\.(js|ts|cjs|mjs)$/.test(f));
            if (!hasTwConfig)    issues.push({ severity: 'error', category: 'css', msg: 'tailwindcss in deps but no tailwind.config.js' });
            if (!hasPostCSSCfg)  issues.push({ severity: 'error', category: 'css', msg: 'tailwindcss requires postcss.config.js' });
            const hasTwDirective = files.some(f => f.endsWith('.css') && (fileSystem[f]?.content || '').includes('@tailwind'));
            if (!hasTwDirective) issues.push({ severity: 'error', category: 'css', msg: 'No CSS file has @tailwind directives' });
          }
        }

        const hasNodeModules = files.some(f => f.startsWith('node_modules/'));
        if (!hasNodeModules) {
          issues.push({ severity: 'critical', category: 'setup', msg: `node_modules not found — run ${installCmd} in the terminal` });
        } else {
          const hasViteBin = files.some(f => f === 'node_modules/.bin/vite' || f.endsWith('/node_modules/.bin/vite'));
          const hasTailwindBin = files.some(f => f === 'node_modules/.bin/tailwindcss' || f.endsWith('/node_modules/.bin/tailwindcss'));
          if (/\bvite\b/.test(String(pkg.scripts?.dev || '')) && !hasViteBin) {
            issues.push({ severity: 'critical', category: 'setup', msg: `vite binary missing in node_modules/.bin. Reinstall devDependencies with ${installCmd}.` });
          }
          if (allDeps['tailwindcss'] && !hasTailwindBin) {
            issues.push({ severity: 'critical', category: 'css', msg: `tailwindcss binary missing in node_modules/.bin. Reinstall devDependencies with ${installCmd}.` });
          }
        }

        const cssFiles = files.filter(f => f.endsWith('.css'));
        if (cssFiles.length === 0) {
          issues.push({ severity: 'warning', category: 'css', msg: 'No .css files found in workspace' });
        }

        const criticalCount = issues.filter(i => i.severity === 'critical').length;
        const errorCount    = issues.filter(i => i.severity === 'error').length;
        const warnCount     = issues.filter(i => i.severity === 'warning').length;

        let recommendation = 'Project setup looks good';
        if (criticalCount > 0) recommendation = `Run \`${installCmd}\` in the terminal, then \`${devCmd}\` to start the dev server.`;
        else if (errorCount > 0) recommendation = 'Fix the CSS configuration errors above, then restart the dev server.';

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
          summary: issues.length === 0 ? 'No issues' : `${criticalCount} critical, ${errorCount} error, ${warnCount} warning`,
          recommendation,
        };
      },
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
    noStyling: /no\s*styl|unstyled|missing\s*(css|style)|style.*not.*load|no\s*css|looks?\s*plain|no\s*design|plain\s*html|not\s*styled|styles?\s*(are\s*)?(missing|broken|gone|not\s*working)|install|node.?module/i.test(q),
  };

  const toolCalls = [];
  const steps = [];

  if (intents.noStyling) {
    const diagnosis = tools.diagnoseProject.execute();
    toolCalls.push({ tool: 'diagnoseProject', args: {}, result: diagnosis });
    steps.push(`🔬 **diagnoseProject**() → ${diagnosis.summary}`);

    const severityIcon = { critical: '🔴', error: '🟠', warning: '🟡' };
    const issueList = diagnosis.issues.length > 0
      ? diagnosis.issues.map(i => `  ${severityIcon[i.severity] || 'ℹ️'} **[${i.severity.toUpperCase()}]** ${i.msg}`).join('\n')
      : '  ✅ No setup issues found';
    const infoList = diagnosis.info.length > 0
      ? '\n\n**Project info:**\n' + diagnosis.info.map(i => `  • ${i}`).join('\n')
      : '';

    const actionBlock = diagnosis.criticalCount > 0
      ? `\n\n**Fix:**\n1. Open the **Terminal** panel\n2. Run: \`${diagnosis.installCommand || 'npm install --include=dev'}\`\n3. Then run: \`${diagnosis.devCommand || 'npm run dev'}\`\n4. Reload the preview`
      : diagnosis.errorCount > 0
      ? '\n\n**Fix the errors above**, then restart your dev server.'
      : '\n\nProject setup looks correct. Try reloading the preview or restarting the dev server.';

    return {
      steps,
      toolCalls,
      response: `**Project Setup Diagnosis** (${diagnosis.totalFiles} files scanned)\n**Status:** ${diagnosis.summary}\n\n**Issues:**\n${issueList}${infoList}${actionBlock}`,
    };
  }

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
