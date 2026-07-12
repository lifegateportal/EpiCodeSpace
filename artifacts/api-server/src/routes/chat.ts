import { Router } from "express";
import { logger } from "../lib/logger";
import { buildSystemPrompt, MODE_INSTRUCTIONS } from "../lib/agentPromptPolicy";

const router = Router();
const CANONICAL_GUIDANCE_FILE = '.cursorrules.md';

// Note: Environment variables are now loaded in index.ts before this module is imported

const PROVIDER_CONFIG: Record<string, { url: string; envKey: string; model: string; transform: string }> = {
  'epicode-agent': {
    url: 'https://api.openai.com/v1/chat/completions',
    envKey: 'OPENAI_API_KEY',
    model: 'gpt-4o',
    transform: 'openai',
  },
  'backend-architect': {
    url: 'https://api.deepseek.com/chat/completions',
    envKey: 'DEEPSEEK_API_KEY',
    model: 'deepseek-chat',
    transform: 'openai',
  },
  claude: {
    url: 'https://api.anthropic.com/v1/messages',
    envKey: 'ANTHROPIC_API_KEY',
    model: 'claude-3-7-sonnet-20250219',
    transform: 'anthropic',
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    envKey: 'GOOGLE_AI_API_KEY',
    model: 'gemini-2.5-pro',
    transform: 'gemini',
  },
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    envKey: 'DEEPSEEK_API_KEY',
    model: 'deepseek-chat',
    transform: 'openai',
  },
};

const ALLOWED_MODELS: Record<string, string[]> = {
  'epicode-agent': ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3', 'o3-mini', 'gpt-5', 'gpt-5-mini'],
  'backend-architect': ['deepseek-chat', 'deepseek-reasoner'],
  claude:          ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
  gemini:          ['gemini-2.5-pro', 'gemini-2.5-flash'],
  deepseek:        ['deepseek-chat', 'deepseek-reasoner', 'deepseek-vl'],
};

const AGENT_PERSONAS: Record<string, string> = {
  'epicode-agent': 'EpiCode Agent, a full-stack autonomous coding assistant with deep knowledge of React, Node.js, Vite, Tailwind, and modern web architecture',
  'backend-architect': 'Backend Architect, a senior systems integration engineer and backend architecture copilot focused on robust APIs, database connections, and third-party integrations',
  claude:         'Claude by Anthropic, an expert at structured reasoning, code review, refactoring, and software architecture',
  gemini:         'Gemini 2.5 Pro by Google, a multimodal reasoning assistant skilled at code generation, architecture planning, and documentation',
  deepseek:       'DeepSeek V3, a highly capable coding and reasoning assistant — be thorough, direct, and produce complete working code',
};

