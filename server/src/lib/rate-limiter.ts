/**
 * Client-side rate limiting for AI provider calls — proactive pacing, no retries.
 * Buckets: chat (CODIEE_CHAT_RPM_LIMIT, default 8), embed (CODIEE_EMBED_RPM_LIMIT, default 90).
 */

type Bucket = "chat" | "embed";

const WINDOW_MS = 60_000;
const DEFAULT_LIMITS: Record<Bucket, number> = { chat: 8, embed: 90 };

const ENV_VARS: Record<Bucket, string> = {
  chat: "CODIEE_CHAT_RPM_LIMIT",
  embed: "CODIEE_EMBED_RPM_LIMIT",
};

/** Request timestamps inside the current sliding window, per bucket. */
const recent: Map<Bucket, number[]> = new Map();

function limitFor(bucket: Bucket): number {
  const raw = process.env[ENV_VARS[bucket]];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMITS[bucket];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a free slot in the bucket; throws if `maxWaitMs` is exceeded. */
export async function acquire(bucket: Bucket, maxWaitMs = 120_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    const now = Date.now();
    const window = (recent.get(bucket) ?? []).filter((t) => now - t < WINDOW_MS);

    if (window.length < limitFor(bucket)) {
      window.push(now);
      recent.set(bucket, window);
      return;
    }

    // Oldest request in the window dictates how long until a slot frees up.
    const waitNeeded = WINDOW_MS - (now - window[0]) + 5;
    if (now + waitNeeded > deadline) {
      throw new Error(
        `Rate limiter: "${bucket}" bucket busy (${limitFor(bucket)}/min for ${Math.round(
          maxWaitMs / 1000
        )}s) — try again shortly`
      );
    }
    await sleep(Math.min(waitNeeded, 1_000));
  }
}

/** Test-only: clear all buckets so tests start with an empty window. */
export function resetForTests(): void {
  recent.clear();
}
