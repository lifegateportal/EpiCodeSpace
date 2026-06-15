import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();

const PROVIDER_CONFIG: Record<string, { url: string; envKey: string; model: string; transform: string }> = {
  'epicode-agent': {
    url: 'https://api.openai.com/v1/chat/completions',
    envKey: 'OPENAI_API_KEY',
    model: 'gpt-4o',
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
  claude:          ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
  gemini:          ['gemini-2.5-pro', 'gemini-2.5-flash'],
  deepseek:        ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
};

const AGENT_PERSONAS: Record<string, string> = {
  'epicode-agent': 'EpiCode Agent, a full-stack autonomous coding assistant with deep knowledge of React, Node.js, Vite, Tailwind, and modern web architecture',
  claude:         'Claude by Anthropic, an expert at structured reasoning, code review, refactoring, and software architecture',
  gemini:         'Gemini 2.5 Pro by Google, a multimodal reasoning assistant skilled at code generation, architecture planning, and documentation',
  deepseek:       'DeepSeek Coder V2, a code-specialised model that prefers dense code blocks over prose and excels at generation and refactoring',
};

const WORKSPACE_TOOLS = [
  { name: 'readFile', description: 'Read the full contents of a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'writeFile', description: 'Create or fully overwrite a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'editFile', description: 'Patch a file by replacing an exact block of text. Fuzzy-matches whitespace. If it fails, use patchLines instead.', parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string', description: 'Exact text to find and replace (copy verbatim from readFile output)' }, newText: { type: 'string', description: 'Replacement text' } }, required: ['path', 'oldText', 'newText'] } },
  { name: 'patchLines', description: 'Replace a range of lines in a file by line number. PREFERRED over editFile when you know which lines to change — always works, no text-matching needed. Use the line numbers from readFile output.', parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number', description: '1-indexed first line to replace (inclusive)' }, endLine: { type: 'number', description: '1-indexed last line to replace (inclusive)' }, newContent: { type: 'string', description: 'New content to insert in place of startLine–endLine' } }, required: ['path', 'startLine', 'endLine', 'newContent'] } },
  { name: 'deleteFile', description: 'Delete a file from the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'listFiles', description: 'List all files in the workspace.', parameters: { type: 'object', properties: {} } },
  { name: 'searchCode', description: 'Search for a text pattern across all workspace files.', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'analyzeFile', description: 'Run static analysis on a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'runCommand', description: 'Run a shell command (npm install, npm run dev, git status, etc.).', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'diagnoseProject', description: 'Diagnose common project setup issues: missing node_modules, broken CSS/styling setup, missing config files, incorrect Tailwind/PostCSS configuration, missing CSS imports in HTML. Use this whenever the user reports unstyled UI, missing styles, or a project that looks like plain HTML.', parameters: { type: 'object', properties: {} } },
  { name: 'getProjectStructure', description: 'Get the full directory tree of the workspace as a nested structure. Use before making multi-file changes to understand the project layout, folder organization, and file types.', parameters: { type: 'object', properties: {} } },
  { name: 'searchAndReplace', description: 'Find and replace text across workspace files. Use for bulk renaming, updating imports, changing variable names or constants across many files. Changes are applied immediately.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Text or regex pattern to find' }, replacement: { type: 'string', description: 'Replacement text' }, targetFile: { type: 'string', description: 'Optional: limit to one file path' }, regex: { type: 'boolean', description: 'Treat pattern as regex (default false)' }, caseSensitive: { type: 'boolean', description: 'Case-sensitive match (default false)' } }, required: ['pattern', 'replacement'] } },
  { name: 'npmInstall', description: 'Install npm packages. Use when new dependencies are needed. Equivalent to running npm install [packages] in the terminal.', parameters: { type: 'object', properties: { packages: { type: 'string', description: 'Space-separated package names, e.g. "react-router-dom date-fns". Leave empty to install all from package.json.' }, dev: { type: 'boolean', description: 'Install as devDependency (--save-dev)' } } } },
  { name: 'getTerminalOutput', description: 'Read the last N lines of terminal output — including build errors, test failures, console logs, and runtime output. ALWAYS call this first when the user reports an error, asks to fix something, or when you need to see actual runtime behavior.', parameters: { type: 'object', properties: { lines: { type: 'number', description: 'Number of recent lines to fetch (default 60, max 200)' }, errorsOnly: { type: 'boolean', description: 'If true, filter for lines containing error/warn/fail keywords only' } } } },
  { name: 'autoFix', description: 'Automatically fix all auto-patchable issues in a file: converts var→const, loose == to ===, removes debugger statements. Apply this FIRST on any file with quality/style issues, then handle the remaining complex bugs with editFile.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File to fix (defaults to active file)' } } } },
  { name: 'explainError', description: 'Parse an error message or stack trace and return a structured explanation with root cause, fix steps, and code example. Use when the user pastes an error or when getTerminalOutput reveals an error you need to understand.', parameters: { type: 'object', properties: { error: { type: 'string', description: 'The full error message or stack trace text' } }, required: ['error'] } },
  { name: 'getGitStatus', description: 'Run git status and git diff --stat to see what files have changed. Use before generating commit messages or when the user asks about pending changes.', parameters: { type: 'object', properties: {} } },
  { name: 'createComponent', description: 'Scaffold a new React component, custom hook, or context provider with proper boilerplate. Faster than writeFile for standard patterns.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Component/hook name (PascalCase)' }, type: { type: 'string', enum: ['react', 'react-functional', 'react-hook', 'hook', 'context', 'util'], description: 'Component type' }, path: { type: 'string', description: 'Output file path (auto-generated if omitted)' }, props: { type: 'array', items: { type: 'string' }, description: 'List of prop names' } }, required: ['name'] } },
];

