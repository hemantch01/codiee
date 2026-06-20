#!/usr/bin/env node

import dotenv from "dotenv";

import { Command } from "commander";

import { printLogo } from "./ui/banner.js";
import { logout, whoami } from "./commands/auth/login.js";
import { wakeUp } from "./commands/ai/wakeUp.js";
import { config } from "./commands/config.js";
import { conversations } from "./commands/conversations.js";
import { indexCommand } from "./commands/index.js";
import { applyStoredTheme } from "../config/themes.js";

dotenv.config({ quiet: true });

const VERSION = "1.0.0";

async function main() {
  // Activate configured theme before rendering anything styled
  await applyStoredTheme();

  printLogo(VERSION);

  const program = new Command("codiee");

  program.version(VERSION).description("Codiee - AI coding assistant in your terminal");

  // Add commands (auth happens inside `codiee wakeup` via the Login/Signup picker)
  program.addCommand(wakeUp);
  program.addCommand(logout);
  program.addCommand(whoami);
  program.addCommand(config);
  program.addCommand(conversations);
  program.addCommand(indexCommand);

  // Default action shows help
  program.action(() => {
    program.help();
  });

  program.parse();
}

main().catch((error) => {
  console.error("Error running Codiee:", error);
  process.exit(1);
});
