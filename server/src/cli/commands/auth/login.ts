import { cancel, confirm, intro, isCancel, outro, password, select, text } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import dotenv from "dotenv";
import { EMAIL_RE } from "../../../lib/email.js";
import { authClient } from "../../auth-client.js";
import { api } from "../../api.js";
import {
  clearStoredToken,
  getStoredToken,
  storeToken,
  type StoredToken,
} from "../../token-store.js";

dotenv.config({ quiet: true });

const SERVER_URL = process.env.CODIEE_SERVER_URL || "http://localhost:3005";

// Token storage lives in cli/token-store.ts — re-exported here so the
// historical import path (`cli/commands/auth/login.js`) keeps working.

export { clearStoredToken, getStoredToken, storeToken };
export type { StoredToken };

async function runAuthPicker(): Promise<void> {
  intro(chalk.bold.cyan("🔐 Welcome to Codiee"));
  const choice = await select({
    message: "You're not logged in. What would you like to do?",
    options: [
      { value: "login", label: "🔑 Login" },
      { value: "signup", label: "✨ Create a new account" },
    ],
  });
  if (isCancel(choice)) {
    cancel("Cancelled");
    process.exit(1);
  }
  if (choice === "signup") {
    await signupAction();
  } else {
    await loginAction();
  }
}

export async function requireAuth(): Promise<StoredToken & { access_token: string }> {
  let token = await getStoredToken();
  if (!token?.access_token) {
    await runAuthPicker();
    token = await getStoredToken();
    if (!token?.access_token) {
      console.log(chalk.red("❌ Login/signup cancelled — run `codiee wakeup` to try again."));
      process.exit(1);
    }
  }
  return token as StoredToken & { access_token: string };
}

// Shared credential prompts

async function promptCredentials() {
  const email = await text({
    message: "Email",
    placeholder: "you@example.com",
    validate(value) {
      if (!value || value.trim().length === 0) return "Email is required";
      if (!EMAIL_RE.test(value.trim())) return "Enter a valid email address";
    },
  });
  if (isCancel(email)) {
    cancel("Cancelled");
    process.exit(0);
  }

  const pass = await password({
    message: "Password",
    validate(value) {
      if (!value || value.length < 8) return "Password must be at least 8 characters";
    },
  });
  if (isCancel(pass)) {
    cancel("Cancelled");
    process.exit(0);
  }

  return { email: email.trim(), passwordValue: pass };
}

// Login

export async function loginAction() {
  intro(chalk.bold.cyan("🔐 Codiee Login"));

  console.log(chalk.gray(`Auth server: ${SERVER_URL}\n`));

  const { email, passwordValue } = await promptCredentials();

  console.log(chalk.gray("Signing you in..."));

  const { data, error } = await authClient.signIn.email({
    email,
    password: passwordValue,
  });

  if (error || !data?.token) {
    outro(
      chalk.red(
        `❌ Login failed: ${error?.message || "Invalid credentials"}\n` +
          chalk.gray("New here? Pick \u2728 Signup instead (re-run `codiee wakeup`)")
      )
    );
    process.exit(1);
  }

  await storeToken(data);

  outro(
    chalk.green.bold(
      `✅ Welcome back, ${data.user?.name || data.user?.email || "user"}! You're logged in.`
    )
  );
}

// Signup

async function postJson(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, ok: res.ok, data };
}

async function promptOtpCode(email: string): Promise<string> {
  for (;;) {
    const code = await text({
      message: `Verification code sent to ${email} — paste it here (or 'r' to resend)`,
      validate(value) {
        const v = (value || "").trim();
        if (v.toLowerCase() !== "r" && !/^\d{6}$/.test(v)) {
          return "Enter the 6-digit code (or 'r' to resend)";
        }
      },
    });
    if (isCancel(code)) {
      cancel("Cancelled");
      process.exit(0);
    }
    const v = (code as string).trim();
    if (v.toLowerCase() !== "r") return v;

    const resent = await postJson("/api/auth/signup/send-otp", { email });
    if (resent.ok) {
      console.log(chalk.green("📧 Code resent — inbox check karo."));
    } else {
      console.log(chalk.yellow(resent.data.error || "Could not resend right now — try again shortly."));
    }
  }
}

