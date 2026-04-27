// Vercel Serverless Function — proxies chat to AI providers with tool calling
// POST /api/chat  { agent, model?, messages, context, mode, toolResults, pendingToolCalls }

const PROVIDER_CONFIG = {
  'epicode-agent': {
    url: 'https://api.openai.com/v1/chat/completions',
    envKey: 'OPENAI_API_KEY',
    model: 'gpt-5',
    transform: 'openai',
  },
  copilot: {
    url: 'https://api.openai.com/v1/chat/completions',
    envKey: 'OPENAI_API_KEY',
    model: 'gpt-5-mini',
    transform: 'openai',
  },
  claude: {
    url: 'https://api.anthropic.com/v1/messages',
    envKey: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-5-20250929',
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

// Allowlist of model ids the user may request per agent. Must be kept in sync
// with src/lib/agentRegistry.js so clients can't inject arbitrary model names.
const ALLOWED_MODELS = {
  'epicode-agent': ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'o3', 'o3-mini', 'gpt-4o', 'gpt-4o-mini'],
  copilot:         ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'o3', 'o3-mini', 'gpt-4o', 'gpt-4o-mini'],
  claude:          ['claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101', 'claude-opus-4-1-20250805', 'claude-haiku-4-5-20251101'],
  gemini:          ['gemini-2.5-pro', 'gemini-2.5-flash'],
  deepseek:        ['deepseek-reasoner', 'deepseek-chat', 'deepseek-coder'],
};

const AGENT_PERSONAS = {
  'epicode-agent': 'EpiCode Agent, a full-stack autonomous coding assistant with deep knowledge of React, Node.js, Vite, Tailwind, and modern web architecture',
  copilot:        'Copilot, a lightning-fast coding assistant specialising in inline completions, test generation, and documentation',
  claude:         'Claude by Anthropic, an expert at structured reasoning, code review, refactoring, and software architecture',
  gemini:         'Gemini 2.5 Pro by Google, a multimodal reasoning assistant skilled at code generation, architecture planning, and documentation',
  deepseek:       'DeepSeek Coder V2, a code-specialised model that prefers dense code blocks over prose and excels at generation and refactoring',
};

function buildSystemPrompt(agent, context) {
  const persona   = AGENT_PERSONAS[agent] || AGENT_PERSONAS['epicode-agent'];
  const filePath  = context?.activeFile   || 'no file open';
  const fileCount = context?.files?.length ?? 0;

  return `[IDENTITY]
You are ${persona} operating within EpiCodeSpace, an advanced web-native IDE.
Your primary goal is to assist the developer in architecting, writing, debugging, and analysing code with absolute precision.

[THE ENVIRONMENT]
- You are running inside a modern Node/React/Vite environment.
- The user's current active file is: ${filePath}
- The workspace root contains: ${fileCount} file${fileCount !== 1 ? 's' : ''}.

[YOUR CAPABILITIES & TOOL CALLING]
You are an autonomous agent with access to the workspace file system via these tools:
1. readFile(path)            — Read a file's exact contents before proposing modifications.
2. listFiles()              — Understand directory structures and imports.
3. searchCode(pattern)      — Find where a function, variable, or component is used across the codebase.
4. writeFile(path, content) — Create or overwrite a file with complete content.
5. editFile(path, oldText, newText) — Surgical in-place edit of a specific block.
6. deleteFile(path)         — Remove a file (confirm with user first for destructive ops).
7. runCommand(command)      — Execute shell commands (npm, git, ls, etc.).

[RULES OF ENGAGEMENT]
1. READ BEFORE WRITING: Never hallucinate file contents. Use readFile before modifying any file.
2. NO LAZY CODING: Never use placeholders like // ... rest of the code. Always produce complete, functional code blocks.
3. THINK STEP-BY-STEP: For complex architectural tasks, briefly outline your plan before writing code.
4. NO DESTRUCTIVE GUESSING: Before deleting or overwriting a large file, use searchCode to verify all dependencies.
5. PRECISION: Match the user's existing code style, indentation, and naming conventions.

[OUTPUT FORMAT]
- Wrap all code in standard markdown code blocks with the correct language tag.
- Precede modified code blocks with the file path, e.g. \`src/components/Button.jsx\`.
- Keep conversational pleasantries to an absolute minimum — focus purely on engineering value.`;
}

