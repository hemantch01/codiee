import pino from "pino";

/** Structured JSON logger with LOG_LEVEL control and credential redaction. */
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "access_token",
      "*.access_token",
      "*.password",
      "apiKey",
      "*.apiKey",
    ],
    censor: "[REDACTED]",
  },
});