const WORKSPACE_TOOLS = [
  { name: 'readFile', description: 'Read file contents. For large files, pass startLine/endLine to read a focused chunk and avoid context overflow.', parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number', description: 'Optional 1-indexed start line (for chunk reads)' }, endLine: { type: 'number', description: 'Optional 1-indexed end line (for chunk reads)' }, maxChars: { type: 'number', description: 'Optional hard cap for returned characters (default 60000)' } }, required: ['path'] } },
  { name: 'writeFile', description: 'Create or fully overwrite a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'patchLines', description: '🏆 PREFERRED editing tool. Replace a range of lines in a file by line number. Always succeeds, no text-matching needed. Use the line numbers shown in readFile output. This is the most reliable way to edit files.', parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number', description: '1-indexed first line to replace (inclusive)' }, endLine: { type: 'number', description: '1-indexed last line to replace (inclusive)' }, newContent: { type: 'string', description: 'New content to insert in place of startLine–endLine' } }, required: ['path', 'startLine', 'endLine', 'newContent'] } },
  { name: 'editFile', description: '⚠️ FRAGILE - use patchLines instead. Patches a file by replacing exact text. Requires character-perfect oldText match including all whitespace/tabs/quotes. Fails on minor differences. Include 7+ unchanged context lines before and after to make the match unique.', parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string', description: 'Exact text to find and replace - must match character-for-character including all spaces, tabs, quotes, and line endings. Copy verbatim from readFile output with at least 7 unchanged lines before and after.' }, newText: { type: 'string', description: 'Replacement text' } }, required: ['path', 'oldText', 'newText'] } },
  { name: 'deleteFile', description: 'Delete a file from the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'listFiles', description: 'List all files in the workspace.', parameters: { type: 'object', properties: {} } },
  { name: 'searchCode', description: 'Search for a text pattern across all workspace files.', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'analyzeFile', description: 'Run static analysis on a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'runCommand', description: 'Run a shell command in the terminal. ROUTING IS AUTOMATIC — you do not need to choose: npm/npx/node/yarn/pnpm commands go to the WebContainers Runtime (real execution); git/system commands go to the simulated Terminal. Examples: "npm install axios" → runtime; "git status" → terminal.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to run. For package installs prefer npmInstall tool. For dev server use "npm run dev".' } }, required: ['command'] } },
  { name: 'runBuild', description: 'Run the project build command using the detected package manager. Use this for end-of-batch verification when the user wants to confirm the project still builds from chat.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Optional explicit build command override, e.g. "pnpm run build".' } } } },
  { name: 'runTests', description: 'Run the project test command using the detected package manager (pnpm/yarn/npm). Use after code changes and before finalizing fixes.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Optional explicit test command override, e.g. "pnpm test -- --runInBand".' } } } },
  { name: 'runLint', description: 'Run the project lint command using the detected package manager. Use to validate style and static checks after edits.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Optional explicit lint command override.' } } } },
  { name: 'runTypecheck', description: 'Run TypeScript typechecking if available. Prefer this after TS/JS refactors to catch regressions.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Optional explicit typecheck command override.' } } } },
  { name: 'diagnoseProject', description: 'Diagnose common project setup issues: missing node_modules, broken CSS/styling setup, missing config files, incorrect Tailwind/PostCSS configuration, missing CSS imports in HTML. Use this whenever the user reports unstyled UI, missing styles, or a project that looks like plain HTML.', parameters: { type: 'object', properties: {} } },
  { name: 'getProjectStructure', description: 'Get the full directory tree of the workspace as a nested structure. Use before making multi-file changes to understand the project layout, folder organization, and file types.', parameters: { type: 'object', properties: {} } },
  { name: 'searchAndReplace', description: 'Find and replace text across workspace files. Use for bulk renaming, updating imports, changing variable names or constants across many files. Changes are applied immediately.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Text or regex pattern to find' }, replacement: { type: 'string', description: 'Replacement text' }, targetFile: { type: 'string', description: 'Optional: limit to one file path' }, regex: { type: 'boolean', description: 'Treat pattern as regex (default false)' }, caseSensitive: { type: 'boolean', description: 'Case-sensitive match (default false)' } }, required: ['pattern', 'replacement'] } },
  { name: 'npmInstall', description: 'Install npm packages. Use when new dependencies are needed. Equivalent to running npm install [packages] in the terminal.', parameters: { type: 'object', properties: { packages: { type: 'string', description: 'Space-separated package names, e.g. "react-router-dom date-fns". Leave empty to install all from package.json.' }, dev: { type: 'boolean', description: 'Install as devDependency (--save-dev)' } } } },
  { name: 'getTerminalOutput', description: 'Read the last N lines of terminal output — including build errors, test failures, console logs, and runtime output. ALWAYS call this first when the user reports an error, asks to fix something, or when you need to see actual runtime behavior.', parameters: { type: 'object', properties: { lines: { type: 'number', description: 'Number of recent lines to fetch (default 60, max 200)' }, errorsOnly: { type: 'boolean', description: 'If true, filter for lines containing error/warn/fail keywords only' } } } },
  { name: 'getProblems', description: 'Parse recent terminal output and return structured build/test/lint/type errors with severity and suggested next action. Use immediately after runTests/runLint/runTypecheck/runCommand.', parameters: { type: 'object', properties: { lines: { type: 'number', description: 'How many recent terminal lines to inspect (default 120, max 400)' } } } },
  { name: 'autoFix', description: 'Automatically fix all auto-patchable issues in a file: converts var→const, loose == to ===, removes debugger statements. Apply this FIRST on any file with quality/style issues, then handle the remaining complex bugs with editFile.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File to fix (defaults to active file)' } } } },
  { name: 'explainError', description: 'Parse an error message or stack trace and return a structured explanation with root cause, fix steps, and code example. Use when the user pastes an error or when getTerminalOutput reveals an error you need to understand.', parameters: { type: 'object', properties: { error: { type: 'string', description: 'The full error message or stack trace text' } }, required: ['error'] } },
  { name: 'getGitStatus', description: 'Run git status and git diff --stat to see what files have changed. Use before generating commit messages or when the user asks about pending changes.', parameters: { type: 'object', properties: {} } },
  { name: 'createComponent', description: 'Scaffold a new React component, custom hook, or context provider with proper boilerplate. Faster than writeFile for standard patterns.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Component/hook name (PascalCase)' }, type: { type: 'string', enum: ['react', 'react-functional', 'react-hook', 'hook', 'context', 'util'], description: 'Component type' }, path: { type: 'string', description: 'Output file path (auto-generated if omitted)' }, props: { type: 'array', items: { type: 'string' }, description: 'List of prop names' } }, required: ['name'] } },
];