export async function signupAction() {
  intro(chalk.bold.cyan("✨ Create your Codiee account"));

  console.log(chalk.gray(`Auth server: ${SERVER_URL}\n`));

  const emailInput = await text({
    message: "Email",
    placeholder: "you@example.com",
    validate(value) {
      if (!value || !EMAIL_RE.test(value.trim())) {
        return "Enter a valid email address";
      }
    },
  });
  if (isCancel(emailInput)) {
    cancel("Cancelled");
    process.exit(0);
  }
  const email = emailInput.trim().toLowerCase();

  console.log(chalk.gray("Sending verification code..."));
  const sent = await postJson("/api/auth/signup/send-otp", { email });
  if (sent.status === 409) {
    const toLogin = await confirm({
      message: "Ye email already registered hai. Login karna hai?",
      initialValue: true,
    });
    if (!isCancel(toLogin) && toLogin) {
      await loginAction();
      return;
    }
    outro(chalk.gray("Signup cancelled."));
    return;
  }
  if (!sent.ok) {
    outro(chalk.red(`❌ Could not send verification code: ${sent.data.error || sent.status}`));
    process.exit(1);
  }
  console.log(chalk.green(`📧 Code ${email} pe bhej diya (10 min valid).`));

  let otp = await promptOtpCode(email);

  const pass = await password({
    message: "Password (min 8 characters)",
    validate(value) {
      if (!value || value.length < 8) return "Password must be at least 8 characters";
    },
  });
  if (isCancel(pass)) {
    cancel("Cancelled");
    process.exit(0);
  }

  console.log(chalk.gray("Verifying & creating your account..."));

  for (;;) {
    const done = await postJson("/api/auth/signup/complete", { email, otp, password: pass });
    if (done.ok && done.data.token) {
      await storeToken(done.data);
      outro(
        chalk.green.bold(
          `🎉 Account created & logged in as ${done.data.user?.email || email}! Happy building.`
        )
      );
      return;
    }
    if (/invalid or expired/i.test(String(done.data.error ?? ""))) {
      console.log(chalk.red("❌ Code galat ya expire ho gaya — dobara paste karo."));
      otp = await promptOtpCode(email);
      continue;
    }
    outro(chalk.red(`❌ Signup failed: ${done.data.error || done.status}`));
    process.exit(1);
  }
}

// Logout

export async function logoutAction() {
  intro(chalk.bold("👋 Codiee Logout"));

  const token = await getStoredToken();

  if (!token) {
    console.log(chalk.yellow("You're not logged in."));
    process.exit(0);
  }

  const shouldLogout = await confirm({
    message: "Are you sure you want to logout?",
    initialValue: false,
  });

  if (isCancel(shouldLogout) || !shouldLogout) {
    cancel("Logout cancelled");
    process.exit(0);
  }

  // Best-effort server-side revoke
  try {
    await authClient.signOut();
  } catch {
    // ignore network errors — local token removal is what matters
  }

  const cleared = await clearStoredToken();

  if (cleared) {
    outro(chalk.green("✅ Successfully logged out!"));
  } else {
    console.log(chalk.yellow("⚠️  Could not clear token file."));
  }
}

// Whoami

export async function whoamiAction() {
  await requireAuth();

  const res = await api<{
    user?: { id: string; name: string; email: string; createdAt: string };
  }>("/api/me");
  const user = res.data.user;
  if (!res.ok || !user) {
    console.log(chalk.red("Session no longer valid. Please run `codiee wakeup` to log in again."));
    process.exit(1);
  }

  console.log(
    chalk.bold.greenBright(
      `\n👤 User: ${user.name}\n📧 Email: ${user.email}\n🆔 ID: ${user.id}\n📅 Member since: ${new Date(user.createdAt).toLocaleDateString()}\n`
    )
  );
}

// Commander setup — auth flows are reached via `codiee wakeup`'s picker;
// no standalone login/signup commands.

export const logout = new Command("logout")
  .description("Logout and clear stored credentials")
  .action(logoutAction);

export const whoami = new Command("whoami")
  .description("Show current authenticated user")
  .action(whoamiAction);

