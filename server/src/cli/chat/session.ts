import chalk from "chalk";
import { marked } from "marked";
import { AIService } from "../ai/ai-service.js";
import { api } from "../api.js";
import { applyStoredTheme, applyMarkdownTheme, t } from "../../config/themes.js";
import { printSessionHeader, printGoodbye } from "../ui/banner.js";
import {
  userMessage,
  errorBox,
  warningBox,
  responseHeader,
  responseFooter,
  chatInput,
  spinner as makeSpinner,
} from "../ui/cards.js";
import {
  getProjectContext,
  type ProjectContextResult,
} from "../../lib/project-context.js";
import {
  buildContextWindow,
  estimateTokens,
  CONTEXT_LIMITS,
} from "../../lib/context-manager.js";
import type { AIMessage } from "../ai/ai-service.js";

/**
 * Codiee chat session — one persistent chat box with the AI, backed by a
 * server-side conversation so sessions can be resumed later.
 */

const aiService = new AIService();

// Session state
let projectContext: ProjectContextResult | null = null;
let currentUser: SessionUser | null = null;

type SessionUser = { id: string; name: string };

interface ApiConversation {
  id: string;
  userId: string;
  title: string | null;
  mode: string;
  summary?: string | null;
  messages: { role: string; content: string }[];
}

async function getUserFromToken(): Promise<SessionUser> {
  const spin = makeSpinner("Authenticating...").start();
  const res = await api<{ user?: { id: string; name: string } }>("/api/me");
  spin.stop();

  if (!res.ok || !res.data.user?.id) {
    throw new Error("Session invalid — please run 'codiee wakeup' to log in again.");
  }
  return { id: res.data.user.id, name: res.data.user.name || "user" };
}

async function initConversation(conversationId: string | null) {
  const spin = makeSpinner("Loading conversation...").start();
  const res = await api<{ conversation: ApiConversation; error?: string }>("/api/conversations", {
    method: "POST",
    body: { mode: "chat", conversationId },
  });
  spin.stop();

  if (!res.ok) throw new Error(res.data.error || "Could not load conversation");

  return res.data.conversation;
}

function printAIErrorBox(error: any) {
  const msg = String(error?.message ?? error);

  // Our own pacing error — NOT a provider quota problem. Check first:
  // "Rate limiter: ..." contains "rate limit", which would otherwise
  // misclassify as a quota failure.
  if (/^Rate limiter:/i.test(msg)) {
    console.log(
      warningBox(
        t.warning("⏳ Pacing: bohot requests ek minute mein.\n") +
          chalk.gray(
            "Aapke requests pace ho rahe hain — thodi der baad message bhejo. Kuch nahi bigda."
          )
      )
    );
    return;
  }

  const isQuota = /quota|RESOURCE_EXHAUSTED|\b429\b/i.test(msg);
  if (isQuota) {
    console.log(
      errorBox(
        t.error("🚫 AI provider quota hit.\n") +
          chalk.gray(
            "Options:\n" +
              "  • Wait for the limit to reset (daily caps reset midnight Pacific)\n" +
              "  • Link billing in AI Studio for Tier 1 limits"
          ),
        "🚫 Quota"
      )
    );
    return;
  }

  console.log(errorBox(t.error(`❌ AI request failed: ${msg}`)));
}