const MODE_INSTRUCTIONS: Record<string, string> = {
  ask: '\n\nMode: ASK — Answer questions, explain code, provide guidance. Do NOT call tools.',
  agent: "\n\nMode: AGENT — You can directly read, write, edit, create, and delete files. Use tools to make actual changes. Read before writing.",
  plan: '\n\nMode: PLAN — Read files to understand the codebase, then create a numbered step-by-step plan. Do NOT use writeFile/editFile/deleteFile until the user approves.',
};

function buildSystemPrompt(agent: string, context: any) {
  const persona = AGENT_PERSONAS[agent] || AGENT_PERSONAS['epicode-agent'];
  const filePath = context?.activeFile || 'no file open';
  const fileCount = context?.files?.length ?? 0;
  return `[IDENTITY]
You are ${persona} operating within EpiCodeSpace, a premium web-native IDE. You are a senior full-stack engineer.

[THE ENVIRONMENT]
- Active file: ${filePath}
- Workspace: ${fileCount} file${fileCount !== 1 ? 's' : ''} (use listFiles or getProjectStructure to see them all)

[CORE RULES]
1. READ BEFORE WRITING — always inspect a file before modifying it; never assume its contents.
2. Never produce placeholder code ("// TODO", "...existing code...", "// add your logic here") — write complete, working implementations.
3. Match the user's existing style, frameworks, naming conventions, and patterns exactly.
4. When editing an existing file, use editFile (surgical patch) unless the full file must be replaced.
5. After installing packages or making config changes, run the dev server.

[CRITICAL — READ THIS FIRST]
The active file content is already provided below with line numbers. DO NOT call readFile for the active file. Make changes immediately using patchLines, editFile, or writeFile.

AFTER EVERY readFile, your next tool call MUST be a write operation (patchLines / editFile / writeFile / autoFix). Do NOT call readFile twice in a row. Do NOT describe what you will do — just do it.

[EDITING TOOLS — in order of preference]
1. patchLines(path, startLine, endLine, newContent) — BEST: replace by line number, always works, no text-matching
2. editFile(path, oldText, newText) — good for small patches; uses fuzzy whitespace matching
3. writeFile(path, content) — use when replacing most of a file or creating new files
4. autoFix(path) — use first for any file with quality issues (var/==/debugger)

WHEN editFile FAILS with "oldText not found":
→ Immediately call patchLines with the correct line numbers — DO NOT call readFile again

[DEBUGGING WORKFLOW]
1. Check context below for terminal output (auto-injected when debugging)
2. explainError(errorText) if there's a stack trace
3. analyzeFile(path) to find static issues
4. autoFix(path) for automatic patches
5. patchLines / editFile for remaining bugs
6. If module missing: npmInstall → runCommand("npm run dev")

[EXECUTION RULES — no exceptions]
- In AGENT mode: every response MUST include at least one tool call that writes/fixes something. Never produce text-only "here's what I would do" responses.
- Do not say "I'll now fix..." — just call the tool.
- Do not re-read files you already have. The active file is in context with line numbers.
- When you find a bug: fix it immediately with patchLines or editFile. Do not list it and wait.
- Complete all changes in one pass. Do not stop after the first file.

[TOOL SELECTION]
| Need | Tool |
|---|---|
| Fix specific lines | patchLines |
| Fix small block | editFile |
| Rewrite whole file | writeFile |
| Fix var/==/debugger | autoFix |
| Bulk rename | searchAndReplace |
| Read terminal errors | getTerminalOutput |
| Install package | npmInstall |
| New component | createComponent |

[CORE RULES]
1. Active file already in context — do NOT readFile it again. Edit immediately.
2. Complete code only — no placeholders, no "TODO", no "...existing code...".
3. Match existing code style, frameworks, naming.
4. After editing a file, update all imports that reference it.
5. After installing packages, run the dev server.

[BUILD WORKFLOW]
1. getProjectStructure (understand layout)
2. Read entry points + config files your code will depend on
3. Plan: list files to create/edit and their purpose
4. Create/edit in dependency order: config → types → utils → components → pages
5. Update parent imports/routes/barrels
6. npmInstall if new deps needed → runCommand("npm run dev")

[CSS & STYLING]
- Unstyled / plain HTML → diagnoseProject first
- Missing node_modules → npmInstall() then runCommand("npm run dev")  
- Tailwind checklist: tailwind.config.js ✓ postcss.config.js ✓ @tailwind directives ✓ CSS imported in JS entry ✓

[SLASH COMMANDS — user may type these; expand them fully]
- /fix → getTerminalOutput → analyzeFile → autoFix → editFile remaining issues
- /debug → getTerminalOutput → explainError → readFile → fix
- /explain → readFile → explain structure, purpose, patterns, suggestions
- /test → readFile → write complete test file with the project's test framework
- /doc → readFile → add JSDoc to all exports (no logic changes)
- /refactor → analyzeFile → autoFix → editFile improvements → explain changes
- /commit → getGitStatus → write conventional commit message
- /review → analyzeFile + readFile → prioritized findings with severity

[OUTPUT FORMAT]
- Wrap code in fenced blocks with language tag
- Precede each block with the file path (bold or as a comment)
- After making changes, summarize: what was changed, why, and what to do next`;
}

