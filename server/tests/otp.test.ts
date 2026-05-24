import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let otp: typeof import("../src/lib/otp.js");

beforeEach(async () => {
  vi.useFakeTimers();
  otp = await import("../src/lib/otp.js");
  otp.resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

function wrongCodeFor(issued: { ok: true; code: string } | { ok: false; reason: string }): string {
  return issued.ok && issued.code === "000000" ? "000001" : "000000";
}

describe("otp store", () => {
  it("issues a 6-digit code that verifies exactly once", () => {
    const issued = otp.issueOtp("user@example.com");
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.code).toMatch(/^\d{6}$/);
    expect(otp.verifyOtp("user@example.com", issued.code)).toEqual({ ok: true });
    expect(otp.verifyOtp("user@example.com", issued.code).ok).toBe(false);
  });

  it("rejects a wrong code without consuming the OTP", () => {
    const issued = otp.issueOtp("user@example.com");
    if (!issued.ok) throw new Error("issue failed");
    expect(otp.verifyOtp("user@example.com", wrongCodeFor(issued)).ok).toBe(false);
    expect(otp.verifyOtp("user@example.com", issued.code)).toEqual({ ok: true });
  });

  it("expires after 10 minutes", () => {
    const issued = otp.issueOtp("user@example.com");
    if (!issued.ok) throw new Error("issue failed");
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(otp.verifyOtp("user@example.com", issued.code)).toEqual({ ok: false, reason: "expired" });
  });

  it("locks out after 5 wrong attempts", () => {
    const issued = otp.issueOtp("user@example.com");
    if (!issued.ok) throw new Error("issue failed");
    const wrong = wrongCodeFor(issued);
    for (let i = 0; i < 5; i++) {
      expect(otp.verifyOtp("user@example.com", wrong).ok).toBe(false);
    }
    expect(otp.verifyOtp("user@example.com", issued.code)).toEqual({
      ok: false,
      reason: "too_many_attempts",
    });
  });

  it("throttles resend within a minute", () => {
    expect(otp.issueOtp("user@example.com").ok).toBe(true);
    expect(otp.issueOtp("user@example.com")).toEqual({ ok: false, reason: "throttled" });
    vi.advanceTimersByTime(60_001);
    expect(otp.issueOtp("user@example.com").ok).toBe(true);
  });
});