const MODE_INSTRUCTIONS = {
  ask: '\n\nMode: ASK — Answer questions, explain code, provide guidance. Do NOT call tools.',
  agent: '\n\nMode: AGENT — You can directly read, write, edit, create, and delete files in the user\'s workspace using the provided tools. When the user asks you to build, fix, or change something, USE THE TOOLS to make the actual changes. Do not just show code — apply it. EDITING RULES: (1) Use editFile to patch ANY existing file — supply an exact verbatim oldText block (unique in the file) and newText; never rewrite a whole file when only part changes. (2) Use writeFile ONLY to create files that do not yet exist. Work iteratively: read files first, then make targeted edits. Confirm what you did after.',
  plan: '\n\nMode: PLAN — First read relevant files with readFile/listFiles to understand the codebase. Then create a numbered step-by-step plan of what you will change. Format with checkboxes:\n- [ ] Step 1: ...\n- [ ] Step 2: ...\nDo NOT call writeFile/editFile/deleteFile until the user approves. Only use read tools for research.',
};

const WORKSPACE_TOOLS = [
  { name: 'readFile', description: 'Read the full contents of a file.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path, e.g. "src/App.jsx"' } }, required: ['path'] } },
  { name: 'writeFile', description: 'Create a NEW file that does not yet exist in the workspace. NEVER use on files that already exist — use editFile instead.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Complete file content' } }, required: ['path', 'content'] } },
  { name: 'editFile', description: 'Surgically patch an existing file by replacing an exact block of text. ALWAYS prefer this over writeFile when the file already exists. oldText must appear verbatim exactly once in the file; newText is inserted in its place. Returns an error if oldText is not found or matches multiple times — read the file first to get the exact text.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, oldText: { type: 'string', description: 'Verbatim text to find — must appear exactly once in the file. Include sufficient surrounding context to be unique.' }, newText: { type: 'string', description: 'Text to insert in place of oldText' } }, required: ['path', 'oldText', 'newText'] } },
  { name: 'deleteFile', description: 'Delete a file from the workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path to delete' } }, required: ['path'] } },
  { name: 'listFiles', description: 'List all files in the workspace with languages and line counts.', parameters: { type: 'object', properties: {} } },
  { name: 'searchCode', description: 'Search for a text pattern across all workspace files. Returns file path, line number, and matched text.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Text pattern to search' } }, required: ['pattern'] } },
  { name: 'analyzeFile', description: 'Run static analysis and debug scan on a file. Returns categorised issues (quality, async, react, safety, security, perf, runtime, debug) with line numbers and severity (error/warning/info). Also detects pasted stack traces and runtime error patterns.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path to analyse. Defaults to the active file if omitted.' } } } },
  { name: 'runCommand', description: 'Run a shell command in the workspace terminal. Supports: npm run build, npm run dev, npm install, npm test, git add/commit/push/pull/status, ls, cat, touch, rm, mkdir, grep, and more.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to execute, e.g. "npm run build" or "git add . && git commit -m fix"' } }, required: ['command'] } },
];

function buildContextMessage(context) {
  if (!context) return '';
  const parts = [];
  if (context.activeFile) parts.push(`Currently editing: ${context.activeFile}`);
  if (context.activeContent) {
    const t = context.activeContent.length > 8000 ? context.activeContent.slice(0, 8000) + '\n...(truncated)' : context.activeContent;
    parts.push(`File contents:\n\`\`\`\n${t}\n\`\`\``);
  }
  if (context.files?.length) parts.push(`Workspace files: ${context.files.map(f => `${f.path} (${f.language}, ${f.lines} lines)`).join(', ')}`);
  return parts.length ? '\n\nWorkspace context:\n' + parts.join('\n') : '';
}

