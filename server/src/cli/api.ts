import dotenv from "dotenv";
import { getStoredToken } from "./token-store.js";

// Module-load env read — load .env before SERVER_URL is computed.
dotenv.config({ quiet: true });

export const SERVER_URL = process.env.CODIEE_SERVER_URL || "http://localhost:3005";

export interface ApiResponse<T = Record<string, any>> {
  ok: boolean;
  status: number;
  data: T;
}

/** JSON request to the Codiee server with the stored session token (if any). */
export async function api<T = Record<string, any>>(
  path: string,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<ApiResponse<T>> {
  const token = await getStoredToken();
  const headers: Record<string, string> = {};
  if (token?.access_token) headers.authorization = `Bearer ${token.access_token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  try {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, status: res.status, data };
  } catch (error: any) {
    // Network-level failure — surface as a non-OK response, never throw.
    return {
      ok: false,
      status: 0,
      data: { error: error?.message ?? "Could not reach the Codiee server" } as T,
    };
  }
}