const TOOL_POLICY: Record<string, 'read' | 'safe_write' | 'risky_write' | 'command'> = {
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
  npmInstall: 'command',
  runCommand: 'command',
  runBuild: 'command',
  runTests: 'command',
  runLint: 'command',
  runTypecheck: 'command',
};

// Tools that only read — no writes happen
const READ_ONLY_TOOLS = new Set([
  'readFile', 'listFiles', 'getProjectStructure', 'searchCode',
  'analyzeFile', 'getTerminalOutput', 'getProblems', 'getGitStatus', 'diagnoseProject', 'explainError',
]);

// Tools that mutate the workspace
const WRITE_TOOLS = new Set([
  'writeFile', 'editFile', 'patchLines', 'deleteFile',
  'searchAndReplace', 'autoFix', 'createComponent', 'npmInstall', 'runCommand', 'runBuild', 'runTests', 'runLint', 'runTypecheck',
]);

function shouldUseToolsForMode(mode: string) {
  return mode === 'agent' || mode === 'plan' || mode === 'scaffold';
}

function getToolsForMode(mode: string) {
  if (mode === 'ask') return [] as typeof WORKSPACE_TOOLS;
  if (mode === 'plan') return WORKSPACE_TOOLS.filter((t) => READ_ONLY_TOOLS.has(t.name));
  if (mode === 'scaffold') return WORKSPACE_TOOLS; // Full tools for scaffolding
  return WORKSPACE_TOOLS;
}

const PROVIDER_TIMEOUT_MS = Math.max(5000, Number(process.env['AGENT_PROVIDER_TIMEOUT_MS'] ?? '45000'));
const PROVIDER_MAX_RETRIES = Math.max(0, Number(process.env['AGENT_PROVIDER_RETRIES'] ?? '1'));

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isAbortError(err: any) {
  return err?.name === 'AbortError' || /aborted|timeout/i.test(String(err?.message || ''));
}

async function fetchProvider(url: string, init: RequestInit, providerName: string) {
  let lastError: any = null;

  for (let attempt = 0; attempt <= PROVIDER_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) return res;

      if (!isRetryableStatus(res.status) || attempt === PROVIDER_MAX_RETRIES) {
        return res;
      }

      // Best-effort drain before retrying.
      try { await res.text(); } catch {}
      await wait(Math.min(4000, 300 * (2 ** attempt)));
      continue;
    } catch (err: any) {
      clearTimeout(timeout);
      lastError = err;
      if (attempt === PROVIDER_MAX_RETRIES) break;
      await wait(Math.min(4000, 300 * (2 ** attempt)));
    }
  }

  const e: any = new Error(`${providerName} request failed after retries`);
  e.cause = lastError;
  e.isTimeout = isAbortError(lastError);
  throw e;
}

