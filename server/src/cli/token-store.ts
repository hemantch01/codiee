import fs from "fs/promises";
import path from "path";
import chalk from "chalk";
import { CONFIG_DIR } from "../config/ai.config.js";

// Local session-token storage (~/.codiee/token.json).

const TOKEN_FILE = path.join(CONFIG_DIR, "token.json");

export interface StoredToken {
  access_token?: string;
  created_at?: string;
  [key: string]: any;
}

export async function getStoredToken(): Promise<StoredToken | null> {
  try {
    const data = await fs.readFile(TOKEN_FILE, "utf-8");
    return JSON.parse(data) as StoredToken;
  } catch {
    return null;
  }
}

export async function storeToken(session: any): Promise<boolean> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });

    const tokenData = {
      access_token: session.token,
      created_at: new Date().toISOString(),
    };

    // Owner-only permissions: this file holds a live session token.
    await fs.writeFile(TOKEN_FILE, JSON.stringify(tokenData, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    // Fix perms on files written by older versions (world-readable)
    await fs.chmod(TOKEN_FILE, 0o600);
    return true;
  } catch (error) {
    console.error(chalk.red("Failed to store token:"), error.message);
    return false;
  }
}

export async function clearStoredToken() {
  try {
    await fs.unlink(TOKEN_FILE);
    return true;
  } catch {
    return false;
  }
}
