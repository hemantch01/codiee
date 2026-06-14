import { spawn } from "child_process";
import chalk from "chalk";
import { confirm, isCancel } from "@clack/prompts";

const MAX_TIMEOUT_MS = 180000; // 3 min per command
const BLOCKED_PATTERNS = [
  /\brm\s+-rf?\s+[/~]/, // destructive deletes on root/home
  /mkfs|dd\s+if=/,
  /\bsudo\b/,
  />\s*\/dev\/sd/,
];

/** Sandbox-safe setup-command runner for Agent Mode: asks before every
 * command, blocks clearly dangerous patterns, enforces a hard timeout. */
export async function offerToRunSetupCommands(commands: string[] = [], cwd: string = process.cwd()): Promise<void> {
  const runnable = (commands || []).filter(Boolean);
  if (runnable.length === 0) return;

  console.log(
    chalk.cyan.bold("\n🖥️  Sandbox Setup Runner") +
      chalk.gray("\nThe agent suggested these commands. Each one requires your approval.\n")
  );

  for (const cmd of runnable) {
    if (BLOCKED_PATTERNS.some((p) => p.test(cmd))) {
      console.log(chalk.red(`🚫 Blocked potentially dangerous command: ${cmd}`));
      continue;
    }

    const shouldRun = await confirm({
      message: chalk.white(`Run ${chalk.bold(cmd)} ?`),
      initialValue: false,
    });
    if (isCancel(shouldRun) || !shouldRun) {
      console.log(chalk.gray(`⏭️  Skipped: ${cmd}`));
      continue;
    }

    console.log(chalk.gray(`\n$ ${cmd}\n`));
    const ok = await runSandboxedCommand(cmd, cwd);
    if (!ok) {
      console.log(
        chalk.yellow("\n⏹️  Command failed — skipping remaining setup commands. Re-run them manually.\n")
      );
      return;
    }
  }
}

function runSandboxedCommand(cmd: string, cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "inherit", "inherit"],
      timeout: MAX_TIMEOUT_MS,
    });

    child.on("error", (err) => {
      console.log(chalk.red(`\n❌ Failed to start: ${err.message}\n`));
      resolve(false);
    });

    child.on("timeout", () => {
      child.kill("SIGKILL");
      console.log(chalk.yellow(`\n⏱️  Timed out after ${MAX_TIMEOUT_MS / 1000}s\n`));
      resolve(false);
    });

    child.on("close", (code) => {
      if (code === 0) {
        console.log(chalk.green(`\n✅ Finished: ${cmd}\n`));
      } else {
        console.log(chalk.yellow(`\n⚠️  Exited with code ${code}: ${cmd}\n`));
      }
      resolve(code === 0);
    });
  });
}
