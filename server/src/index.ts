import "./lib/env.js";
import express from "express";
import { auth } from "./lib/auth.js";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pathToFileURL } from "url";
import { pinoHttp } from "pino-http";
import prisma from "./lib/db.js";
import { logger } from "./lib/logger.js";
import { getQuota, recordUsage, type UsageReportInput } from "./services/quota.services.js";
import { ChatService } from "./services/chat.services.js";
import { issueOtp, verifyOtp } from "./lib/otp.js";
import { sendOtpEmail } from "./lib/mailer.js";
import { EMAIL_RE } from "./lib/email.js";
import {
  diffIndexedFiles,
  upsertChunks,
  deleteIndexedFiles,
  clearIndex,
  getIndexStats,
} from "./lib/rag-store.js";
import { retrieveRelevantChunks } from "./lib/retriever.js";

const chatService = new ChatService();

export const app = express();
const port = Number(process.env.PORT || 3005);

app.use(helmet());

app.use(
  pinoHttp({
    logger,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie"],
      censor: "[REDACTED]",
    },
  })
);

// Rate limiters (per IP). Health/readiness probes are exempt so monitoring
// and orchestrators can poll freely.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts — try again later." },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded — slow down." },
});

// Signup via email OTP. Registered BEFORE the better-auth catch-all below so
// these paths aren't swallowed by it; route-level express.json() because the
// global body parser mounts after the auth handler.

app.post("/api/auth/signup/send-otp", authLimiter, express.json(), async (req, res) => {
  const body = (req.body ?? {}) as { email?: string };
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    return res.status(409).json({ error: "This email is already registered. Sign in via `codiee wakeup`." });
  }

  const issued = issueOtp(email);
  if (!issued.ok) {
    return res.status(429).json({ error: "OTP already sent — wait a minute before requesting again." });
  }

  try {
    await sendOtpEmail(email, issued.code);
  } catch (error) {
    logger.error({ err: error }, "OTP email send failed");
    return res.status(500).json({ error: "Could not send the verification email. Try again." });
  }
  return res.json({ ok: true });
});

app.post("/api/auth/signup/complete", authLimiter, express.json(), async (req, res) => {
  const body = (req.body ?? {}) as { email?: string; otp?: string; password?: string };
  const email = String(body.email ?? "").trim().toLowerCase();
  const otp = String(body.otp ?? "").trim();
  const password = String(body.password ?? "");

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Invalid email address" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const verdict = verifyOtp(email, otp);
  if (!verdict.ok) {
    return res.status(400).json({ error: `Invalid or expired code (${verdict.reason})` });
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    return res.status(409).json({ error: "This email is already registered. Sign in via `codiee wakeup`." });
  }

  try {
    const result = await auth.api.signUpEmail({
      body: { email, password, name: email.split("@")[0] },
    });
    await prisma.user.update({ where: { email }, data: { emailVerified: true } });
    return res.json({ token: result.token, user: result.user });
  } catch (error) {
    logger.error({ err: error }, "Signup failed");
    return res.status(500).json({ error: "Could not create the account. Try again." });
  }
});

app.all("/api/auth/*splat", authLimiter, toNodeHandler(auth));

app.use(express.json());

// Probes (exempt from rate limiting)

// Liveness probe: is the process up? (no dependencies checked)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Readiness probe: can we actually serve traffic? (checks Postgres)
app.get("/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ status: "ready" });
  } catch (error) {
    logger.error({ err: error }, "Readiness check failed");
    return res.status(503).json({ status: "unavailable", reason: "database unreachable" });
  }
});

// Authenticated API

/** Resolve the session user id from a Bearer token or session cookie. */
async function requireUserId(req: express.Request): Promise<string | null> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  return session?.user?.id ?? null;
}

app.use("/api", apiLimiter);

app.get("/api/me", async (req, res) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session) {
      return res.status(401).json({ error: "No active session" });
    }

    return res.json(session);
  } catch (error) {
    logger.error({ err: error }, "Session error");
    return res.status(500).json({ error: "Failed to get session" });
  }
});

app.get("/device", async (_req, res) => {
  res.status(410).json({ error: "Device flow removed — run `codiee wakeup` to sign in" });
});

// Quota API