function buildContextMessage(context: any) {
  if (!context) return '';
  const parts: string[] = [];
  const pinnedPath = String(context?.pinnedRules?.path || '').trim();
  if (context.pinnedRules?.content && pinnedPath === CANONICAL_GUIDANCE_FILE) {
    const p = context.pinnedRules;
    const t = p.content.length > 12000 ? p.content.slice(0, 12000) + '\n...(truncated)' : p.content;
    parts.push(`Pinned guidance (${p.path || 'rules'}):\n\`\`\`\n${t}\n\`\`\``);
  }
  if (context.activeFile) parts.push(`Currently editing: ${context.activeFile}`);
  if (context.activeContent) {
    const raw = context.activeContent;
    const LIMIT = 40000;
    const truncated = raw.length > LIMIT;
    const slice = truncated ? raw.slice(0, LIMIT) : raw;
    const numbered = slice.split('\n').map((l: string, i: number) => `${String(i + 1).padStart(4, ' ')} │ ${l}`).join('\n');
    const suffix = truncated ? '\n...(active file truncated for context budget — do NOT reread it wholesale; work from this context or make a targeted edit)' : '';
    parts.push(`File contents (line numbers shown — use patchLines to edit by line range):\n\`\`\`\n${numbered}${suffix}\n\`\`\`\n⚠ This file is already in your context. Do NOT call readFile for it — use patchLines, editFile, or writeFile to make changes immediately.`);
  }
  if (context.files?.length) parts.push(`Workspace files: ${context.files.map((f: any) => `${f.path} (${f.language}, ${f.lines} lines)`).join(', ')}`);
  if (Array.isArray(context.reasonerRelevantFiles) && context.reasonerRelevantFiles.length > 0) {
    const relevant = context.reasonerRelevantFiles
      .map((f: any) => `Relevant file: ${f.path}\n\n\`\`\`\n${f.excerpt || ''}\n\`\`\``)
      .join('\n\n');
    parts.push(`Relevant file bundle for planning:\n${relevant}`);
  }
  if (context.terminalOutput) {
    const t = context.terminalOutput.length > 3000 ? '...(truncated)\n' + context.terminalOutput.slice(-3000) : context.terminalOutput;
    parts.push(`Recent terminal output (auto-captured for debugging):\n\`\`\`\n${t}\n\`\`\`\nNote: These are the last lines from the user's terminal. Look for errors, warnings, or build failures.`);
  }
  return parts.length ? '\n\nWorkspace context:\n' + parts.join('\n') : '';
}

function prependContextToContent(content: any, contextStr: string) {
  const prefix = `${contextStr}\n\n---\n\n`;

  if (typeof content === 'string') return `${prefix}${content}`;

  if (Array.isArray(content)) {
    if (content.length === 0) return [{ type: 'text', text: prefix.trimEnd() }];
    const first = content[0];
    if (first && typeof first === 'object' && typeof first.text === 'string') {
      return [{ ...first, text: `${prefix}${first.text}` }, ...content.slice(1)];
    }
    return [{ type: 'text', text: prefix.trimEnd() }, ...content];
  }

  return `${prefix}${String(content ?? '')}`;
}

function dataUrlToGeminiInlineData(url: string) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!m) return null;
  const mimeType = m[1] || 'image/jpeg';
  const data = m[2] || '';
  if (!data) return null;
  return { inlineData: { mimeType, data } };
}

function toGeminiParts(content: any) {
  if (typeof content === 'string') return [{ text: content }];

  if (!Array.isArray(content)) {
    if (content && typeof content.text === 'string') return [{ text: content.text }];
    return [{ text: String(content ?? '') }];
  }

  const parts: any[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;

    if (typeof part.text === 'string') {
      parts.push({ text: part.text });
      continue;
    }

    if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
      const inline = dataUrlToGeminiInlineData(part.image_url.url);
      if (inline) parts.push(inline);
      continue;
    }

    if (part.type === 'image' && part.source?.type === 'base64' && typeof part.source?.data === 'string') {
      parts.push({ inlineData: { mimeType: part.source?.media_type || 'image/jpeg', data: part.source.data } });
      continue;
    }
  }

  return parts.length > 0 ? parts : [{ text: '' }];
}

function isAuthOrKeyError(err: any) {
  if (!err) return false;
  const s = `${err.status || ''} ${err.message || ''} ${err.body || ''}`.toLowerCase();
  if (err.status === 401 || err.status === 403) return true;
  return /invalid[_\s-]?api[_\s-]?key|incorrect api key|unauthorized|authentication|permission denied/.test(s);
}

function isContextLengthError(err: any) {
  if (!err) return false;
  const s = `${err.status || ''} ${err.message || ''} ${err.body || ''}`.toLowerCase();
  if (err.status && err.status !== 400 && err.status !== 413 && err.status !== 422) return false;
  return /context|token|length|too long|maximum|exceed/.test(s);
}

function truncateMessages(messages: any[], keepHead = 2, keepTail = 6) {
  if (messages.length <= keepHead + keepTail) return messages;
  const head = messages.slice(0, keepHead);
  const tail = messages.slice(-keepTail);
  const marker = { role: 'user', content: '[... earlier conversation truncated to fit context window ...]' };
  return [...head, marker, ...tail];
}

