import chalk from "chalk";
import readline from "readline";
import boxen from "boxen";
import yoctoSpinner from "yocto-spinner";
import { t } from "../../config/themes.js";

/**
 * Codiee card system — the one place defining how every message, box and
 * divider looks. Theme-aware, left-aligned, full terminal width.
 */

function termWidth(): number {
  return process.stdout.columns || 80;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Terminal display width: ANSI escapes stripped; emoji (cp >= 0x1F000) count as 2 cells. */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp >= 0x1f000 ? 2 : 1;
  }
  return w;
}

/** Build boxen options with the heading rendered in the border line. */
function titleOpts(heading: string | undefined, extra: Record<string, any> = {}): Record<string, any> {
  if (!heading) return extra;
  return { ...extra, title: ` ${heading} `, titleAlignment: "left" };
}

/** Themed horizontal divider, optionally with a label. */
function divider(label?: string): string {
  const width = Math.min(60, termWidth());
  const line = !label
    ? t.muted("─".repeat(width))
    : t.muted("─".repeat(Math.max(2, Math.floor((width - displayWidth(label) - 4) / 2)))) +
      chalk.gray(` ${label} `) +
      t.muted("─".repeat(Math.max(2, Math.floor((width - displayWidth(label) - 4) / 2))));
  return line;
}

/** User message — prompt-bar style: `▌ text`. */
export function userMessage(text: string): string {
  const bar = t.infoBold("▌");
  return `\n${bar} ${chalk.white(text.trim())}\n`;
}

/** Generic info card (session details, commands list, etc.). */
export function infoBox(body: string, title?: string): string {
  return boxen(body, {
    width: termWidth(),
    padding: 1,
    borderStyle: "round",
    borderColor: t.border(),
    ...titleOpts(title),
  });
}

/** Tool call card — what the AI asked to run. */
export function toolCallCard(lines: string[]): string {
  return boxen(lines.join("\n"), {
    width: termWidth(),
    padding: 1,
    borderStyle: "round",
    borderColor: t.color("accent"),
    ...titleOpts("Tool Calls"),
  });
}

/** Tool result card — what came back. */
export function toolResultCard(lines: string[]): string {
  return boxen(lines.join("\n"), {
    width: termWidth(),
    padding: 1,
    borderStyle: "round",
    borderColor: t.color("success"),
    ...titleOpts("Tool Results"),
  });
}

/** Error card — request failures, quota guidance, etc. */
export function errorBox(body: string, title = "Error"): string {
  return boxen(body, {
    width: termWidth(),
    padding: 1,
    borderStyle: "round",
    borderColor: t.color("error"),
    ...titleOpts(title),
  });
}

/** Warning card (non-fatal notes: pacing, RAG unavailable, etc.). */
export function warningBox(body: string): string {
  return boxen(body, {
    width: termWidth(),
    padding: 1,
    borderStyle: "round",
    borderColor: t.color("warning"),
  });
}

/** Success card (confirmations, model switched, etc.). */
export function successBox(body: string, title?: string): string {
  return boxen(body, {
    width: termWidth(),
    padding: 1,
    borderStyle: "round",
    borderColor: t.color("success"),
    ...titleOpts(title),
  });
}

/** Single configured spinner — theme color, consistent behavior. */
export function spinner(text: string) {
  return yoctoSpinner({ text, color: "cyan" });
}

/** Stream header for a live assistant response. */
export function responseHeader(): string {
  return `\n${divider("🤖 Codiee")}\n`;
}

/** Stream footer: usage + context-window meter shown after each response. */
export function responseFooter(
  modelLabel: string,
  promptTokens: number,
  completionTokens: number,
  windowTokens = 0,
  windowBudget = 0
): string {
  let footer =
    divider() +
    "\n" +
    t.muted(`  ⚡ ${modelLabel} · ↑ ${promptTokens} prompt · ↓ ${completionTokens} completion tokens`);
  if (windowBudget > 0) {
    footer +=
      "\n" +
      t.muted(
        `  🧠 context: ${windowTokens.toLocaleString("en-IN")} / ${windowBudget.toLocaleString("en-IN")} tokens (history window)`
      );
  }
  return footer;
}

/** Boxless chat input: muted hint line, then a clean `❯` prompt owned via readline. */
export function chatInput(label: string, mode = "chat"): Promise<string> {
  return new Promise((resolve) => {
    console.log(t.muted(label));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${mode} ❯ `,
    });
    rl.prompt();

    const finish = (line: string) => {
      rl.close();
      resolve(line);
    };

    rl.on("line", finish);
    rl.on("SIGINT", () => {
      console.log("\n" + warningBox(t.warning("Chat session ended. Goodbye! 👋")));
      process.exit(0);
    });
  });
}

/** One-off readline input with a mode prefix (e.g. "agent ❯ "). */
export function promptLine(prefix: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${prefix} ❯ `,
    });
    rl.prompt();

    const finish = (line: string) => {
      rl.close();
      resolve(line.trim());
    };

    rl.on("line", finish);
    rl.on("SIGINT", () => {
      console.log(warningBox(t.warning("Cancelled. Goodbye! 👋")));
      process.exit(0);
    });
  });
}