// ── OpenAI / DeepSeek ──────────────────────────────────────────────────────
// OpenAI & DeepSeek implement **automatic prefix caching** — any request
// whose first N tokens exactly match a recent request is billed at a
// discount (50% for OpenAI, up to 90% for DeepSeek). We therefore:
//   • Always place the (stable) system prompt first.
//   • Keep historical messages in insertion order (never re-sort).
//   • Keep the "latest user query" as the final message — changing the
//     tail does NOT invalidate the cached prefix.
// No explicit cache_control field is required for these providers.
async function callOpenAI(config, apiKey, systemPrompt, messages, useTools) {
  // Reasoning-family models (o-series, gpt-5*) don't accept temperature and
  // use max_completion_tokens instead of max_tokens.
  // o-series (o3, o3-mini, o4-mini…) are reasoning models; gpt-5 family is standard chat.
  const isReasoning = /^o\d/i.test(config.model);
  const body = { model: config.model, messages: [{ role: 'system', content: systemPrompt }, ...messages] };
  if (isReasoning) {
    body.max_completion_tokens = 16384;
  } else {
    body.max_tokens = 16384;
    body.temperature = 0.7;
  }
  if (useTools) { body.tools = WORKSPACE_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })); body.tool_choice = 'auto'; }

  // deepseek-reasoner does not support function calling — strip tools silently.
  if (config.model === 'deepseek-reasoner') {
    delete body.tools;
    delete body.tool_choice;
  }

  const res = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
  if (!res.ok) { const err = await res.text(); const e = new Error(`${config.model} error ${res.status}: ${err}`); e.status = res.status; e.body = err; throw e; }
  const data = await res.json();
  const choice = data.choices?.[0];
  if (choice?.message?.tool_calls?.length) {
    return { type: 'tool_calls', tool_calls: choice.message.tool_calls.map(tc => {
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      return { id: tc.id, name: tc.function.name, arguments: args };
    }), content: choice.message.content || null, usage: data.usage };
  }
  return { type: 'text', content: choice?.message?.content || 'No response.', usage: data.usage };
}

// ── Anthropic ──────────────────────────────────────────────────────────────
// Anthropic requires **explicit** cache breakpoints via `cache_control:
// { type: 'ephemeral' }`. A breakpoint marks "cache everything up to and
// including this block"; the cache lives ~5 min and cuts input cost ~90%
// on hits. Max 4 breakpoints per request. We place them on:
//   1. The system prompt  (stable across every turn)
//   2. The tool definitions  (stable across every turn)
//   3. The LAST historical message  (stable until the next turn)
// The "latest user query" is left uncached — it changes every turn.
async function callAnthropic(config, apiKey, systemPrompt, messages, useTools) {
  // System prompt → array form so we can attach cache_control.
  const system = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  // Split history vs. latest query. The "latest query" is the final
  // user-role message; everything before it is cacheable history.
  const cachedMessages = messages.map(m => ({ ...m }));
  const lastUserIdx = findLastIndex(cachedMessages, m => m.role === 'user');
  // Cache breakpoint = the message immediately BEFORE the latest user
  // query (i.e. end of the static block). If the last message is the only
  // user message, skip the history breakpoint.
  const breakpointIdx = lastUserIdx > 0 ? lastUserIdx - 1 : -1;
  if (breakpointIdx >= 0) {
    const target = cachedMessages[breakpointIdx];
    // Anthropic only allows cache_control on content blocks, not raw
    // strings → promote string content to a single text block.
    if (typeof target.content === 'string') {
      target.content = [{ type: 'text', text: target.content, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(target.content) && target.content.length) {
      const last = target.content[target.content.length - 1];
      target.content[target.content.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
    }
  }

  const body = { model: config.model, max_tokens: 16384, system, messages: cachedMessages };
  if (useTools) {
    const tools = WORKSPACE_TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    // Cache the tool definitions too — they never change.
    if (tools.length) tools[tools.length - 1].cache_control = { type: 'ephemeral' };
    body.tools = tools;
  }

  const res = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Older SDKs required this beta header; the feature is GA now but
      // sending it is harmless and keeps older model snapshots working.
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const err = await res.text(); const e = new Error(`Claude error ${res.status}: ${err}`); e.status = res.status; e.body = err; throw e; }
  const data = await res.json();
  const toolBlocks = data.content?.filter(b => b.type === 'tool_use') || [];
  const textBlocks = data.content?.filter(b => b.type === 'text') || [];
  // usage.cache_creation_input_tokens / cache_read_input_tokens let the
  // client surface cache-hit telemetry.
  if (toolBlocks.length > 0) {
    return { type: 'tool_calls', tool_calls: toolBlocks.map(b => ({ id: b.id, name: b.name, arguments: b.input })), content: textBlocks.map(b => b.text).join('\n') || null, usage: data.usage };
  }
  return { type: 'text', content: textBlocks.map(b => b.text).join('\n') || 'No response.', usage: data.usage };
}

// Node 16-compatible findLastIndex (Array.prototype.findLastIndex is Node 18+).
function findLastIndex(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

// ── Gemini ──────────────────────────────────────────────────────────────────
async function callGemini(config, apiKey, systemPrompt, messages, useTools) {
  const url = `${config.url.replace('{model}', config.model)}?key=${apiKey}`;
  const contents = [];
  for (const m of messages) {
    if (m._geminiParts) { contents.push({ role: m._geminiRole, parts: m._geminiParts }); }
    else { contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }); }
  }
  const body = {
    contents,
    systemInstruction: { role: 'user', parts: [{ text: systemPrompt }] },
    generationConfig: { maxOutputTokens: 16384, temperature: 0.7 },
  };
  if (useTools) { body.tools = [{ functionDeclarations: WORKSPACE_TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }]; }

  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const err = await res.text(); const e = new Error(`Gemini error ${res.status}: ${err}`); e.status = res.status; e.body = err; throw e; }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const funcCalls = parts.filter(p => p.functionCall);
  const textParts = parts.filter(p => p.text);
  if (funcCalls.length > 0) {
    return { type: 'tool_calls', tool_calls: funcCalls.map((p, i) => ({ id: `gem_${i}_${Date.now()}`, name: p.functionCall.name, arguments: p.functionCall.args || {} })), content: textParts.map(p => p.text).join('\n') || null, usage: data.usageMetadata };
  }
  return { type: 'text', content: textParts.map(p => p.text).join('\n') || 'No response.', usage: data.usageMetadata };
}

