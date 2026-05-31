import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  splitByBudget,
  buildContextWindow,
  CONTEXT_LIMITS,
  type ContextMessage,
} from "../src/lib/context-manager.js";

function makeMessages(n: number, charsPerMessage = 1000): ContextMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: "m".repeat(charsPerMessage) + ` #${i}`,
  }));
}

describe("estimateTokens", () => {
  it("estimates ~1 token per 4 characters", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("returns 0 for empty input", () => {
    expect(estimateTokens("")).toBe(0);
    // @ts-expect-error testing runtime guard
    expect(estimateTokens(undefined)).toBe(0);
  });
});

describe("splitByBudget", () => {
  it("keeps the newest messages that fit the budget", () => {
    const msgs = makeMessages(40); // ~10k tokens total
    // Explicit budget: tests must not depend on the tunable CONTEXT_LIMITS default
    const { dropped, kept } = splitByBudget(msgs, 6000);

    expect(kept.length).toBeGreaterThan(0);
    expect(dropped.length + kept.length).toBe(40);
    // Kept messages must be a contiguous tail of the history
    expect(kept[kept.length - 1]).toBe(msgs[msgs.length - 1]);
    expect(dropped[0]).toBe(msgs[0]);
  });

  it("never drops below minRecentMessages even when over budget", () => {
    const huge = makeMessages(CONTEXT_LIMITS.minRecentMessages, 20000); // way over budget
    const { dropped, kept } = splitByBudget(huge);
    expect(kept.length).toBe(CONTEXT_LIMITS.minRecentMessages);
    expect(dropped.length).toBe(0);
  });

  it("respects a custom budget", () => {
    const msgs = makeMessages(10); // ~2500 tokens
    const { kept } = splitByBudget(msgs, 500);
    expect(kept.length).toBeLessThan(10);
  });

  it("returns everything when under budget", () => {
    const msgs = makeMessages(4, 100); // tiny
    const { dropped, kept } = splitByBudget(msgs);
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(4);
  });
});

describe("buildContextWindow", () => {
  it("passes through short conversations without summarizing", async () => {
    const msgs = makeMessages(5, 50);
    const result = await buildContextWindow({
      formattedMessages: msgs,
      existingSummary: null,
      aiService: { getMessage: async () => "SHOULD_NOT_BE_CALLED" },
    });

    expect(result.messages).toHaveLength(5);
    expect(result.summaryChanged).toBe(false);
    expect(result.summary).toBeNull();
  });

  it("summarizes dropped messages and merges with existing summary", async () => {
    let summarizeCalls = 0;
    const fakeAI = {
      getMessage: async (messages: ContextMessage[]) => {
        summarizeCalls++;
        expect(messages[0].role).toBe("system");
        return `SUMMARY_V${summarizeCalls}`;
      },
    };

    const result = await buildContextWindow({
      formattedMessages: makeMessages(40, 5000), // ~50k tokens — way over budget
      existingSummary: "OLD_SUMMARY",
      aiService: fakeAI,
    });

    expect(summarizeCalls).toBe(1);
    expect(result.summaryChanged).toBe(true);
    expect(result.summary).toBe("SUMMARY_V1");
    expect(result.messages.length).toBeLessThan(40);
  });

  it("handles empty history", async () => {
    const result = await buildContextWindow({
      formattedMessages: [],
      existingSummary: null,
      aiService: { getMessage: async () => "X" },
    });
    expect(result.messages).toHaveLength(0);
  });
});
