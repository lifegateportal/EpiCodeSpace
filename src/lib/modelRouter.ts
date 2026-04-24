/**
 * modelRouter.ts — Auto routing logic for EpiCodeSpace.
 *
 * Rules for 'Auto' mode (NO premium Anthropic or standard GPT-4o):
 *   - Massive context / long text dumps  → Gemini Flash (large window, cheap)
 *   - Coding / boilerplate / loop tasks  → DeepSeek Coder
 *   - Default                            → DeepSeek V3 (general chat)
 *
 * Fallback order when a routed model fails: gemini-2.5-flash → gpt-4o-mini
 */

export const AUTO_MODEL_ID = '__auto__';

// Thresholds
const HEAVY_CONTEXT_CHARS = 2_000;   // prompt longer than this → Gemini Flash
const CODING_KEYWORDS = /\b(function|class|def |import |export |const |let |var |loop|boilerplate|refactor|scaffold|generate|write.*code|implement|typescript|javascript|python|snippet)\b/i;

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
  if (CODING_KEYWORDS.test(prompt)) {
    return { agent: 'deepseek', model: 'deepseek-coder' };
  }
  return { agent: 'deepseek', model: 'deepseek-chat' };
}

/** Ordered fallback chain used when the initial Auto model fails. */
const FALLBACK_CHAIN: AutoRoute[] = [
  { agent: 'gemini',        model: 'gemini-2.5-flash' },
  { agent: 'epicode-agent', model: 'gpt-4o-mini' },
];

function nextFallback(current: AutoRoute): AutoRoute | null {
  // If current is already gemini-flash, jump straight to gpt-4o-mini
  const idx = FALLBACK_CHAIN.findIndex(
    r => r.agent === current.agent && r.model === current.model
  );
  if (idx === -1) return FALLBACK_CHAIN[0]; // first fallback
  if (idx < FALLBACK_CHAIN.length - 1) return FALLBACK_CHAIN[idx + 1];
  return null; // exhausted
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
 * Otherwise it resolves the route, tries it, and retries with fallbacks on failure.
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

  let route = resolveAutoRoute(prompt);
  let lastError: unknown = null;

  // Try initial route + each fallback
  for (let attempt = 0; attempt < FALLBACK_CHAIN.length + 1; attempt++) {
    try {
      const attempt_payload: ChatPayload = { ...payload, agent: route.agent, model: route.model };
      const res = await fetchFn(attempt_payload, signal);
      if (res.ok) return { response: res, usedRoute: route };
      // Non-2xx counts as failure — try fallback
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err: unknown) {
      // Abort signals should not trigger fallback
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      lastError = err;
    }

    const next = nextFallback(route);
    if (!next) break;
    route = next;
  }

  // All routes exhausted — throw the last error
  throw lastError ?? new Error('Auto routing: all fallback models failed.');
}
