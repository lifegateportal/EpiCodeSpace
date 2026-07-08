/**
 * modelRouter.ts — Auto routing logic for EpiCodeSpace.
 *
 * Rules for 'Auto' mode (NO premium Anthropic or standard GPT-4o):
 *   - Massive context / long text dumps  → Gemini Flash (large window, cheap)
 *   - Default                            → DeepSeek V3 (fast, smart, tool-calling)
 *
 * No fallback chain: Auto selects one route and fails fast if that route errors.
 */

export const AUTO_MODEL_ID = '__auto__';

// Thresholds
const HEAVY_CONTEXT_CHARS = 10_000;  // prompt longer than this → Gemini Flash

export interface AutoRoute {
  agent: string;
  model: string;
}

/**
 * Decide which agent+model to use for a given prompt in Auto mode.
 */
export function resolveAutoRoute(prompt: string): AutoRoute {
  if (prompt.length > HEAVY_CONTEXT_CHARS) {
    return { agent: 'gemini', model: 'gemini-2.5-flash' };
  }
  return { agent: 'deepseek', model: 'deepseek-chat' };
}

export interface ChatPayload {
  agent: string;
  model: string;
  messages: unknown[];
  context: unknown;
  mode: string;
  toolResults?: unknown;
  pendingToolCalls?: unknown;
}

type FetchFn = (payload: ChatPayload, signal?: AbortSignal) => Promise<Response>;

/**
 * Wraps a fetch call with automatic fallback when in Auto mode.
 * If `payload.model` is not AUTO_MODEL_ID, it dispatches as-is.
 * Otherwise it resolves one route and executes it without fallback chaining.
 */
export async function autoFetch(
  payload: ChatPayload,
  prompt: string,
  signal: AbortSignal | undefined,
  fetchFn: FetchFn
): Promise<{ response: Response; usedRoute: AutoRoute | null }> {
  if (payload.model !== AUTO_MODEL_ID) {
    const res = await fetchFn(payload, signal);
    return { response: res, usedRoute: null };
  }

  const route = resolveAutoRoute(prompt);
  try {
    const routedPayload: ChatPayload = { ...payload, agent: route.agent, model: route.model };
    const response = await fetchFn(routedPayload, signal);
    return { response, usedRoute: route };
  } catch (err: unknown) {
    // Preserve cancellation behavior for upstream callers.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw err ?? new Error('Auto routing failed.');
  }
}