function packMessagesForProvider(messages: any[], context: any, maxMessages = 22) {
  if (!Array.isArray(messages) || messages.length <= maxMessages) return messages;

  const activeFile = String(context?.activeFile || '').toLowerCase();
  const userNeedles = new Set(
    String(messages[messages.length - 1]?.content || '')
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 4)
  );

  const scored = messages.map((m, idx) => {
    const text = String(m?.content || '').toLowerCase();
    const recency = idx / Math.max(1, messages.length - 1);
    let relevance = 0;
    if (activeFile && text.includes(activeFile)) relevance += 3;
    for (const n of userNeedles) if (text.includes(n)) relevance += 1;
    if (m?.role === 'user') relevance += 0.5;
    if (text.includes('error') || text.includes('exception') || text.includes('failed')) relevance += 1;
    return { idx, msg: m, score: recency + relevance };
  });

  const mustKeep = new Set<number>();
  mustKeep.add(messages.length - 1);
  if (messages.length > 1) mustKeep.add(messages.length - 2);

  const selected = scored
    .filter((s) => !mustKeep.has(s.idx))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, maxMessages - mustKeep.size))
    .map((s) => s.idx);

  for (const idx of mustKeep) selected.push(idx);

  return Array.from(new Set(selected)).sort((a, b) => a - b).map((idx) => messages[idx]);
}

function historyWindowForAgent(agent: string, mode: string) {
  if (mode !== 'agent') return 22;
  if (agent === 'backend-architect') return 40;
  return 22;
}

function findLastIndex(arr: any[], pred: (x: any) => boolean) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

async function callOpenAI(config: any, apiKey: string, systemPrompt: string, messages: any[], useTools: boolean, tools: any[]) {
  const isReasoning = /^o\d/i.test(config.model);
  const body: any = { model: config.model, messages: [{ role: 'system', content: systemPrompt }, ...messages] };
  if (isReasoning) { body.max_completion_tokens = 16384; }
  else { body.max_tokens = 16384; body.temperature = 0.7; }
  if (useTools && config.model !== 'deepseek-reasoner' && tools.length > 0) {
    body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }
  const res = await fetchProvider(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) }, config.model);
  if (!res.ok) { const err = await res.text(); const e: any = new Error(`${config.model} error ${res.status}: ${err}`); e.status = res.status; e.body = err; throw e; }
  const data: any = await res.json();
  const choice = data.choices?.[0];
  if (choice?.message?.tool_calls?.length) {
    return { type: 'tool_calls', tool_calls: choice.message.tool_calls.map((tc: any) => { let args = {}; try { args = JSON.parse(tc.function.arguments); } catch {} return { id: tc.id, name: tc.function.name, arguments: args }; }), content: choice.message.content || null, usage: data.usage };
  }
  return { type: 'text', content: choice?.message?.content || 'No response.', usage: data.usage };
}

