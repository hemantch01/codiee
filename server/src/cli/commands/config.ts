import chalk from "chalk";
import { Command } from "commander";
import { intro, outro, select, password, isCancel, cancel } from "@clack/prompts";
import {
  loadConfig,
  loadProjectConfig,
  findProjectConfigPath,
  saveConfig,
  PROVIDERS,
} from "../../config/ai.config.js";
import {
  THEMES,
  THEME_NAMES,
  isValidTheme,
  setActiveTheme,
} from "../../config/themes.js";

/**
 * `codiee config` — manage provider/model/API key/theme from the terminal
 */

const PROJECT_TAG = ".codiee.json";

function themePreview(name: string): string {
  const theme = THEMES[name];
  if (!theme) return name;
  const c = theme.colors;
  return (
    chalk[c.primary]("primary") +
    " " +
    chalk[c.secondary]("secondary") +
    " " +
    chalk[c.accent]("accent") +
    " " +
    chalk[c.warning]("warning") +
    " " +
    chalk.gray(`(border: ${c.border})`)
  );
}

async function configShow() {
  const cfg = await loadConfig();
  const providerMeta = PROVIDERS.find((p) => p.id === cfg.provider);
  const projectPath = await findProjectConfigPath();
  const projectOverrides = await loadProjectConfig();
  const overriddenKeys = Object.keys(projectOverrides);

  const sourceTag = (field) =>
    projectPath && overriddenKeys.includes(field)
      ? ` ${chalk.magenta(`← override via ${PROJECT_TAG}`)}`
      : "";

  console.log(
    chalk.cyan.bold("\n⚙️  Codiee Configuration\n") +
      chalk.gray("─".repeat(40)) +
      `\n${chalk.bold("Provider:")}`.padEnd(20) +
      `${cfg.provider} ${chalk.gray(`(${providerMeta?.name || "unknown"})`)}` +
      sourceTag("provider") +
      `\n${chalk.bold("Model:")}`.padEnd(19) +
      `${cfg.model}` +
      sourceTag("model") +
      `\n${chalk.bold("API key:")}`.padEnd(18) +
      `${cfg.apiKey ? chalk.green("•".repeat(12) + " (set)") : chalk.yellow("(not set — using env)")}` +
      sourceTag("apiKey") +
      `\n${chalk.bold("Theme:")}`.padEnd(19) +
      `${cfg.theme}${isValidTheme(cfg.theme) ? "" : chalk.red(" (invalid — falling back to dark)")}` +
      sourceTag("theme") +
      "\n"
  );

  console.log(
    chalk.gray("\nAvailable themes:") +
      "\n" +
      THEME_NAMES.map(
        (name) => " ".repeat(18) + `${name.padEnd(8)} ${themePreview(name)}`
      ).join("\n") +
      "\n"
  );

  if (projectPath) {
    console.log(
      chalk.gray(
        `Per-project overrides loaded from: ${projectPath}\nEdit that file (or delete it) to change this repo's settings.\n`
      )
    );
  }
}

async function configSetInteractive() {
  const provider = await select({
    message: "Select AI provider:",
    options: PROVIDERS.map((p) => ({
      value: p.id,
      label: p.name,
      hint: p.hint,
    })),
  });
  if (isCancel(provider)) {
    cancel("Cancelled");
    return;
  }

  const meta = PROVIDERS.find((p) => p.id === provider);
  if (!meta) {
    cancel("Unknown provider");
    return;
  }
  const model = await select({
    message: `Select a ${meta.name} model:`,
    options: meta.models.map((m) => ({ value: m.id, label: m.name })),
  });
  if (isCancel(model)) {
    cancel("Cancelled");
    return;
  }

  let apiKey;
  if (meta.requiresKey) {
    apiKey = await password({
      message: `${meta.name} API key (leave blank to use env)`,
    });
    if (isCancel(apiKey)) {
      cancel("Cancelled");
      return;
    }
  }

  const theme = await select({
    message: "Select a color theme:",
    options: THEME_NAMES.map((name) => ({
      value: name,
      label: THEMES[name].label,
      hint: `${THEMES[name].colors.primary} / ${THEMES[name].colors.secondary} / ${THEMES[name].colors.accent}`,
    })),
  });
  if (isCancel(theme)) {
    cancel("Cancelled");
    return;
  }

  const next = await saveConfig({
    provider,
    model,
    theme,
    ...(apiKey ? { apiKey } : {}),
  });
  setActiveTheme(theme);

  outro(
    chalk.green(
      `✅ Saved! Active model: ${chalk.bold(`${next.provider}:${next.model}`)} · theme: ${chalk.bold(next.theme)}\n` +
        chalk.gray(`Config stored in ~/.codiee/config.json`)
    )
  );
}

const setConfig = new Command("set")
  .description("Set a config value (e.g. codiee config set model gemini-3.6-flash)")
  .argument("<key>", "provider | model | key | theme")
  .argument("<value>", "value to set")
  .action(async (key, value) => {
    const map = {
      provider: "provider",
      model: "model",
      key: "apiKey",
      apikey: "apiKey",
      theme: "theme",
    };
    const field = map[key.toLowerCase()];
    if (!field) {
      console.log(chalk.red(`Unknown key "${key}". Valid keys: provider, model, key, theme`));
      process.exit(1);
    }

    // Validate provider against known providers
    if (field === "provider" && !PROVIDERS.some((p) => p.id === value)) {
      console.log(
        chalk.red(`Unknown provider "${value}". Valid providers: ${PROVIDERS.map((p) => p.id).join(", ")}`)
      );
      process.exit(1);
    }

    // Validate theme and show a live color preview
    if (field === "theme" && !isValidTheme(value)) {
      console.log(
        chalk.red(`Unknown theme "${value}". Available themes:\n`) +
          THEME_NAMES.map((name) => `  • ${name.padEnd(8)} ${themePreview(name)}`).join("\n")
      );
      process.exit(1);
    }

    const next = await saveConfig({ [field]: value });

    if (field === "theme") {
      setActiveTheme(value); // apply immediately in this session
      console.log(
        chalk.green(`✅ Theme set to ${chalk.bold(value)}\n`) +
          chalk.gray("Preview: ") +
          themePreview(value) +
          "\n" +
          chalk.gray(`Applied. Active: ${next.provider}:${next.model}`)
      );
      return;
    }

    console.log(
      chalk.green(`✅ ${field} set to ${chalk.bold(value)}\n`) +
        chalk.gray(`Active: ${next.provider}:${next.model}`)
    );
  });

const getCommand = new Command("get")
  .description("Show current configuration")
  .action(configShow);

export const config = new Command("config")
  .description("Manage Codiee configuration (provider, model, key, theme)")
  .addCommand(setConfig)
  .addCommand(getCommand)
  .action(async () => {
    intro(chalk.bold.cyan("⚙️  Codiee Configuration"));
    await configSetInteractive();
  });
