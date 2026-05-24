import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// No os/temp-home mocking needed — the limiter only touches its own state.
let limiter: typeof import("../src/lib/rate-limiter.js");

beforeEach(async () => {
  vi.useFakeTimers();
  process.env.CODIEE_CHAT_RPM_LIMIT = "3"; // small bucket = easy to test
  limiter = await import("../src/lib/rate-limiter.js");
  limiter.resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CODIEE_CHAT_RPM_LIMIT;
});

describe("rate limiter", () => {
  it("allows a burst up to the bucket limit without waiting", async () => {
    const p1 = limiter.acquire("chat");
    const p2 = limiter.acquire("chat");
    const p3 = limiter.acquire("chat");
    await Promise.all([p1, p2, p3]); // no timer advance needed → no waiting
    expect(true).toBe(true); // reached without throwing
  });

  it("makes the next request wait until a slot slides out of the window", async () => {
    await Promise.all([
      limiter.acquire("chat"),
      limiter.acquire("chat"),
      limiter.acquire("chat"),
    ]);

    let resolved = false;
    const fourth = limiter.acquire("chat").then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(resolved).toBe(false); // still inside the 60s window

    await vi.advanceTimersByTimeAsync(55_100);
    await fourth; // oldest entries expired → slot freed
    expect(resolved).toBe(true);
  });

  it("throws (single clean error) when waiting exceeds maxWaitMs", async () => {
    await Promise.all([
      limiter.acquire("chat"),
      limiter.acquire("chat"),
      limiter.acquire("chat"),
    ]);

    await expect(limiter.acquire("chat", 1_000)).rejects.toThrow(/bucket busy/);
  });

  it("keeps buckets independent (chat vs embed)", async () => {
    // chat bucket is full at 3
    await Promise.all([
      limiter.acquire("chat"),
      limiter.acquire("chat"),
      limiter.acquire("chat"),
    ]);
    // embed bucket has its own limit (default 90) → must not wait
    await limiter.acquire("embed");
    await limiter.acquire("embed");
    expect(true).toBe(true);
  });

  it("expires old requests: after 60s the full limit is available again", async () => {
    await Promise.all([
      limiter.acquire("chat"),
      limiter.acquire("chat"),
      limiter.acquire("chat"),
    ]);
    await vi.advanceTimersByTimeAsync(60_100);
    await Promise.all([
      limiter.acquire("chat"),
      limiter.acquire("chat"),
      limiter.acquire("chat"),
    ]);
    expect(true).toBe(true);
  });
});
