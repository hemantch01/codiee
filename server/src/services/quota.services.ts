import prisma from "../lib/db.js";

/** Server-side monthly token quota — one counter row per user, auto-reset on
 * month rollover. Limit: QUOTA_MONTHLY_TOKENS (default 500k). */

export interface QuotaSnapshot {
  limit: number;
  used: number;
  remaining: number;
  requests: number;
  periodStart: Date;
  periodEnd: Date;
}

const DEFAULT_MONTHLY_TOKENS = 500_000;

function monthlyLimit(): number {
  const parsed = Number(process.env.QUOTA_MONTHLY_TOKENS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MONTHLY_TOKENS;
}

/** First instant of the current calendar month (local time). */
function currentPeriodStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
}

/** First instant of the next calendar month — when the quota resets. */
function currentPeriodEnd(): Date {
  const start = currentPeriodStart();
  return new Date(start.getFullYear(), start.getMonth() + 1, 1, 0, 0, 0, 0);
}

/** Get the user's quota snapshot, resetting the counter when the period rolled over. */
export async function getQuota(userId: string): Promise<QuotaSnapshot> {
  const limit = monthlyLimit();
  const periodStart = currentPeriodStart();
  const periodEnd = currentPeriodEnd();

  let row = await prisma.usageCounter.findUnique({ where: { userId } });

  // Auto-reset on month rollover
  if (row && row.periodStart < periodStart) {
    await prisma.usageCounter.update({
      where: { userId },
      data: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        requests: 0,
        periodStart,
      },
    });
    row = null;
  }

  if (!row) {
    return {
      limit,
      used: 0,
      remaining: limit,
      requests: 0,
      periodStart,
      periodEnd,
    };
  }

  const used = Number(row.totalTokens);
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    requests: row.requests,
    periodStart: row.periodStart,
    periodEnd,
  };
}

export interface UsageReportInput {
  promptTokens?: number;
  completionTokens?: number;
  conversationId?: string;
  model?: string;
}

type RecordOutcome = "recorded" | "blocked" | "already_over";

/**
 * Atomically increment the user's counters and enforce the quota. Usage is
 * recorded while tokens remain (the request that crosses the line still
 * counts); with remaining already 0, nothing is added and "already_over" is returned.
 */
export async function recordUsage(
  userId: string,
  input: UsageReportInput
): Promise<{ outcome: RecordOutcome; quota: QuotaSnapshot }> {
  const before = await getQuota(userId);

  if (before.remaining <= 0) {
    return { outcome: "already_over", quota: before };
  }

  const prompt = Math.max(0, Math.floor(Number(input.promptTokens ?? 0)));
  const completion = Math.max(0, Math.floor(Number(input.completionTokens ?? 0)));
  const total = prompt + completion;

  const periodStart = currentPeriodStart();

  // Atomic upsert-increment guarded by the current period.
  await prisma.usageCounter.upsert({
    where: { userId },
    create: {
      userId,
      promptTokens: BigInt(prompt),
      completionTokens: BigInt(completion),
      totalTokens: BigInt(total),
      requests: 1,
      periodStart,
    },
    update: {
      promptTokens: { increment: BigInt(prompt) },
      completionTokens: { increment: BigInt(completion) },
      totalTokens: { increment: BigInt(total) },
      requests: { increment: 1 },
      // If the row belongs to an older period, restart it from this report.
      ...(before.used === 0 ? { periodStart } : {}),
    },
  });

  const after = await getQuota(userId);
  return { outcome: "recorded", quota: after };
}
