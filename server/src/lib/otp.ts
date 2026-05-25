import crypto from "crypto";

// In-memory OTP store — fine for the single-instance server. Move to
// Postgres/Redis if the server ever runs multi-instance.

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const RESEND_INTERVAL_MS = 60 * 1000;

interface OtpRecord {
  codeHash: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}

const store = new Map<string, OtpRecord>(); // keyed by lowercase email

function hashOtp(code: string): string {
  return crypto.createHash("sha256").update(code.trim()).digest("hex");
}

type IssueResult = { ok: true; code: string } | { ok: false; reason: "throttled" };
type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "expired" | "too_many_attempts" };

/** Generate a 6-digit OTP for `email`, stored hashed. Throttled to 1 send/min per email. */
export function issueOtp(email: string): IssueResult {
  const key = email.toLowerCase();
  const now = Date.now();

  // Evict dead records so the map can't grow forever on a long-lived server.
  for (const [k, rec] of store) {
    if (now > rec.expiresAt) store.delete(k);
  }

  const existing = store.get(key);
  if (existing && now - existing.lastSentAt < RESEND_INTERVAL_MS) {
    return { ok: false, reason: "throttled" };
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  store.set(key, {
    codeHash: hashOtp(code),
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: now,
  });
  return { ok: true, code };
}

/** Single-use verify: wrong codes count toward MAX_VERIFY_ATTEMPTS, then the OTP is dead. */
export function verifyOtp(email: string, code: string): VerifyResult {
  const key = email.toLowerCase();
  const rec = store.get(key);
  if (!rec || Date.now() > rec.expiresAt) {
    store.delete(key);
    return { ok: false, reason: "expired" };
  }

  if (rec.attempts >= MAX_VERIFY_ATTEMPTS) {
    store.delete(key);
    return { ok: false, reason: "too_many_attempts" };
  }

  rec.attempts += 1;
  if (rec.codeHash !== hashOtp(code)) {
    return { ok: false, reason: "invalid" };
  }

  store.delete(key);
  return { ok: true };
}

/** Test-only: clear all pending OTPs. */
export function resetForTests(): void {
  store.clear();
}
