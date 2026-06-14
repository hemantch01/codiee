/**
 * Quota client for the Codiee CLI — talks to the server's quota API with the
 * stored session token. Degrades gracefully (allows the request) when the
 * server is unreachable.
 */

import dotenv from "dotenv";
import { getStoredToken } from "../cli/token-store.js";

// Module-load time reads CODIEE_SERVER_URL — load .env before it does.
dotenv.config({ quiet: true });

const SERVER_URL =
  (typeof process !== "undefined" && process.env.CODIEE_SERVER_URL) ||
  "http://localhost:3005";

export interface QuotaStatus {
  limit: number;
  used: number;
  remaining: number;
  periodEnd?: string;
}

export interface CheckResult {
  /** true when the user may proceed with an AI request */
  allowed: boolean;
  status: QuotaStatus | null;
}

async function authHeaders(): Promise<Record<string, string> | null> {
  const token = await getStoredToken();
  if (!token?.access_token) return null;
  return { authorization: `Bearer ${token.access_token}` };
}

/**
 * Ask the server whether the user has quota left for another AI request.
 * Network/auth failures resolve to `{ allowed: true, status: null }`.
 */
export async function checkQuota(): Promise<CheckResult> {
  const headers = await authHeaders();
  if (!headers) return { allowed: true, status: null };

  try {
    const res = await fetch(`${SERVER_URL}/api/quota`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { allowed: true, status: null };

    const status = (await res.json()) as QuotaStatus;
    return {
      allowed: Number(status.remaining) > 0,
      status,
    };
  } catch {
    // Server down / offline — never block on infrastructure problems
    return { allowed: true, status: null };
  }
}

/**
 * Report token usage to the server after an AI response completes.
 * Returns the outcome, or null when reporting wasn't possible.
 */
export async function reportUsage(input: {
  promptTokens?: number;
  completionTokens?: number;
  conversationId?: string;
  model?: string;
}): Promise<{ allowed: boolean; remaining: number } | null> {
  const headers = await authHeaders();
  if (!headers) return null;

  try {
    const res = await fetch(`${SERVER_URL}/api/usage/record`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { allowed: boolean; remaining: number };
  } catch {
    return null;
  }
}