async function callAnthropic(config: any, apiKey: string, systemPrompt: string, messages: any[], useTools: boolean, tools: any[]) {
  const system = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
  const cachedMessages = messages.map((m: any) => ({ ...m }));
  const lastUserIdx = findLastIndex(cachedMessages, m => m.role === 'user');
  const breakpointIdx = lastUserIdx > 0 ? lastUserIdx - 1 : -1;
  if (breakpointIdx >= 0) {
    const target = cachedMessages[breakpointIdx];
    if (typeof target.content === 'string') {
      target.content = [{ type: 'text', text: target.content, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(target.content) && target.content.length) {
      const last = target.content[target.content.length - 1];
      target.content[target.content.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
    }
  }
  const body: any = { model: config.model, max_tokens: 16384, system, messages: cachedMessages };
  if (useTools && tools.length > 0) {
    const providerTools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (providerTools.length) (providerTools[providerTools.length - 1] as any).cache_control = { type: 'ephemeral' };
    body.tools = providerTools;
  }
  const res = await fetchProvider(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' }, body: JSON.stringify(body) }, config.model);
  if (!res.ok) { const err = await res.text(); const e: any = new Error(`Claude error ${res.status}: ${err}`); e.status = res.status; e.body = err; throw e; }
  const data: any = await res.json();
  const toolBlocks = data.content?.filter((b: any) => b.type === 'tool_use') || [];
  const textBlocks = data.content?.filter((b: any) => b.type === 'text') || [];
  if (toolBlocks.length > 0) {
    return { type: 'tool_calls', tool_calls: toolBlocks.map((b: any) => ({ id: b.id, name: b.name, arguments: b.input })), content: textBlocks.map((b: any) => b.text).join('\n') || null, usage: data.usage };
  }
  return { type: 'text', content: textBlocks.map((b: any) => b.text).join('\n') || 'No response.', usage: data.usage };
}

async function callGemini(config: any, apiKey: string, systemPrompt: string, messages: any[], useTools: boolean, tools: any[]) {
  const url = `${config.url.replace('{model}', config.model)}?key=${apiKey}`;
  const contents = messages.map((m: any) => {
    if (m._geminiParts) return { role: m._geminiRole, parts: m._geminiParts };
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: toGeminiParts(m.content) };
  });
  const body: any = { contents, systemInstruction: { parts: [{ text: systemPrompt }] }, generationConfig: { maxOutputTokens: 16384, temperature: 0.7 } };
  if (useTools && tools.length > 0) { body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }]; }
  const res = await fetchProvider(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, config.model);
  if (!res.ok) { const err = await res.text(); const e: any = new Error(`Gemini error ${res.status}: ${err}`); e.status = res.status; e.body = err; throw e; }
  const data: any = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const funcCalls = parts.filter((p: any) => p.functionCall);
  const textParts = parts.filter((p: any) => p.text);
  if (funcCalls.length > 0) {
    return { type: 'tool_calls', tool_calls: funcCalls.map((p: any, i: number) => ({ id: `gem_${i}_${Date.now()}`, name: p.functionCall.name, arguments: p.functionCall.args || {} })), content: textParts.map((p: any) => p.text).join('\n') || null, usage: data.usageMetadata };
  }
  return { type: 'text', content: textParts.map((p: any) => p.text).join('\n') || 'No response.', usage: data.usageMetadata };
}

async function callProvider(config: any, apiKey: string, systemPrompt: string, messages: any[], useTools: boolean, tools: any[]) {
  const dispatch = (msgs: any[]) => {
    switch (config.transform) {
      case 'openai': return callOpenAI(config, apiKey, systemPrompt, msgs, useTools, tools);
      case 'anthropic': return callAnthropic(config, apiKey, systemPrompt, msgs, useTools, tools);
      case 'gemini': return callGemini(config, apiKey, systemPrompt, msgs, useTools, tools);
      default: throw new Error(`Unknown transform: ${config.transform}`);
    }
  };
  try { return await dispatch(messages); }
  catch (err) {
    if (!isContextLengthError(err)) throw err;
    return dispatch(truncateMessages(messages));
  }
}

function appendToolResults(apiMessages: any[], toolResults: any[], pendingToolCalls: any[], transform: string) {
  // Tool-level system message (e.g., from duplicate-call detection)
  const dedupeMessage = toolResults.find(r => typeof r?.result?.systemMessage === 'string')?.result?.systemMessage;

  // Detect a pure read-only round — every tool called was a read tool, nothing was written.
  // When this happens we inject a MANDATORY write constraint so the model stops stalling.
  const roundHasWrite = pendingToolCalls.some(tc => WRITE_TOOLS.has(tc.name));
  const roundAllRead  = pendingToolCalls.length > 0 && !roundHasWrite;
  const writeConstraint = roundAllRead
    ? '⚠ You spent the last round only reading. Use current context to make concrete progress now: prefer patchLines/editFile/writeFile, or runBuild/runTests/runLint/runTypecheck when verification is the blocker.'
    : null;

  // Detect multi-step work without proper completion markers
  // Look back at recent assistant messages for task/step patterns
  const recentAssistantMessages = apiMessages.filter(m => m.role === 'assistant' || m._geminiRole === 'model').slice(-3);
  const hasTaskNumbers = recentAssistantMessages.some(m => {
    const text = String(m.content || m._geminiParts?.[0]?.text || '');
    return /(?:task|step)\s*[123456]/i.test(text) && !/✅|complete|done|finished/i.test(text);
  });
  
  const taskProgressReminder = hasTaskNumbers && roundHasWrite
    ? '📋 Multi-step work detected: Mark EACH task complete immediately when done (e.g., "✅ Task 1 complete. Starting task 2..."). Do NOT jump to task 3 before finishing task 2.'
    : null;

  // Combine both messages; prefer dedupeMessage first, append write constraint if present
  const systemMsg = [dedupeMessage, writeConstraint, taskProgressReminder].filter(Boolean).join('\n\n') || null;

  if (transform === 'openai') {
    apiMessages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) });
    for (const r of toolResults) { apiMessages.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result) }); }
    if (systemMsg) apiMessages.push({ role: 'system', content: systemMsg });
  } else if (transform === 'anthropic') {
    apiMessages.push({ role: 'assistant', content: pendingToolCalls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments })) });
    apiMessages.push({ role: 'user', content: toolResults.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.result) })) });
    if (systemMsg) apiMessages.push({ role: 'user', content: `[System note] ${systemMsg}` });
  } else if (transform === 'gemini') {
    apiMessages.push({ _geminiRole: 'model', _geminiParts: pendingToolCalls.map(tc => ({ functionCall: { name: tc.name, args: tc.arguments } })) });
    apiMessages.push({ _geminiRole: 'user', _geminiParts: toolResults.map(r => ({ functionResponse: { name: r.name, response: r.result } })) });
    if (systemMsg) apiMessages.push({ _geminiRole: 'user', _geminiParts: [{ text: `[System note] ${systemMsg}` }] });
  }
}

