import chalk from "chalk";
import { select, text, password, isCancel, cancel } from "@clack/prompts";
import type { AIService } from "../ai/ai-service.js";
import {
  loadConfig,
  saveConfig,
  PROVIDERS,
  resolveProviderKey,
} from "../../config/ai.config.js";
import { t } from "../../config/themes.js";
import { infoBox, successBox, promptLine } from "../ui/cards.js";

/**
 * In-chat slash commands — the primary way to drive Codiee from inside the
 * session. Capabilities come in via the context object (no circular imports).
 */

const CHAT_COMMANDS = [
  { name: "/models", description: "Change or set the AI provider & model" },
  { name: "/chat", description: "Switch to plain chat mode (no tools)" },
  { name: "/toolcall", description: "Pick tools and switch to tool-calling mode" },
  { name: "/agent <description>", description: "Generate a complete app from a description" },
  { name: "/help", description: "Show this command list" },
  { name: "/exit", description: "End the session" },
] as const;

type SlashResult = "handled" | "exit" | "not-a-command";

interface SessionContext {
  aiService: AIService;
  setMode(mode: "chat" | "tool"): Promise<void>;
  runAgent(description: string): Promise<void>;
  openToolPicker(): Promise<boolean>;
}

/** Styled help: command in bold accent, explanation in plain white. */
function printHelp() {
  const lines = CHAT_COMMANDS.map(
    (c) => `  ${t.accentBold(c.name.padEnd(22))} ${chalk.white(c.description)}`
  ).join("\n");
  console.log(infoBox(lines, "Commands"));
}

/** `/models` — cascading picker: provider → model → API key if required.
 * Persists via saveConfig() and hot-reloads the AIService. */
async function modelsCommand(aiService: AIService): Promise<void> {
  const cfg = await loadConfig();

  const providerId = await select({
    message: `Select provider (current: ${cfg.provider})`,
    options: (PROVIDERS as readonly any[]).map((p) => ({
      value: p.id,
      label: p.id === cfg.provider ? `${p.name}  ·current` : p.name,
      hint: p.hint,
    })),
  });
  if (isCancel(providerId)) {
    cancel("Switch cancelled");
    return;
  }

  const meta = (PROVIDERS as readonly any[]).find((p) => p.id === providerId);
  if (!meta) return;

  const modelChoice = await select({
    message: `Select a ${meta.name} model`,
    options: [
      ...(meta.models as any[]).map((m) => ({
        value: m.id,
        label: m.name,
        hint: m.id,
      })),
      { value: "__custom__", label: "Custom model ID…", hint: "type any model id" },
    ],
  });
  if (isCancel(modelChoice)) {
    cancel("Switch cancelled");
    return;
  }

  let model = String(modelChoice);
  if (model === "__custom__") {
    const custom = await text({
      message: "Model ID",
      placeholder: "e.g. qwen/qwen3-coder-30b",
      validate(value) {
        if (!value || !value.trim()) return "Model ID is required";
      },
    });
    if (isCancel(custom) || !custom?.trim()) {
      cancel("Switch cancelled");
      return;
    }
    model = custom.trim();
  }

  // Ask for the key only when this provider needs one and we don't have it yet
  let keyUpdate: Record<string, any> = {};
  if (meta.requiresKey && !resolveProviderKey(cfg, meta.id)) {
    const key = await password({
      message: meta.keyEnv
        ? `${meta.name} API key (or set ${meta.keyEnv} in .env)`
        : `${meta.name} API key`,
    });
    if (isCancel(key)) {
      cancel("Switch cancelled");
      return;
    }
    if (!key?.trim()) {
      console.log(chalk.yellow("⚠️  No key entered — provider switch cancelled"));
      return;
    }
    keyUpdate = { [meta.keyField]: key.trim() };
  }

  const next = await saveConfig({ provider: meta.id, model, ...keyUpdate });
  aiService.reloadConfig();

  console.log(
    successBox(
      `${chalk.green("✅ Active model:")} ${chalk.bold(`${next.provider}:${next.model}`)}` +
        (meta.id !== "google"
          ? `\n${chalk.gray("Note: RAG embeddings & tool-mode still need Gemini when available.")}`
          : ""),
      "🔁 Model switched"
    )
  );
}

/** `/agent` — ask for a description when none was provided inline. */
async function agentCommand(ctx: SessionContext, args: string): Promise<void> {
  let description = args.trim();
  if (!description) {
    console.log(t.muted("Describe the app you want (e.g. a tiny todo CLI app)"));
    const asked = await promptLine("agent");
    if (!asked) {
      cancel("Agent cancelled");
      return;
    }
    description = asked;
  }
  await ctx.runAgent(description);
}

/**
 * Route a user input that starts with "/". Returns:
 *  - "handled"       → command ran (or was cancelled); loop should continue
 *  - "exit"          → /exit requested; loop should end
 *  - "not-a-command" → input was not a slash command; treat as a message
 */
export async function handleChatCommand(
  input: string,
  ctx: SessionContext
): Promise<SlashResult> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return "not-a-command";

  const parts = trimmed.slice(1).split(/\s+/);
  const name = (parts[0] || "").toLowerCase();
  const args = parts.slice(1).join(" ").trim();

  switch (name) {
    case "models":
      await modelsCommand(ctx.aiService);
      return "handled";
    case "chat":
      await ctx.setMode("chat");
      return "handled";
    case "toolcall":
    case "tools": {
      const picked = await ctx.openToolPicker();
      if (picked) await ctx.setMode("tool");
      return "handled";
    }
    case "agent":
      await agentCommand(ctx, args);
      return "handled";
    case "help":
      printHelp();
      return "handled";
    case "exit":
      return "exit";
    default:
      console.log(
        infoBox(
          chalk.red(`Unknown command: ${chalk.bold("/" + name)}\n`) +
            chalk.gray(`Type ${chalk.bold("/help")} to see all commands`),
          "Commands"
        )
      );
      return "handled";
  }
}
