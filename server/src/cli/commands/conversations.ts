import chalk from "chalk";
import { Command } from "commander";
import fs from "fs/promises";
import path from "path";
import { intro, outro, select, confirm, isCancel, cancel } from "@clack/prompts";
import { requireAuth } from "./auth/login.js";
import { api } from "../api.js";

/**
 * `codiee conversations` — list / manage past conversations
 * `codiee conversations export` — save a conversation as Markdown
 */

interface ApiConversationSummary {
  id: string;
  title: string | null;
  mode: string;
  updatedAt: string;
  messages: { content: string }[];
}

interface ApiConversationFull {
  id: string;
  title: string | null;
  mode: string;
  createdAt: string;
  messages: { role: string; content: string }[];
}

async function getCurrentUser() {
  await requireAuth();
  const res = await api<{ user?: { id: string } }>("/api/me");
  if (!res.ok || !res.data.user?.id) return null;
  return { id: res.data.user.id };
}

function formatRelative(date: Date | string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export async function conversationsAction(): Promise<void> {
  const user = await getCurrentUser();
  if (!user) {
    console.log(chalk.red("Session invalid — `codiee wakeup` se dobara login/signup karo."));
    process.exit(1);
  }

  const res = await api<{ conversations: ApiConversationSummary[]; error?: string }>("/api/conversations");
  if (!res.ok) {
    outro(chalk.red(res.data.error || "Could not load conversations."));
    return;
  }
  const conversations = res.data.conversations;

  intro(chalk.bold.cyan("💬 Your Conversations"));

  if (conversations.length === 0) {
    outro(chalk.yellow("No conversations yet. Run `codiee wakeup` to start one!"));
    return;
  }

  const MODE_ICON = { chat: "💬", tool: "🛠️ " };
  for (const c of conversations) {
    const icon = MODE_ICON[c.mode] || "•";
    const preview = c.messages[0]?.content?.slice(0, 60).replace(/\n/g, " ") || "";
    console.log(
      chalk.white(`${icon} ${chalk.bold(c.title || "(untitled)")}`) +
        chalk.gray(`  [${c.mode}] ${formatRelative(c.updatedAt)} · id: ${c.id}`) +
        (preview ? chalk.gray(`\n     ↳ ${preview}…`) : "")
    );
  }
  console.log(chalk.gray(`\n${conversations.length} conversation(s). Resume the latest: codiee wakeup --continue\n`));
}

export async function exportAction(
  conversationIdArg: string | undefined,
  opts: { output?: string }
): Promise<void> {
  const user = await getCurrentUser();
  if (!user) {
    console.log(chalk.red("Session invalid — `codiee wakeup` se dobara login/signup karo."));
    process.exit(1);
  }

  // Pick a conversation interactively if no ID given
  let conversationId = conversationIdArg;
  if (!conversationId) {
    const list = await api<{ conversations: ApiConversationSummary[] }>("/api/conversations?take=20");
    const conversations = list.data.conversations ?? [];
    if (conversations.length === 0) {
      console.log(chalk.yellow("Nothing to export yet."));
      return;
    }
    const picked = await select({
      message: "Export which conversation?",
      options: conversations.map((c) => ({
        value: c.id,
        label: c.title || "(untitled)",
        hint: `[${c.mode}] ${formatRelative(c.updatedAt)}`,
      })),
    });
    if (isCancel(picked)) {
      cancel("Export cancelled");
      return;
    }
    conversationId = picked;
  }

  const res = await api<{ conversation: ApiConversationFull }>(`/api/conversations/${conversationId}`);
  if (!res.ok || !res.data.conversation) {
    console.log(chalk.red("Conversation not found."));
    process.exit(1);
  }
  const conversation = res.data.conversation;

  const safeTitle = (conversation.title || "conversation").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const fileName = opts.output || `codiee-${safeTitle}-${conversation.id.slice(0, 8)}.md`;

  let md = `# ${conversation.title || "Codiee Conversation"}\n\n`;
  md += `- **Mode:** ${conversation.mode}\n- **Started:** ${new Date(conversation.createdAt).toLocaleString()}\n`;
  md += `- **Messages:** ${conversation.messages.length}\n\n---\n`;

  for (const msg of conversation.messages) {
    const who =
      msg.role === "user" ? "🙋 **You**" : msg.role === "assistant" ? "🤖 **Codiee**" : `⚙️ **${msg.role}**`;
    md += `\n## ${who}\n\n${msg.content}\n`;
  }

  await fs.writeFile(path.join(process.cwd(), fileName), md, "utf-8");
  outro(chalk.green(`📄 Exported to ${chalk.bold(fileName)}`));
}

const exportCommand = new Command("export")
  .description("Export a conversation to Markdown")
  .argument("[conversation-id]", "ID of the conversation (omit to pick interactively)")
  .option("-o, --output <file>", "Output .md file name")
  .action(exportAction);

const clearCommand = new Command("clear")
  .description("Delete a conversation")
  .argument("<conversation-id>", "ID of the conversation to delete")
  .action(async (id: string) => {
    const user = await getCurrentUser();
    if (!user) {
      console.log(chalk.red("Session invalid — `codiee wakeup` se dobara login/signup karo."));
      process.exit(1);
    }
    const ok = await confirm({ message: chalk.yellow("Permanently delete this conversation?"), initialValue: false });
    if (isCancel(ok) || !ok) {
      cancel("Deletion cancelled");
      return;
    }
    const res = await api(`/api/conversations/${id}`, { method: "DELETE" });
    if (res.ok) {
      outro(chalk.green("🗑️  Conversation deleted."));
    } else {
      outro(chalk.red("Conversation not found."));
    }
  });

export const conversations = new Command("conversations")
  .description("List your saved conversations")
  .addCommand(exportCommand)
  .addCommand(clearCommand)
  .action(conversationsAction);