function buildContextMessage(context: any) {
  if (!context) return '';
  const parts: string[] = [];
  if (context.pinnedRules?.content) {
    const p = context.pinnedRules;
    const t = p.content.length > 12000 ? p.content.slice(0, 12000) + '\n...(truncated)' : p.content;
    parts.push(`Pinned guidance (${p.path || 'rules'}):\n\`\`\`\n${t}\n\`\`\``);
  }
  if (context.activeFile) parts.push(`Currently editing: ${context.activeFile}`);
  if (context.activeContent) {
    const raw = context.activeContent;
    const LIMIT = 8000;
    const truncated = raw.length > LIMIT;
    const slice = truncated ? raw.slice(0, LIMIT) : raw;
    const numbered = slice.split('\n').map((l: string, i: number) => `${String(i + 1).padStart(4, ' ')} │ ${l}`).join('\n');
    const suffix = truncated ? '\n...(file truncated — use readFile for the rest)' : '';
    parts.push(`File contents (line numbers shown — use patchLines to edit by line range):\n\`\`\`\n${numbered}${suffix}\n\`\`\`\n⚠ This file is already in your context. Do NOT call readFile for it — use patchLines, editFile, or writeFile to make changes immediately.`);
  }
  if (context.files?.length) parts.push(`Workspace files: ${context.files.map((f: any) => `${f.path} (${f.language}, ${f.lines} lines)`).join(', ')}`);
  if (context.terminalOutput) {
    const t = context.terminalOutput.length > 3000 ? '...(truncated)\n' + context.terminalOutput.slice(-3000) : context.terminalOutput;
    parts.push(`Recent terminal output (auto-captured for debugging):\n\`\`\`\n${t}\n\`\`\`\nNote: These are the last lines from the user's terminal. Look for errors, warnings, or build failures.`);
  }
  return parts.length ? '\n\nWorkspace context:\n' + parts.join('\n') : '';
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

function findLastIndex(arr: any[], pred: (x: any) => boolean) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

async function callOpenAI(config: any, apiKey: string, systemPrompt: string, messages: any[], useTools: boolean) {
  const isReasoning = /^o\d/i.test(config.model);
  const body: any = { model: config.model, messages: [{ role: 'system', content: systemPrompt }, ...messages] };
  if (isReasoning) { body.max_completion_tokens = 16384; }
  else { body.max_tokens = 16384; body.temperature = 0.7; }
  if (useTools && config.model !== 'deepseek-reasoner') {
    body.tools = WORKSPACE_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }
  const res = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
  if (!res.ok) { const err = await res.text(); const e: any = new Error(`${config.model} error ${res.status}: ${err}`); e.status = res.status; e.body = err; throw e; }
  const data = await res.json();
  const choice = data.choices?.[0];
  if (choice?.message?.tool_calls?.length) {
    return { type: 'tool_calls', tool_calls: choice.message.tool_calls.map((tc: any) => { let args = {}; try { args = JSON.parse(tc.function.arguments); } catch {} return { id: tc.id, name: tc.function.name, arguments: args }; }), content: choice.message.content || null, usage: data.usage };
  }
  return { type: 'text', content: choice?.message?.content || 'No response.', usage: data.usage };
}

async function callAnthropic(config: any, apiKey: string, systemPrompt: string, messages: any[], useTools: boolean) {
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
  if (useTools) {
    const tools = WORKSPACE_TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (tools.length) (tools[tools.length - 1] as any).cache_control = { type: 'ephemeral' };
    body.tools = tools;
  }
  const res = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' }, body: JSON.stringify(body) });
  if (!res.ok) { const err = await res.text(); const e: any = new Error(`Claude error ${res.status}: ${err}`); e.status = res.status; e.body = err; throw e; }
  const data = await res.json();
  const toolBlocks = data.content?.filter((b: any) => b.type === 'tool_use') || [];
  const textBlocks = data.content?.filter((b: any) => b.type === 'text') || [];
  if (toolBlocks.length > 0) {
    return { type: 'tool_calls', tool_calls: toolBlocks.map((b: any) => ({ id: b.id, name: b.name, arguments: b.input })), content: textBlocks.map((b: any) => b.text).join('\n') || null, usage: data.usage };
  }
  return { type: 'text', content: textBlocks.map((b: any) => b.text).join('\n') || 'No response.', usage: data.usage };
}

async function callGemini(config: any, apiKey: string, systemPrompt: string, messages: any[], useTools: boolean) {
  const url = `${config.url.replace('{model}', config.model)}?key=${apiKey}`;
  const contents = messages.map((m: any) => {
    if (m._geminiParts) return { role: m._geminiRole, parts: m._geminiParts };
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  });
  const body: any = { contents, systemInstruction: { parts: [{ text: systemPrompt }] }, generationConfig: { maxOutputTokens: 16384, temperature: 0.7 } };
  if (useTools) { body.tools = [{ functionDeclarations: WORKSPACE_TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }]; }
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const err = await res.text(); const e: any = new Error(`Gemini error ${res.status}: ${err}`); e.status = res.status; e.body = err; throw e; }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const funcCalls = parts.filter((p: any) => p.functionCall);
  const textParts = parts.filter((p: any) => p.text);
  if (funcCalls.length > 0) {
    return { type: 'tool_calls', tool_calls: funcCalls.map((p: any, i: number) => ({ id: `gem_${i}_${Date.now()}`, name: p.functionCall.name, arguments: p.functionCall.args || {} })), content: textParts.map((p: any) => p.text).join('\n') || null, usage: data.usageMetadata };
  }
  return { type: 'text', content: textParts.map((p: any) => p.text).join('\n') || 'No response.', usage: data.usageMetadata };
}