async function getAIResponse(conversationId: string) {
  const spin = makeSpinner("AI is thinking...").start();

  const convoRes = await api<{ conversation: ApiConversation; error?: string }>(
    `/api/conversations/${conversationId}`
  );
  if (!convoRes.ok) {
    throw new Error(convoRes.data.error || "Could not load conversation history");
  }

  const formatted = convoRes.data.conversation.messages.map((m) => ({
    role: m.role,
    content: String(m.content),
  }));

  const windowed = await buildContextWindow({
    formattedMessages: formatted,
    existingSummary: convoRes.data.conversation.summary ?? null,
    aiService,
  });

  if (windowed.summaryChanged && windowed.summary) {
    // Best-effort persistence so resumed sessions keep their memory
    await api(`/api/conversations/${conversationId}`, {
      method: "PATCH",
      body: { summary: windowed.summary },
    });
  }

  // Assemble system context blocks (never persisted as messages)
  const systemBlocks: string[] = [];
  if (projectContext?.context) systemBlocks.push(projectContext.context);
  if (windowed.summary) {
    systemBlocks.push(
      `Running summary of earlier parts of this conversation:\n${windowed.summary}`
    );
  }

  const aiMessages: AIMessage[] = [
    ...systemBlocks.map((content) => ({ role: "system", content })),
    ...windowed.messages,
  ];

  let fullResponse = "";
  let isFirstChunk = true;

  try {
    const result = await aiService.sendMessage(aiMessages, (chunk) => {
      // Stop spinner on first chunk and show themed response header
      if (isFirstChunk) {
        spin.stop();
        console.log(responseHeader());
        isFirstChunk = false;
      }
      fullResponse += chunk;
    });

    // Render the complete markdown response + themed usage footer
    console.log("\n");
    const renderedMarkdown = marked.parse(fullResponse) as string;
    console.log(renderedMarkdown);
    const promptTokens =
      result.usage?.promptTokens ?? result.usage?.inputTokens ?? 0;
    const completionTokens =
      result.usage?.completionTokens ?? result.usage?.outputTokens ?? 0;
    const windowTokens = windowed.messages.reduce(
      (sum, m) => sum + estimateTokens(String(m.content ?? "")),
      0
    );
    console.log(
      responseFooter(
        aiService.label,
        promptTokens,
        completionTokens,
        windowTokens,
        CONTEXT_LIMITS.maxHistoryTokens
      )
    );
    console.log("\n");

    return result.content;
  } catch (error) {
    spin.error("Failed to get AI response");
    throw error;
  }
}

async function updateConversationTitle(conversationId: string, userInput: string, messageCount: number) {
  if (messageCount === 1) {
    const title = userInput.slice(0, 50) + (userInput.length > 50 ? "..." : "");
    await api(`/api/conversations/${conversationId}`, { method: "PATCH", body: { title } });
  }
}

/* ---------------- Main loop ---------------- */

async function chatLoop(conversation: { id: string }) {
  while (true) {
    const userInput = (await chatInput("💬 [chat] · type 'exit' to leave", "chat")).trim();
    if (!userInput) continue;

    // Plain "exit" ends the session
    if (userInput.toLowerCase() === "exit") {
      console.log("\n" + warningBox(t.warning("Chat session ended. Goodbye! 👋")));
      break;
    }

    console.log(userMessage(userInput));

    const saved = await api<{ count?: number }>(`/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      body: { role: "user", content: userInput },
    });

    // AI response — a failed request must not crash the session
    let aiResponse: string;
    try {
      aiResponse = await getAIResponse(conversation.id);
    } catch (error) {
      printAIErrorBox(error);
      continue;
    }

    await api(`/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      body: { role: "assistant", content: aiResponse },
    });

    // Update title if first exchange
    await updateConversationTitle(conversation.id, userInput, saved.data?.count ?? 0);
  }
}

// Main entry point
export async function startSession(conversationId: string | null = null) {
  try {
    await applyStoredTheme();
    applyMarkdownTheme(marked);

    printSessionHeader("chat", aiService.label);

    const user = await getUserFromToken();
    currentUser = user;
    const conversation = await initConversation(conversationId);

    // Attach project context ("Codiee knows your code")
    const ctxSpinner = makeSpinner("Scanning project...").start();
    try {
      const ctx = await getProjectContext();
      if (ctx) {
        projectContext = ctx;
        ctxSpinner.stop(); // silent attach
      } else {
        projectContext = null;
        ctxSpinner.stop();
      }
    } catch {
      projectContext = null;
      ctxSpinner.warning("Could not scan project — continuing without context");
    }

    await chatLoop(conversation);

    printGoodbye("chat");
  } catch (error) {
    console.log(errorBox(t.error(`❌ Error: ${error.message}`)));
    process.exit(1);
  }
}