const _rlMap = new Map<string, { count: number; start: number }>();
const RL_WINDOW = 60_000;
const RL_MAX = 20;
const _rlCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _rlMap.entries()) {
    if (now - entry.start > RL_WINDOW * 2) _rlMap.delete(key);
  }
}, 5 * 60_000);
if ((_rlCleanup as any).unref) (_rlCleanup as any).unref();

function isRateLimited(ip: string) {
  const now = Date.now();
  const entry = _rlMap.get(ip);
  if (!entry || now - entry.start > RL_WINDOW) { _rlMap.set(ip, { count: 1, start: now }); return false; }
  if (entry.count >= RL_MAX) return true;
  entry.count += 1;
  return false;
}

function keyAliases(envKey: string) {
  const noApi = envKey.replace(/_API_KEY$/, '_KEY');
  const noUnderscore = envKey.replace(/_API_KEY$/, 'APIKEY');
  return Array.from(new Set([
    envKey,
    noApi,
    noUnderscore,
    `VITE_${envKey}`,
    `VITE_${noApi}`,
    `VITE_${noUnderscore}`,
  ]));
}

function heuristicKeyNames(envKey: string) {
  const provider = envKey.replace(/_API_KEY$/, '');
  const keys = Object.keys(process.env || {});
  return keys.filter((k) => {
    const upper = k.toUpperCase();
    if (!upper.includes(provider)) return false;
    if (upper.includes('PUBLIC')) return false;
    if (upper.includes('CLIENT')) return false;
    return upper.includes('KEY') || upper.includes('TOKEN');
  });
}