async function callProvider(config: any, apiKey: string, systemPrompt: string, messages: any[], useTools: boolean) {
  const dispatch = (msgs: any[]) => {
    switch (config.transform) {
      case 'openai': return callOpenAI(config, apiKey, systemPrompt, msgs, useTools);
      case 'anthropic': return callAnthropic(config, apiKey, systemPrompt, msgs, useTools);
      case 'gemini': return callGemini(config, apiKey, systemPrompt, msgs, useTools);
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
  const dedupeMessage = toolResults.find(r => typeof r?.result?.systemMessage === 'string')?.result?.systemMessage;
  if (transform === 'openai') {
    apiMessages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) });
    for (const r of toolResults) { apiMessages.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result) }); }
    if (dedupeMessage) apiMessages.push({ role: 'system', content: dedupeMessage });
  } else if (transform === 'anthropic') {
    apiMessages.push({ role: 'assistant', content: pendingToolCalls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments })) });
    apiMessages.push({ role: 'user', content: toolResults.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.result) })) });
    if (dedupeMessage) apiMessages.push({ role: 'user', content: `[System note] ${dedupeMessage}` });
  } else if (transform === 'gemini') {
    apiMessages.push({ _geminiRole: 'model', _geminiParts: pendingToolCalls.map(tc => ({ functionCall: { name: tc.name, args: tc.arguments } })) });
    apiMessages.push({ _geminiRole: 'user', _geminiParts: toolResults.map(r => ({ functionResponse: { name: r.name, response: r.result } })) });
    if (dedupeMessage) apiMessages.push({ _geminiRole: 'user', _geminiParts: [{ text: `[System note] ${dedupeMessage}` }] });
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

function getDeepSeekFallback(currentAgent: string, currentConfig: any, pendingToolCalls: any[]) {
  if (currentAgent === 'deepseek') return null;
  const fallbackBase = PROVIDER_CONFIG.deepseek;
  const fallbackKey = process.env[fallbackBase.envKey];
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
    if (!Array.isArray(messages) || messages.length > 100) { res.status(400).json({ error: 'Invalid messages' }); return; }
    const validModes = ['ask', 'agent', 'plan'];
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
    let activeApiKey: string | undefined = process.env[config.envKey];
    let fallbackReason: string | null = null;

    if (!activeApiKey) {
      const fallback = getDeepSeekFallback(agent, config, pendingToolCalls);
      if (!fallback) {
        res.status(500).json({ error: `API key not configured. Set ${config.envKey} in environment variables.`, missingKey: config.envKey }); return;
      }
      activeAgent = fallback.agent;
      activeConfig = fallback.config;
      activeApiKey = fallback.apiKey;
      fallbackReason = `missing_${config.envKey}`;
    }

    const contextStr = buildContextMessage(context);
    const modeInstr = MODE_INSTRUCTIONS[safeMode] || MODE_INSTRUCTIONS.ask;
    const systemPrompt = buildSystemPrompt(agent, context) + modeInstr;
    const useTools = safeMode === 'agent' || safeMode === 'plan';

    let apiMessages = messages.map((m: any) => ({ role: m.role, content: m.content }));
    if (contextStr) {
      const lastUserIdx = apiMessages.length - 1;
      if (lastUserIdx >= 0 && apiMessages[lastUserIdx].role === 'user') {
        apiMessages[lastUserIdx] = { ...apiMessages[lastUserIdx], content: `${contextStr}\n\n---\n\n${apiMessages[lastUserIdx].content}` };
      }
    }
    if (toolResults && pendingToolCalls) {
      appendToolResults(apiMessages, toolResults, pendingToolCalls, activeConfig.transform);
    }

    let result: any;
    try {
      result = await callProvider(activeConfig, activeApiKey!, systemPrompt, apiMessages, useTools);
    } catch (err: any) {
      const canFallback = activeAgent !== 'deepseek' && isAuthOrKeyError(err);
      if (!canFallback) throw err;
      const fallback = getDeepSeekFallback(activeAgent, activeConfig, pendingToolCalls);
      if (!fallback) throw err;
      activeAgent = fallback.agent;
      activeConfig = fallback.config;
      activeApiKey = fallback.apiKey;
      fallbackReason = 'provider_auth_error';
      result = await callProvider(activeConfig, activeApiKey!, systemPrompt, apiMessages, useTools);
    }

    res.status(200).json({ ...result, agent: activeAgent, model: activeConfig.model || activeAgent, fallbackFrom: activeAgent !== agent ? agent : null, fallbackReason });
  } catch (err: any) {
    req.log.error({ err }, 'Chat API error');
    res.status(502).json({ error: err.message || 'Upstream API error' });
  }
});

export default router;
