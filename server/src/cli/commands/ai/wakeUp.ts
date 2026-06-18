import chalk from "chalk";
import { Command } from "commander";
import yoctoSpinner from "yocto-spinner";
import { clearStoredToken, requireAuth } from "../auth/login.js";
import { api, SERVER_URL } from "../../api.js";
import { startSession } from "../../chat/session.js";

const wakeUpAction = async (opts: { continue?: boolean } | undefined) => {
  await requireAuth();

  const spinner = yoctoSpinner({ text: "Fetching User Information..." });
  spinner.start();

  let me = await api<{ user?: { id: string; name: string } }>("/api/me");

  // Server unreachable ≠ session invalid — different problem, different fix
  if (me.status === 0) {
    spinner.stop();
    console.log(chalk.red(`⚠️ Codiee server tak nahi pahunch rahe (${SERVER_URL})`));
    console.log(chalk.gray("Server chalao: cd server && npm run dev — phir dobara `codiee wakeup`"));
    return;
  }

  // Stale/invalid local token → clear it; requireAuth() re-opens the login/signup picker
  if (!me.ok || !me.data.user?.id) {
    spinner.stop();
    await clearStoredToken();
    await requireAuth();
    spinner.start();
    me = await api<{ user?: { id: string; name: string } }>("/api/me");
  }

  spinner.stop();

  if (!me.ok || !me.data.user?.id) {
    console.log(chalk.red("Session invalid — dobara login/signup karo, phir `codiee wakeup`."));
    return;
  }

  console.log("\n" + chalk.green(`Welcome back, ${me.data.user.name}!`));

  // --continue: resume the most recent conversation (its mode is restored)
  if (opts?.continue) {
    spinner.start("Finding your last conversation...");
    const list = await api<{ conversations: { id: string; title: string | null; mode: string }[] }>(
      "/api/conversations?take=1"
    );
    spinner.stop();

    const last = list.data.conversations?.[0];
    if (last) {
      console.log(
        chalk.cyan(`↩️  Resuming ${chalk.bold(last.title || "(untitled)")} [${last.mode}]`)
      );
      await startSession(last.id);
      return;
    }
    console.log("\n" + chalk.yellow("No previous conversations found — starting fresh.") + "\n");
  }

  // Unified session: one chat box, modes switched via slash commands
  await startSession();
};

export const wakeUp = new Command("wakeup")
  .description("Wake up Codiee AI")
  .option("-c, --continue", "Resume your most recent conversation", false)
  .action(wakeUpAction);