// Current quota snapshot for the authenticated user
app.get("/api/quota", async (req, res) => {
  const userId = await requireUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    return res.json(await getQuota(userId));
  } catch (error) {
    logger.error({ err: error }, "Quota lookup failed");
    return res.status(500).json({ error: "Failed to read quota" });
  }
});

// Report token usage after an AI call; enforces the monthly limit
app.post("/api/usage/record", async (req, res) => {
  const userId = await requireUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = (req.body ?? {}) as UsageReportInput;
  if (
    (body.promptTokens !== undefined && !Number.isFinite(Number(body.promptTokens))) ||
    (body.completionTokens !== undefined && !Number.isFinite(Number(body.completionTokens)))
  ) {
    return res.status(400).json({ error: "promptTokens and completionTokens must be numbers" });
  }

  try {
    const { outcome, quota } = await recordUsage(userId, body);
    return res.json({
      outcome,
      allowed: quota.remaining > 0,
      remaining: quota.remaining,
      limit: quota.limit,
      used: quota.used,
      periodEnd: quota.periodEnd,
    });
  } catch (error) {
    logger.error({ err: error }, "Usage recording failed");
    return res.status(500).json({ error: "Failed to record usage" });
  }
});

// Conversation API — the CLI is a pure HTTP client; all persistence lives here.
const CONVERSATION_MODES = new Set(["chat", "tool"]);

app.get("/api/conversations", apiLimiter, async (req, res) => {
  const userId = await requireUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const take = Math.min(Math.max(Number(req.query.take) || 50, 1), 100);
  const conversations = await prisma.conversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take,
    include: { messages: { take: 1, orderBy: { createdAt: "desc" } } },
  });
  return res.json({ conversations });
});

app.post("/api/conversations", apiLimiter, express.json(), async (req, res) => {
  const userId = await requireUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const body = (req.body ?? {}) as { mode?: string; conversationId?: string };
  const mode = CONVERSATION_MODES.has(String(body.mode)) ? String(body.mode) : "chat";
  const conversation = await chatService.getOrCreateConversation(
    userId,
    body.conversationId ?? null,
    mode
  );
  return res.json({ conversation });
});

app.get("/api/conversations/:id", apiLimiter, async (req, res) => {
  const userId = await requireUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const conversation = await prisma.conversation.findFirst({
    where: { id: String(req.params.id), userId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });
  return res.json({ conversation });
});

app.patch("/api/conversations/:id", apiLimiter, express.json(), async (req, res) => {
  const userId = await requireUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const body = (req.body ?? {}) as { title?: string; mode?: string; summary?: string };
  const data: Record<string, string> = {};
  if (typeof body.title === "string") data.title = body.title;
  if (typeof body.mode === "string") {
    if (!CONVERSATION_MODES.has(body.mode)) {
      return res.status(400).json({ error: "Invalid mode" });
    }
    data.mode = body.mode;
  }
  if (typeof body.summary === "string") data.summary = body.summary;
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "Nothing to update" });
  }

  const existing = await prisma.conversation.findFirst({
    where: { id: String(req.params.id), userId },
    select: { id: true },
  });
  if (!existing) return res.status(404).json({ error: "Conversation not found" });

  await prisma.conversation.update({ where: { id: existing.id }, data });
  return res.json({ ok: true });
});

app.delete("/api/conversations/:id", apiLimiter, async (req, res) => {
  const userId = await requireUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const result = await prisma.conversation.deleteMany({ where: { id: String(req.params.id), userId } });
  if (result.count === 0) return res.status(404).json({ error: "Conversation not found" });
  return res.json({ ok: true });
});

app.post("/api/conversations/:id/messages", apiLimiter, express.json(), async (req, res) => {
  const userId = await requireUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const body = (req.body ?? {}) as { role?: string; content?: string | object };
  if (!body.role || body.content === undefined) {
    return res.status(400).json({ error: "role and content are required" });
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: String(req.params.id), userId },
    select: { id: true },
  });
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const message = await chatService.addMessage(conversation.id, body.role, body.content);
  const count = await prisma.message.count({ where: { conversationId: conversation.id } });
  return res.json({ message, count });
});

// RAG sync — the CLI scans/chunks/embeds locally; the server stores and serves.

