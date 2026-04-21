// ─── Agent Registry ───────────────────────────────────────────────────────────
// Single source of truth for all AI agents available in EpiCodeSpace.

/** @type {import('../types').AgentRegistry} */
export const AGENT_REGISTRY = {
  'epicode-agent': {
    id: 'epicode-agent',
    name: 'EpiCode Agent',
    icon: 'sparkles',
    color: 'text-fuchsia-400',
    description: 'Full-stack coding assistant',
    capabilities: ['code_gen', 'refactor', 'explain', 'debug', 'file_ops', 'review'],
  },
  copilot: {
    id: 'copilot',
    name: 'Copilot',
    icon: 'cpu',
    color: 'text-cyan-400',
    description: 'GitHub Copilot-style autocomplete & chat',
    capabilities: ['code_gen', 'explain', 'test_gen', 'docs'],
  },
  claude: {
    id: 'claude',
    name: 'Claude 3.5 Sonnet',
    icon: 'sparkles',
    color: 'text-orange-400',
    description: 'Anthropic reasoning & analysis',
    capabilities: ['explain', 'refactor', 'review', 'architecture', 'debug'],
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini Pro 1.5',
    icon: 'sparkles',
    color: 'text-blue-400',
    description: 'Google multimodal reasoning',
    capabilities: ['explain', 'code_gen', 'architecture', 'docs'],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek Coder V2',
    icon: 'code2',
    color: 'text-green-400',
    description: 'Specialized code generation & completion',
    capabilities: ['code_gen', 'refactor', 'debug', 'test_gen'],
  },
};