function resolveApiKey(envKey: string) {
  for (const key of keyAliases(envKey)) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  for (const key of heuristicKeyNames(envKey)) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function getDeepSeekFallback(currentAgent: string, currentConfig: any, pendingToolCalls: any[]) {
  if (currentAgent === 'deepseek' || currentAgent === 'backend-architect') return null;
  const fallbackBase = PROVIDER_CONFIG.deepseek;
  const fallbackKey = resolveApiKey(fallbackBase.envKey);
  if (!fallbackKey) return null;
  if (pendingToolCalls?.length && currentConfig?.transform !== fallbackBase.transform) return null;
  return { agent: 'deepseek', config: { ...fallbackBase }, apiKey: fallbackKey };
}

router.post('/chat', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) { res.status(429).json({ error: 'Too many requests. Please wait a moment.' }); return; }

  try {
    const { agent, model, messages, context, mode = 'ask', toolResults, pendingToolCalls } = req.body;
    if (!agent || !messages?.length) { res.status(400).json({ error: 'Missing agent or messages' }); return; }
    if (typeof agent !== 'string' || agent.length > 64) { res.status(400).json({ error: 'Invalid agent' }); return; }
    if (!Array.isArray(messages) || messages.length > 120) { res.status(400).json({ error: 'Invalid messages' }); return; }
    const validModes = ['ask', 'agent', 'plan', 'scaffold'];
    const safeMode = validModes.includes(mode) ? mode : 'ask';

    const baseConfig = PROVIDER_CONFIG[agent];
    if (!baseConfig) { res.status(400).json({ error: `Unknown agent: ${agent}` }); return; }

    let resolvedModel = baseConfig.model;
    if (typeof model === 'string' && model.length > 0) {
      if (model.length > 100 || !ALLOWED_MODELS[agent]?.includes(model)) {
        res.status(400).json({ error: `Invalid model '${model}' for agent '${agent}'` }); return;
      }
      resolvedModel = model;
    }
    const config = { ...baseConfig, model: resolvedModel };
    let activeAgent = agent;
    let activeConfig = config;
    let activeApiKey: string | undefined = resolveApiKey(config.envKey);
    let fallbackReason: string | null = null;

    if (!activeApiKey) {
      if (agent === 'backend-architect') {
        res.status(500).json({
          error: `Backend Architect requires ${config.envKey}. Silent provider fallback is disabled for backend safety.`,
          missingKey: config.envKey,
          acceptedKeys: keyAliases(config.envKey),
          detectedProviderKeys: heuristicKeyNames(config.envKey),
        });
        return;
      }
      const fallback = getDeepSeekFallback(agent, config, pendingToolCalls);
      if (!fallback) {
        res.status(500).json({
          error: `API key not configured. Set ${config.envKey} in environment variables.`,
          missingKey: config.envKey,
          acceptedKeys: keyAliases(config.envKey),
          detectedProviderKeys: heuristicKeyNames(config.envKey),
        });
        return;
      }
      activeAgent = fallback.agent;
      activeConfig = fallback.config;
      activeApiKey = fallback.apiKey;
      fallbackReason = `missing_${config.envKey}`;
    }

    const contextStr = buildContextMessage(context);
    const modeInstr = MODE_INSTRUCTIONS[safeMode] || MODE_INSTRUCTIONS.ask;
    const providerTools = getToolsForMode(safeMode);
    const persona = AGENT_PERSONAS[activeAgent] || AGENT_PERSONAS['epicode-agent'];
    const policyPreview = Object.entries(TOOL_POLICY)
      .map(([tool, tier]) => `${tool}:${tier}`)
      .join(', ');
    const scaffoldMode = safeMode === 'scaffold';
    const systemPrompt = buildSystemPrompt(activeAgent, context, persona, policyPreview, scaffoldMode) + modeInstr;
    const useTools = shouldUseToolsForMode(safeMode) && providerTools.length > 0;

    let apiMessages = messages.map((m: any) => ({ role: m.role, content: m.content }));
    apiMessages = packMessagesForProvider(apiMessages, context, historyWindowForAgent(activeAgent, safeMode));
    if (contextStr) {
      const lastUserIdx = apiMessages.length - 1;
      if (lastUserIdx >= 0 && apiMessages[lastUserIdx].role === 'user') {
        apiMessages[lastUserIdx] = {
          ...apiMessages[lastUserIdx],
          content: prependContextToContent(apiMessages[lastUserIdx].content, contextStr),
        };
      }
    }
    if (toolResults && pendingToolCalls) {
      appendToolResults(apiMessages, toolResults, pendingToolCalls, activeConfig.transform);
    }

    let result: any;
    try {
      result = await callProvider(activeConfig, activeApiKey!, systemPrompt, apiMessages, useTools, providerTools);
    } catch (err: any) {
      const canFallback = activeAgent !== 'deepseek' && activeAgent !== 'backend-architect' && isAuthOrKeyError(err);
      if (!canFallback) throw err;
      const fallback = getDeepSeekFallback(activeAgent, activeConfig, pendingToolCalls);
      if (!fallback) throw err;
      activeAgent = fallback.agent;
      activeConfig = fallback.config;
      activeApiKey = fallback.apiKey;
      fallbackReason = 'provider_auth_error';
      const fallbackPersona = AGENT_PERSONAS[activeAgent] || AGENT_PERSONAS['epicode-agent'];
      const fallbackPolicyPreview = Object.entries(TOOL_POLICY)
        .map(([tool, tier]) => `${tool}:${tier}`)
        .join(', ');
      const fallbackSystemPrompt = buildSystemPrompt(activeAgent, context, fallbackPersona, fallbackPolicyPreview) + modeInstr;
      result = await callProvider(activeConfig, activeApiKey!, fallbackSystemPrompt, apiMessages, useTools, providerTools);
    }

    res.status(200).json({ ...result, agent: activeAgent, model: activeConfig.model || activeAgent, fallbackFrom: activeAgent !== agent ? agent : null, fallbackReason });
  } catch (err: any) {
    req.log.error({ err }, 'Chat API error');
    const timeoutHint = err?.isTimeout || /failed after retries/i.test(String(err?.message || ''));
    res.status(502).json({
      error: err.message || 'Upstream API error',
      code: timeoutHint ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
      retryable: true,
    });
  }
});

export default router;