// ── Unified caller with context-length fallback ────────────────────────────
// Heuristic: if the upstream returns a 4xx whose body mentions tokens/
// context/length, we aggressively trim the middle of history (keep the
// system prompt + the first exchange + the most recent 6 turns) and retry
// once. This also covers the case where a cached prefix was invalidated
// by an over-long tail.
function isContextLengthError(err) {
  if (!err) return false;
  const s = `${err.status || ''} ${err.message || ''} ${err.body || ''}`.toLowerCase();
  if (err.status && err.status !== 400 && err.status !== 413 && err.status !== 422) return false;
  return /context|token|length|too long|maximum|exceed/.test(s);
}

function truncateMessages(messages, keepHead = 2, keepTail = 6) {
  if (messages.length <= keepHead + keepTail) return messages;
  const head = messages.slice(0, keepHead);
  const tail = messages.slice(-keepTail);
  const marker = { role: 'user', content: '[... earlier conversation truncated to fit context window ...]' };
  return [...head, marker, ...tail];
}

async function callProvider(config, apiKey, systemPrompt, messages, useTools) {
  const dispatch = (msgs) => {
    switch (config.transform) {
      case 'openai':    return callOpenAI(config, apiKey, systemPrompt, msgs, useTools);
      case 'anthropic': return callAnthropic(config, apiKey, systemPrompt, msgs, useTools);
      case 'gemini':    return callGemini(config, apiKey, systemPrompt, msgs, useTools);
      default: throw new Error(`Unknown transform: ${config.transform}`);
    }
  };
  try {
    return await dispatch(messages);
  } catch (err) {
    if (!isContextLengthError(err)) throw err;
    // Retry once with a trimmed history. Cache will miss on this retry
    // (prefix changed) but that's far better than failing the request.
    const trimmed = truncateMessages(messages);
    const result = await dispatch(trimmed);
    return { ...result, _truncated: true };
  }
}

// ── Build tool result messages per provider ────────────────────────────────
function appendToolResults(apiMessages, toolResults, pendingToolCalls, transform) {
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

// ── In-memory rate limiter ─────────────────────────────────────────────────
// NOTE: Resets on cold-starts (serverless). For durable per-user limits
// across instances, swap _rlMap for @vercel/kv:
//   https://vercel.com/docs/storage/vercel-kv
const _rlMap = new Map(); // ip → { count: number, start: number }
const RL_WINDOW = 60_000; // 1 minute
const RL_MAX    = 20;     // requests per window

// Prevent unbounded growth between requests on warm instances
const _rlCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _rlMap.entries()) {
    if (now - entry.start > RL_WINDOW * 2) _rlMap.delete(key);
  }
}, 5 * 60_000);
if (_rlCleanup.unref) _rlCleanup.unref(); // don't block process exit in test envs