app.post("/api/rag/diff", apiLimiter, express.json(), async (req, res) => {
  const userId = await requireUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const body = (req.body ?? {}) as { root?: string; files?: { relPath?: string; hashes?: unknown }[] };
  const root = String(body.root ?? "");
  if (!root || !Array.isArray(body.files)) {
    return res.status(400).json({ error: "root and files are required" });
  }
  const files = body.files
    .filter((f) => typeof f?.relPath === "string" && Array.isArray(f.hashes))
    .map((f) => ({ relPath: f.relPath as string, hashes: (f.hashes as any[]).map(String) }));

  try {
    return res.json(await diffIndexedFiles(userId, root, files));
  } catch (error) {
    logger.error({ err: error }, "RAG diff failed");
    return res.status(500).json({ error: "Could not diff the index" });
  }
});

app.post("/api/rag/delete-files", apiLimiter, express.json(), async (req, res) => {
  const userId = await requireUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const body = (req.body ?? {}) as { root?: string; files?: string[] };
  const root = String(body.root ?? "");
  const files = Array.isArray(body.files) ? body.files.map(String).slice(0, 5000) : [];
  if (!root) return res.status(400).json({ error: "root is required" });

  try {
    return res.json({ removed: await deleteIndexedFiles(userId, root, files) });
  } catch (error) {
    logger.error({ err: error }, "RAG delete failed");
    return res.status(500).json({ error: "Could not update the index" });
  }
});

app.post("/api/rag/upsert", apiLimiter, express.json(), async (req, res) => {
  const userId = await requireUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const body = (req.body ?? {}) as { root?: string; chunks?: any[] };
  const root = String(body.root ?? "");
  if (!root || !Array.isArray(body.chunks)) {
    return res.status(400).json({ error: "root and chunks are required" });
  }
  const chunks = body.chunks.slice(0, 200).filter(
    (c) =>
      typeof c?.filePath === "string" &&
      Number.isInteger(c?.chunkIndex) &&
      typeof c?.content === "string" &&
      typeof c?.contentHash === "string" &&
      Array.isArray(c?.embedding)
  );

  try {
    return res.json({ indexed: await upsertChunks(userId, root, chunks) });
  } catch (error) {
    logger.error({ err: error }, "RAG upsert failed");
    return res.status(500).json({ error: "Could not store chunks" });
  }
});

app.post("/api/rag/clear", apiLimiter, express.json(), async (req, res) => {
  const userId = await requireUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const body = (req.body ?? {}) as { root?: string };
  const root = String(body.root ?? "");
  if (!root) return res.status(400).json({ error: "root is required" });

  try {
    return res.json({ removed: await clearIndex(userId, root) });
  } catch (error) {
    logger.error({ err: error }, "RAG clear failed");
    return res.status(500).json({ error: "Could not clear the index" });
  }
});

app.get("/api/rag/stats", apiLimiter, async (req, res) => {
  const userId = await requireUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const root = String(req.query.root ?? "");
  if (!root) return res.status(400).json({ error: "root is required" });

  try {
    return res.json(await getIndexStats(userId, root));
  } catch (error) {
    logger.error({ err: error }, "RAG stats failed");
    return res.status(500).json({ error: "Could not read index stats" });
  }
});

app.post("/api/rag/search", apiLimiter, express.json(), async (req, res) => {
  const userId = await requireUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const body = (req.body ?? {}) as { query?: string; rootPath?: string };
  const query = String(body.query ?? "");
  const rootPath = String(body.rootPath ?? "");
  if (!query.trim() || !rootPath) {
    return res.status(400).json({ error: "query and rootPath are required" });
  }

  try {
    return res.json({ chunks: await retrieveRelevantChunks(query, userId, rootPath) });
  } catch (error) {
    logger.error({ err: error }, "RAG search failed");
    return res.json({ chunks: [] }); // fail-open: never block the answer
  }
});

// Express 5 wildcard fallback for unknown routes
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Bootstrap

let server: ReturnType<typeof app.listen> | null = null;

/** Only auto-start when executed directly (tests import `app` instead). */
function isDirectRun(): boolean {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down gracefully...");
  try {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await prisma.$disconnect();
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "Error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

if (isDirectRun()) {
  server = app.listen(port, () => {
    logger.info(`Codiee auth server listening on port ${port}`);
  });
}
