// Vercel Serverless Function — proxies chat to AI providers with tool calling
// POST /api/chat  { agent, messages, context, mode, toolResults, pendingToolCalls }

const PROVIDER_CONFIG = {
  'epicode-agent': {
    url: 'https://api.openai.com/v1/chat/completions',
    envKey: 'OPENAI_API_KEY',
    model: 'gpt-4o',
    transform: 'openai',
  },
  copilot: {
    url: 'https://api.openai.com/v1/chat/completions',
    envKey: 'OPENAI_API_KEY',
    model: 'gpt-4o-mini',
    transform: 'openai',
  },
  claude: {
    url: 'https://api.anthropic.com/v1/messages',
    envKey: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-20250514',
    transform: 'anthropic',
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent',
    envKey: 'GOOGLE_AI_API_KEY',
    transform: 'gemini',
  },
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    envKey: 'DEEPSEEK_API_KEY',
    model: 'deepseek-coder',
    transform: 'openai',
  },
};

const AGENT_PERSONAS = {
  'epicode-agent': 'EpiCode Agent, a full-stack autonomous coding assistant with deep knowledge of React, Node.js, Vite, Tailwind, and modern web architecture',
  copilot:        'Copilot, a lightning-fast coding assistant specialising in inline completions, test generation, and documentation',
  claude:         'Claude by Anthropic, an expert at structured reasoning, code review, refactoring, and software architecture',
  gemini:         'Gemini Pro by Google, a multimodal reasoning assistant skilled at code generation, architecture planning, and documentation',
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
  agent: '\n\nMode: AGENT — You can directly read, write, edit, create, and delete files in the user\'s workspace using the provided tools. When the user asks you to build, fix, or change something, USE THE TOOLS to make the actual changes. Do not just show code — apply it with writeFile or editFile. Work iteratively: read files first, then make changes. Confirm what you did after.',
  plan: '\n\nMode: PLAN — First read relevant files with readFile/listFiles to understand the codebase. Then create a numbered step-by-step plan of what you will change. Format with checkboxes:\n- [ ] Step 1: ...\n- [ ] Step 2: ...\nDo NOT call writeFile/editFile/deleteFile until the user approves. Only use read tools for research.',
};

const WORKSPACE_TOOLS = [
  { name: 'readFile', description: 'Read the full contents of a file.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path, e.g. "src/App.jsx"' } }, required: ['path'] } },
  { name: 'writeFile', description: 'Create or overwrite a file with new content.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Complete file content' } }, required: ['path', 'content'] } },
  { name: 'editFile', description: 'Replace a specific text section in a file (surgical edit).', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, oldText: { type: 'string', description: 'Exact text to find' }, newText: { type: 'string', description: 'Replacement text' } }, required: ['path', 'oldText', 'newText'] } },
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
async function callOpenAI(config, apiKey, systemPrompt, messages, useTools) {
  const body = { model: config.model, messages: [{ role: 'system', content: systemPrompt }, ...messages], max_tokens: 4096, temperature: 0.7 };
  if (useTools) { body.tools = WORKSPACE_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })); body.tool_choice = 'auto'; }

  const res = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
  if (!res.ok) { const err = await res.text(); throw new Error(`${config.model} error ${res.status}: ${err}`); }
  const data = await res.json();
  const choice = data.choices?.[0];
  if (choice?.message?.tool_calls?.length) {
    return { type: 'tool_calls', tool_calls: choice.message.tool_calls.map(tc => {
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      return { id: tc.id, name: tc.function.name, arguments: args };
    }), content: choice.message.content || null };
  }
  return { type: 'text', content: choice?.message?.content || 'No response.' };
}

// ── Anthropic ──────────────────────────────────────────────────────────────
async function callAnthropic(config, apiKey, systemPrompt, messages, useTools) {
  const body = { model: config.model, max_tokens: 4096, system: systemPrompt, messages };
  if (useTools) { body.tools = WORKSPACE_TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })); }

  const res = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
  if (!res.ok) { const err = await res.text(); throw new Error(`Claude error ${res.status}: ${err}`); }
  const data = await res.json();
  const toolBlocks = data.content?.filter(b => b.type === 'tool_use') || [];
  const textBlocks = data.content?.filter(b => b.type === 'text') || [];
  if (toolBlocks.length > 0) {
    return { type: 'tool_calls', tool_calls: toolBlocks.map(b => ({ id: b.id, name: b.name, arguments: b.input })), content: textBlocks.map(b => b.text).join('\n') || null };
  }
  return { type: 'text', content: textBlocks.map(b => b.text).join('\n') || 'No response.' };
}