function isRateLimited(ip) {
  const now = Date.now();
  const entry = _rlMap.get(ip);
  if (!entry || now - entry.start > RL_WINDOW) {
    _rlMap.set(ip, { count: 1, start: now });
    return false;
  }
  if (entry.count >= RL_MAX) return true; // fixed: was `> max` (off-by-one)
  entry.count += 1;
  return false;
}

// ── Main handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS — restrict to configured origin in production, allow all in local dev
  const allowedOrigin = process.env.ALLOWED_ORIGIN || (process.env.VERCEL_ENV ? null : '*');
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  } else {
    // Production without ALLOWED_ORIGIN: allow same-origin only. A same-origin
    // request has its Origin host matching the request's Host header (this
    // covers the production alias, preview URLs, and custom domains without
    // requiring env config).
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try { originHost = new URL(origin).host; } catch { /* ignore */ }
      const host = req.headers.host;
      if (!host || originHost !== host) {
        return res.status(403).json({ error: 'Forbidden (cross-origin). Set ALLOWED_ORIGIN env var to allow this origin.' });
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    // No Origin header → same-origin navigation/fetch from a server; allow.
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit by IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });

  try {
    const { agent, model, messages, context, mode = 'ask', toolResults, pendingToolCalls } = req.body;
    if (!agent || !messages?.length) return res.status(400).json({ error: 'Missing agent or messages' });
    // Validate and sanitize inputs
    if (typeof agent !== 'string' || agent.length > 64) return res.status(400).json({ error: 'Invalid agent' });
    if (!Array.isArray(messages) || messages.length > 100) return res.status(400).json({ error: 'Invalid messages' });
    const validModes = ['ask', 'agent', 'plan'];
    const safeMode = validModes.includes(mode) ? mode : 'ask';

    const baseConfig = PROVIDER_CONFIG[agent];
    if (!baseConfig) return res.status(400).json({ error: `Unknown agent: ${agent}` });

    // Resolve + validate model override
    let resolvedModel = baseConfig.model;
    if (typeof model === 'string' && model.length > 0) {
      if (model.length > 100 || !ALLOWED_MODELS[agent]?.includes(model)) {
        return res.status(400).json({ error: `Invalid model '${model}' for agent '${agent}'` });
      }
      resolvedModel = model;
    }
    const config = { ...baseConfig, model: resolvedModel };

    const apiKey = process.env[config.envKey];
    if (!apiKey) return res.status(500).json({ error: `API key not configured. Set ${config.envKey} in Vercel env vars.`, missingKey: config.envKey });

    const contextStr = buildContextMessage(context);
    const modeInstr = MODE_INSTRUCTIONS[safeMode] || MODE_INSTRUCTIONS.ask;
    // Stable prefix for prompt caching: persona/rules/mode do NOT change
    // mid-conversation, so keep them in the system prompt. Workspace
    // context (active file contents) is volatile, so append it LAST —
    // after history — only when needed. That keeps the cacheable prefix
    // (system + history) identical across turns.
    const systemPrompt = buildSystemPrompt(agent, context) + modeInstr;
    const useTools = safeMode === 'agent' || safeMode === 'plan';

    // Normalise inbound messages and split history vs. latest query.
    // Frontend guarantees the last element is the user's newest turn.
    let apiMessages = messages.map(m => ({ role: m.role, content: m.content }));

    // Inject the (volatile) workspace context as a system-style user note
    // right before the latest user query — so it's NEVER part of the
    // cached historical block. This is critical: without this split, a
    // one-character edit to the active file would invalidate every
    // cached token.
    if (contextStr) {
      const lastUserIdx = apiMessages.length - 1;
      if (lastUserIdx >= 0 && apiMessages[lastUserIdx].role === 'user') {
        apiMessages[lastUserIdx] = {
          ...apiMessages[lastUserIdx],
          content: `${contextStr}\n\n---\n\n${apiMessages[lastUserIdx].content}`,
        };
      }
    }

    // Append tool results if this is a continuation
    if (toolResults && pendingToolCalls) {
      appendToolResults(apiMessages, toolResults, pendingToolCalls, config.transform);
    }

    const result = await callProvider(config, apiKey, systemPrompt, apiMessages, useTools);
    return res.status(200).json({ ...result, agent, model: config.model || agent });
  } catch (err) {
    console.error('Chat API error:', err);
    return res.status(502).json({ error: err.message || 'Upstream API error' });
  }
}
