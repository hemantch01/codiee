import chalk from "chalk";
import figlet from "figlet";
import { t } from "../../config/themes.js";

/**
 * Codiee brand identity — banners, session headers, goodbyes.
 * Everything renders left-aligned at column 0 (user preference).
 */

const LOGO_TEXT = "CODIEE";
const LOGO_FONT = "ANSI Shadow";
const FALLBACK_FONT = "Standard";

export type Mode = "chat" | "tool";

const MODE_META: Record<Mode, { label: string }> = {
  chat: { label: "CHAT" },
  tool: { label: "TOOL CALLING" },
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible length of a string, ignoring ANSI escape sequences. */
function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/** Render lines at column 0 (left-aligned block). */
function printBlock(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

/** Compact one-line wordmark for session headers / goodbyes. */
function compactLogo(): string {
  return `${t.accentBold("◆ ")}${t.primaryBold("CODIEE")}`;
}

/** Full startup banner: big ASCII wordmark + tagline + version. */
export function printLogo(version = "1.0.0"): void {
  let art: string;
  try {
    art = figlet.textSync(LOGO_TEXT, { font: LOGO_FONT });
  } catch {
    art = figlet.textSync(LOGO_TEXT, { font: FALLBACK_FONT });
  }

  const artLines = art.split("\n").filter((l) => l.trim().length > 0);
  const artWidth = Math.max(...artLines.map(visibleLen));

  const shaded = artLines.map((line, i) =>
    i % 2 === 0 ? t.primary(line) : t.accent(line)
  );

  const tagline =
    t.muted("⚡ terminal-native AI coding companion") +
    chalk.gray(`  ·  v${version}`);

  const hr = t.muted("─".repeat(Math.min(artWidth, 48)));

  console.log(); // breathing room between startup noise and the logo
  printBlock([...shaded, "", tagline, hr]);
  console.log();
}

/** Session header for chat / tool / agent modes (left-aligned). */
export function printSessionHeader(mode: Mode, model: string): void {
  const meta = MODE_META[mode];
  const chip = chalk.bgBlack.bold(`[ ${meta.label} ]`);

  printBlock([
    compactLogo(),
    `${t.info(chip)} ${chalk.gray("·")} ${t.muted(model)}`,
    t.muted("─".repeat(40)),
  ]);
  console.log();
}

/** Consistent themed goodbye for every mode. */
export function printGoodbye(mode: Mode): void {
  const meta = MODE_META[mode];
  console.log(
    t.success(`✨ ${meta.label.toLowerCase()} session complete `) + compactLogo()
  );
  console.log();
}