// ── Gemini ──────────────────────────────────────────────────────────────────
async function callGemini(config, apiKey, systemPrompt, messages, useTools) {
  const url = `${config.url}?key=${apiKey}`;
  const contents = [];
  if (systemPrompt) { contents.push({ role: 'user', parts: [{ text: systemPrompt }] }); contents.push({ role: 'model', parts: [{ text: 'Ready.' }] }); }
  for (const m of messages) {
    if (m._geminiParts) { contents.push({ role: m._geminiRole, parts: m._geminiParts }); }
    else { contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }); }
  }
  const body = { contents, generationConfig: { maxOutputTokens: 4096, temperature: 0.7 } };
  if (useTools) { body.tools = [{ functionDeclarations: WORKSPACE_TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }]; }

  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const err = await res.text(); throw new Error(`Gemini error ${res.status}: ${err}`); }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const funcCalls = parts.filter(p => p.functionCall);
  const textParts = parts.filter(p => p.text);
  if (funcCalls.length > 0) {
    return { type: 'tool_calls', tool_calls: funcCalls.map((p, i) => ({ id: `gem_${i}_${Date.now()}`, name: p.functionCall.name, arguments: p.functionCall.args || {} })), content: textParts.map(p => p.text).join('\n') || null };
  }
  return { type: 'text', content: textParts.map(p => p.text).join('\n') || 'No response.' };
}

// ── Unified caller ─────────────────────────────────────────────────────────
async function callProvider(config, apiKey, systemPrompt, messages, useTools) {
  switch (config.transform) {
    case 'openai': return callOpenAI(config, apiKey, systemPrompt, messages, useTools);
    case 'anthropic': return callAnthropic(config, apiKey, systemPrompt, messages, useTools);
    case 'gemini': return callGemini(config, apiKey, systemPrompt, messages, useTools);
    default: throw new Error(`Unknown transform: ${config.transform}`);
  }
}

// ── Build tool result messages per provider ────────────────────────────────
function appendToolResults(apiMessages, toolResults, pendingToolCalls, transform) {
  if (transform === 'openai') {
    apiMessages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) });
    for (const r of toolResults) { apiMessages.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result) }); }
  } else if (transform === 'anthropic') {
    apiMessages.push({ role: 'assistant', content: pendingToolCalls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments })) });
    apiMessages.push({ role: 'user', content: toolResults.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.result) })) });
  } else if (transform === 'gemini') {
    apiMessages.push({ _geminiRole: 'model', _geminiParts: pendingToolCalls.map(tc => ({ functionCall: { name: tc.name, args: tc.arguments } })) });
    apiMessages.push({ _geminiRole: 'user', _geminiParts: toolResults.map(r => ({ functionResponse: { name: r.name, response: r.result } })) });
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
    // In production without ALLOWED_ORIGIN set, block cross-origin requests
    const origin = req.headers.origin;
    const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
    if (origin && vercelUrl && origin !== vercelUrl) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
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
    const { agent, messages, context, mode = 'ask', toolResults, pendingToolCalls } = req.body;
    if (!agent || !messages?.length) return res.status(400).json({ error: 'Missing agent or messages' });
    // Validate and sanitize inputs
    if (typeof agent !== 'string' || agent.length > 64) return res.status(400).json({ error: 'Invalid agent' });
    if (!Array.isArray(messages) || messages.length > 100) return res.status(400).json({ error: 'Invalid messages' });
    const validModes = ['ask', 'agent', 'plan'];
    const safeMode = validModes.includes(mode) ? mode : 'ask';

    const config = PROVIDER_CONFIG[agent];
    if (!config) return res.status(400).json({ error: `Unknown agent: ${agent}` });

    const apiKey = process.env[config.envKey];
    if (!apiKey) return res.status(500).json({ error: `API key not configured. Set ${config.envKey} in Vercel env vars.`, missingKey: config.envKey });

    const contextStr = buildContextMessage(context);
    const modeInstr = MODE_INSTRUCTIONS[safeMode] || MODE_INSTRUCTIONS.ask;
    const systemPrompt = buildSystemPrompt(agent, context) + modeInstr + contextStr;
    const useTools = safeMode === 'agent' || safeMode === 'plan';

    let apiMessages = messages.map(m => ({ role: m.role, content: m.content }));

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
