// ─── Agent Registry ───────────────────────────────────────────────────────────
// Single source of truth for all AI agents available in EpiCodeSpace.
// Each agent has a `models` list — the first entry is the default. Tiers:
//   'premium'  — most capable, slower, highest cost
//   'standard' — balanced
//   'fast'     — cheap, quick, smaller-context

// OpenAI model catalog (shared by epicode-agent + copilot)
const OPENAI_MODELS = [
  { id: 'gpt-4o',       name: 'GPT-4o',       tier: 'standard', description: 'Reliable, widely available' },
  { id: 'gpt-4.1',      name: 'GPT-4.1',      tier: 'standard', description: 'Large-context coding (Apr 2025)' },
  { id: 'gpt-4o-mini',  name: 'GPT-4o mini',  tier: 'fast',     description: 'Cheap + fast' },
  { id: 'o3',           name: 'o3',            tier: 'premium',  description: 'Deep reasoning' },
  { id: 'o3-mini',      name: 'o3 mini',       tier: 'fast',     description: 'Quick reasoning' },
  { id: 'gpt-5',        name: 'GPT-5',         tier: 'premium',  description: 'Frontier model (if available)' },
  { id: 'gpt-5-mini',   name: 'GPT-5 mini',   tier: 'standard', description: 'Fast GPT-5 variant (if available)' },
];

const CLAUDE_MODELS = [
  { id: 'claude-opus-4-5',              name: 'Claude Opus 4.5',    tier: 'premium',  description: 'Frontier Anthropic flagship (2026)' },
  { id: 'claude-sonnet-4-5',            name: 'Claude Sonnet 4.5',  tier: 'standard', description: 'Balanced flagship (2026)' },
  { id: 'claude-3-7-sonnet-20250219',   name: 'Claude 3.7 Sonnet',  tier: 'standard', description: 'Balanced Anthropic flagship (Feb 2025)' },
  { id: 'claude-3-5-sonnet-20241022',   name: 'Claude 3.5 Sonnet',  tier: 'standard', description: 'Reliable flagship (Oct 2024)' },
  { id: 'claude-3-5-haiku-20241022',    name: 'Claude 3.5 Haiku',   tier: 'fast',     description: 'Fast + cheap Anthropic' },
  { id: 'claude-3-opus-20240229',       name: 'Claude 3 Opus',      tier: 'premium',  description: 'Advanced reasoning' },
];

const GEMINI_MODELS = [
  { id: 'gemini-2.5-pro',   name: 'Gemini 2.5 Pro',   tier: 'premium',  description: 'Google flagship multimodal' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'fast',     description: 'Low-latency variant' },
];

const DEEPSEEK_MODELS = [
  { id: 'deepseek-chat',     name: 'DeepSeek V3',       tier: 'standard', description: 'General coding chat (supports tools)' },
  { id: 'deepseek-reasoner', name: 'DeepSeek R1',       tier: 'premium',  description: 'Reasoning model (no tool calling)' },
  { id: 'deepseek-coder',    name: 'DeepSeek Coder',    tier: 'fast',     description: 'Code-specialised' },
];

/** @type {import('../types').AgentRegistry} */
export const AGENT_REGISTRY = {
  'epicode-agent': {
    id: 'epicode-agent',
    name: 'EpiCode Agent',
    icon: 'sparkles',
    color: 'text-fuchsia-400',
    description: 'Full-stack coding assistant (OpenAI-backed)',
    capabilities: ['code_gen', 'refactor', 'explain', 'debug', 'file_ops', 'review'],
    models: OPENAI_MODELS,
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    icon: 'sparkles',
    color: 'text-orange-400',
    description: 'Anthropic reasoning & analysis',
    capabilities: ['explain', 'refactor', 'review', 'architecture', 'debug'],
    models: CLAUDE_MODELS,
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    icon: 'sparkles',
    color: 'text-blue-400',
    description: 'Google multimodal reasoning',
    capabilities: ['explain', 'code_gen', 'architecture', 'docs'],
    models: GEMINI_MODELS,
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: 'code2',
    color: 'text-green-400',
    description: 'Specialized code generation & completion',
    capabilities: ['code_gen', 'refactor', 'debug', 'test_gen'],
    models: DEEPSEEK_MODELS,
  },
};

/** Resolve the default model id for an agent. */
export function defaultModelFor(agentId) {
  return AGENT_REGISTRY[agentId]?.models?.[0]?.id || null;
}

/** Check whether a model id is valid for the given agent. */
export function isValidModelFor(agentId, modelId) {
  const list = AGENT_REGISTRY[agentId]?.models || [];
  return list.some(m => m.id === modelId);
}
