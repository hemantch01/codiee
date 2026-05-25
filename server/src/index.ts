import "./lib/env.js";
import express from "express";
import { auth } from "./lib/auth.js";
import { toNodeHandler } from "better-auth/node";
import helmet from "helmet";
import { pathToFileURL } from "url";
import { pinoHttp } from "pino-http";
import prisma from "./lib/db.js";
import { logger } from "./lib/logger.js";

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

// Better-auth catch-all: signup/signin/session flows live under /api/auth
app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json());

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

// OTP signup, conversations, quota and rag routes added later
