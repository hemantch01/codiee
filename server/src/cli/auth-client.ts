import { createAuthClient } from "better-auth/client";

/**
 * Better Auth client used by the Codiee CLI (terminal-only, no browser)
 */
export const authClient = createAuthClient({
  baseURL: process.env.CODIEE_SERVER_URL || "http://localhost:3005",
});
