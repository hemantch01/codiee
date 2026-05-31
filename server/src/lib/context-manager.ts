/**
 * Context management for Codiee — keeps history within a token budget via a
 * sliding window plus a rolling summary of dropped messages, persisted on the
 * Conversation so resumed sessions keep their memory.
 */

/** Minimal message shape accepted/sent to the AI SDK. */
export interface ContextMessage {
  role: string;
  content: string;
}

interface ContextWindowResult {
  summary: string | null;
  summaryChanged: boolean;
  messages: ContextMessage[];
}

interface Summarizer {
  getMessage(messages: ContextMessage[]): Promise<string>;
}

export const CONTEXT_LIMITS = {
  /** Approximate token budget for the message history sent to the AI. */
  maxHistoryTokens: 15000,
  /** Never drop below this many most-recent messages, even over budget. */
  minRecentMessages: 4,
};

const SUMMARY_SYSTEM_PROMPT =
  "You maintain a compact running summary of a conversation between a " +
  "developer and their AI coding assistant. Produce a dense summary (max " +
  "~250 words) preserving: what the user asked for, decisions made, file " +
  "paths and component names mentioned, requirements/constraints stated, " +
  "and anything unresolved. Write it as plain prose bullet-style lines. " +
  "Do NOT greet, comment, or add headers — output only the summary.";

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

/** Summarize dropped messages into one compact note, folding in the previous rolling summary. */
function summarizeDropped(
  aiService: Summarizer,
  previousSummary: string | null,
  dropped: ContextMessage[]
): Promise<string> {
  const transcript = dropped
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n")
    .slice(0, 24000); // hard cap so summarization itself stays cheap

  const parts: string[] = [];
  if (previousSummary) {
    parts.push(`Previous running summary of earlier messages:\n${previousSummary}\n`);
  }
  parts.push(`Messages to fold into the summary:\n${transcript}`);
  if (previousSummary) {
    parts.push("\nMerge everything above into ONE updated running summary.");
  }

  return aiService
    .getMessage([
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: parts.join("\n") },
    ])
    .then((s) => s.trim());
}

/**
 * Build the context-managed window for an AI request. Send `messages` to the
 * AI and persist the returned summary when `summaryChanged` is true.
 */
export async function buildContextWindow({
  formattedMessages,
  existingSummary = null,
  aiService,
}: {
  formattedMessages: ContextMessage[];
  existingSummary?: string | null;
  aiService: Summarizer;
}): Promise<ContextWindowResult> {
  if (!formattedMessages?.length) {
    return {
      summary: existingSummary ?? null,
      summaryChanged: false,
      messages: [],
    };
  }

  const { dropped, kept } = splitByBudget(formattedMessages);

  if (dropped.length === 0) {
    return {
      summary: existingSummary ?? null,
      summaryChanged: false,
      messages: kept,
    };
  }

  const newSummary = await summarizeDropped(aiService, existingSummary, dropped);

  return {
    summary: newSummary || existingSummary || null,
    summaryChanged: Boolean(newSummary),
    messages: kept,
  };
}
