/**
 * Context budgeting for Codiee — trims message history to fit the model's
 * token budget before sending it to the AI.
 */

/** Minimal message shape accepted/sent to the AI SDK. */
export interface ContextMessage {
  role: string;
  content: string;
}

export const CONTEXT_LIMITS = {
  /** Approximate token budget for the message history sent to the AI. */
  maxHistoryTokens: 15000,
  /** Never drop below this many most-recent messages, even over budget. */
  minRecentMessages: 4,
};

/** Rough token estimate (~4 chars/token) — good enough for budgeting. */
export function estimateTokens(text = "") {
  return Math.ceil((text || "").length / 4);
}

/**
 * Split messages into [dropped, kept] — `kept` are the newest messages that
 * fit the budget, always keeping at least CONTEXT_LIMITS.minRecentMessages.
 */
export function splitByBudget(
  messages: ContextMessage[],
  maxTokens: number = CONTEXT_LIMITS.maxHistoryTokens
): { dropped: ContextMessage[]; kept: ContextMessage[] } {
  const kept: ContextMessage[] = [];
  let used = 0;

  let i = messages.length - 1;
  for (; i >= 0; i--) {
    const t = estimateTokens(messages[i].content);
    // Once we're over budget AND have a safe floor of recent messages, stop.
    if (used + t > maxTokens && kept.length >= CONTEXT_LIMITS.minRecentMessages) {
      break;
    }
    kept.unshift(messages[i]);
    used += t;
  }

  const dropped = messages.slice(0, i + 1);
  return { dropped, kept };
}

// Rolling-summary support for long conversations added later.
