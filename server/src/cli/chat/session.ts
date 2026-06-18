import chalk from "chalk";
import { cancel, confirm, isCancel } from "@clack/prompts";
import { marked } from "marked";
import { AIService } from "../ai/ai-service.js";
import { api } from "../api.js";
import { applyStoredTheme, applyMarkdownTheme, t } from "../../config/themes.js";
import { printSessionHeader, printGoodbye } from "../ui/banner.js";
import {
  userMessage,
  infoBox,
  errorBox,
  warningBox,
  toolCallCard,
  toolResultCard,
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
import { checkQuota, reportUsage } from "../../lib/quota-client.js";
import { formatChunksAsContext } from "../../lib/rag-client.js";
import { handleChatCommand } from "./slash-commands.js";
import {
  availableTools,
  getEnabledTools,
  enableTools,
  getEnabledToolNames,
  resetTools,
} from "../../config/tool.config.js";
import { generateApplication } from "../../config/agent.config.js";
import { offerToRunSetupCommands } from "../../lib/sandbox.js";
import type { AIMessage } from "../ai/ai-service.js";

/**
 * Unified Codiee session — ONE chat box for everything.
 * Modes are switched from inside the box via slash commands:
 *   /chat (plain chat) · /toolcall (tools picker) · /agent <description>
 */

const aiService = new AIService();

// Session state
let projectContext: ProjectContextResult | null = null;
let sessionMode: "chat" | "tool" = "chat";
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
    body: { mode: sessionMode, conversationId },
  });
  spin.stop();

  if (!res.ok) throw new Error(res.data.error || "Could not load conversation");

  // Resume: an old conversation's mode becomes the session's starting mode
  sessionMode = res.data.conversation.mode === "tool" ? "tool" : "chat";

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
              "  • Link billing in AI Studio for Tier 1 limits\n" +
              "  • Type /models to switch provider (OpenRouter / NVIDIA / Ollama)"
          ),
        "🚫 Quota"
      )
    );
    return;
  }

  console.log(errorBox(t.error(`❌ AI request failed: ${msg}`)));
}

async function getAIResponse(
  conversationId: string,
  query: string | null = null,
  useTools = false
) {
  const spin = makeSpinner("AI is thinking...").start();

  // Server-side quota enforcement. Graceful: when the server is unreachable
  // (offline / Ollama users) the request proceeds.
  const quotaCheck = await checkQuota();
  if (!quotaCheck.allowed) {
    spin.stop();
    const status = quotaCheck.status;
    const resetInfo = status?.periodEnd
      ? new Date(status.periodEnd).toLocaleDateString()
      : "next month";
    console.log(
      errorBox(
        t.error(
          `🚫 Monthly token quota exceeded.\n` +
            `Used ${status?.used ?? "?"} / ${status?.limit ?? "?"} tokens. Resets ${resetInfo}.`
        ),
        "🚫 Quota"
      )
    );
    return (
      "I can't respond right now — your monthly token quota is exhausted. " +
      "Your limit resets at the start of next month."
    );
  }

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

  // RAG: retrieve relevant project chunks for this specific question.
  // Fail-open on the server side — chunks: [] on any failure.
  let ragContext: string | null = null;
  if (query && projectContext?.root && currentUser) {
    const searchRes = await api<{ chunks: { filePath: string; chunkIndex: number; content: string; score: number }[] }>(
      "/api/rag/search",
      { method: "POST", body: { query, rootPath: projectContext.root } }
    );
    const chunks = searchRes.data.chunks ?? [];
    ragContext = formatChunksAsContext(chunks);
    if (ragContext) {
      spin.text = `Grounding answer with ${chunks.length} code excerpts...`;
    }
  }

  // Assemble system context blocks (never persisted as messages)
  const systemBlocks: string[] = [];
  if (projectContext?.context) systemBlocks.push(projectContext.context);
  if (ragContext) systemBlocks.push(ragContext);
  if (windowed.summary) {
    systemBlocks.push(
      `Running summary of earlier parts of this conversation:\n${windowed.summary}`
    );
  }

  const aiMessages: AIMessage[] = [
    ...systemBlocks.map((content) => ({ role: "system", content })),
    ...windowed.messages,
  ];

  // Native Google tools only execute on Google's infrastructure — skip them
  // for any other provider (openrouter / nvidia / ollama).
  const nativeToolsSupported = aiService.config.provider === "google";
  const tools = useTools && nativeToolsSupported ? getEnabledTools() : undefined;
  if (useTools && !nativeToolsSupported) {
    console.log(
      warningBox(
        chalk.yellow(
          "⚠️  Native tools (search/code-exec) need Gemini — running without tools for this provider."
        )
      )
    );
  }

  let fullResponse = "";
  let isFirstChunk = true;
  const toolCallsDetected: any[] = [];

  try {
    const result = await aiService.sendMessage(
      aiMessages,
      (chunk) => {
        // Stop spinner on first chunk and show themed response header
        if (isFirstChunk) {
          spin.stop();
          console.log(responseHeader());
          isFirstChunk = false;
        }
        fullResponse += chunk;
      },
      tools,
      (toolCall) => {
        toolCallsDetected.push(toolCall);
      }
    );

    // Tool calls / results cards
    if (toolCallsDetected.length > 0) {
      console.log(
        toolCallCard(
          toolCallsDetected.map((tc) =>
            `${chalk.cyan("🔧 Tool:")} ${tc.toolName}\n${chalk.gray("Args:")} ${JSON.stringify(tc.args, null, 2)}`
          )
        )
      );
    }
    if (result.toolResults && result.toolResults.length > 0) {
      console.log(
        toolResultCard(
          result.toolResults.map((tr: any) =>
            `${chalk.green("✅ Tool:")} ${tr.toolName}\n${chalk.gray("Result:")} ${JSON.stringify(tr.result, null, 2).slice(0, 200)}...`
          )
        )
      );
    }

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

    // Track quota usage server-side
    await reportUsage({
      promptTokens,
      completionTokens,
      conversationId,
      model: aiService.label,
    });

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

/* ---------------- Mode switching & flows ---------------- */

async function setMode(mode: "chat" | "tool", conversationId: string) {
  sessionMode = mode;
  // Best-effort persistence for resume-correctness
  await api(`/api/conversations/${conversationId}`, { method: "PATCH", body: { mode } });
  console.log(
    infoBox(
      mode === "tool"
        ? `${chalk.bold("Mode:")} 🛠️  Tool Calling\n${chalk.gray("Enabled tools: " + (getEnabledToolNames().join(", ") || "none"))}`
        : `${chalk.bold("Mode:")} 💬 Plain Chat\n${chalk.gray("Tools disabled")}`,
      "🔁 Mode switched"
    )
  );
}

/** Tools multiselect — returns true when tools were picked (tool mode on). */
async function openToolPicker(): Promise<boolean> {
  const { multiselect } = await import("@clack/prompts");
  const toolOptions = availableTools.map((tool) => ({
    value: tool.id,
    label: tool.name,
    hint: tool.description,
  }));

  const selected = await multiselect({
    message: chalk.cyan("Select tools (Space to select, Enter to confirm):"),
    options: toolOptions,
    required: false,
  });
  if (isCancel(selected)) {
    cancel("Tool selection cancelled");
    return false;
  }

  enableTools(selected as string[]);
  return true;
}

/** /agent <description> — inline app generation, then back to chat. */
async function runAgentFlow(description: string): Promise<void> {
  if (!description.trim()) {
    console.log(warningBox(chalk.yellow("Usage: /agent <description>\ne.g. /agent a tiny todo CLI app")));
    return;
  }

  const spin = makeSpinner("Generating application...").start();
  try {
    // RAG: review the user's project so the result fits their stack
    let projectInsight: string | null = null;
    if (projectContext?.root && currentUser) {
      const searchRes = await api<{ chunks: { filePath: string; chunkIndex: number; content: string; score: number }[] }>(
        "/api/rag/search",
        { method: "POST", body: { query: description, rootPath: projectContext.root } }
      );
      projectInsight = formatChunksAsContext(searchRes.data.chunks ?? []);
    }
    spin.stop();

    console.log(userMessage(description));
    const result = await generateApplication(
      description,
      aiService,
      process.cwd(),
      projectInsight
    );

    if (result.success && result.commands.length > 0) {
      const runSetup = await confirm({
        message: chalk.cyan("Run the setup commands now?"),
        initialValue: false,
      });
      if (!isCancel(runSetup) && runSetup) {
        await offerToRunSetupCommands(result.commands, process.cwd());
      } else {
        console.log("\n" + chalk.yellow("👋 Skip karo — commands baad mein manually chala lena.") + "\n");
      }
    }
  } catch (error: any) {
    spin.stop();
    printAIErrorBox(error);
  }
}

/* ---------------- Main loop ---------------- */

async function chatLoop(conversation: { id: string }) {
  while (true) {
    const label =
      sessionMode === "tool"
        ? "🛠️ [tool] · /help for help"
        : "💬 [chat] · /help for help";

    const userInput = (await chatInput(label, sessionMode)).trim();
    if (!userInput) continue;

    // Slash commands — never sent to the AI
    const slashResult = await handleChatCommand(userInput, {
      aiService,
      setMode: (m: "chat" | "tool") => setMode(m, conversation.id),
      runAgent: runAgentFlow,
      openToolPicker,
    });
    if (slashResult === "handled") continue;

    // /exit (via slash command) and plain "exit" both end the session
    if (slashResult === "exit" || userInput.toLowerCase() === "exit") {
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
      aiResponse = await getAIResponse(conversation.id, userInput, sessionMode === "tool");
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

    // Re-print header chip if resume changed the starting mode
    if (sessionMode === "tool") {
      console.log(warningBox(chalk.yellow("Resumed in 🛠️ tool mode — /chat to switch back")));
    }

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

    resetTools(); // start clean; /toolcall picks fresh

    await chatLoop(conversation);

    printGoodbye(sessionMode);
  } catch (error) {
    console.log(errorBox(t.error(`❌ Error: ${error.message}`)));
    process.exit(1);
  }
}
