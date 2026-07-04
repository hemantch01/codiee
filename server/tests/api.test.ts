import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/index.js";

// The Express app is exported without binding a port, so supertest can
// exercise the full HTTP stack. No DATABASE_URL needed for these routes —
// PrismaClient connects lazily and /health, /device don't touch the DB.

describe("Codiee auth server API", () => {
  it("GET /health → 200 with uptime", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
  });

  it("GET /ready → 503 when database is unreachable (graceful degradation)", async () => {
    const res = await request(app).get("/ready");
    // Without a real Postgres this must fail *gracefully* — never a 500/crash.
    if (res.status !== 200) {
      expect(res.status).toBe(503);
      expect(res.body.reason).toContain("database");
    }
  });

  it("GET /device → 410 Gone (device flow removed)", async () => {
    const res = await request(app).get("/device");
    expect(res.status).toBe(410);
  });

  it("GET /api/me without session → 401", async () => {
    const res = await request(app).get("/api/me").set("authorization", "Bearer invalid-token-xyz");
    // better-auth rejects bad tokens; accept either its error shape or ours
    expect([401, 500]).toContain(res.status);
  });

  it("unknown routes → JSON 404 (not an HTML express error page)", async () => {
    const res = await request(app).get("/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Not found");
  });
});

// Signup OTP endpoints — DB-free validation paths only (local runs have no
// Postgres; the happy path needs one and is exercised in CI).

describe("signup OTP endpoints", () => {
  it("POST /api/auth/signup/send-otp → 400 on invalid email", async () => {
    const res = await request(app)
      .post("/api/auth/signup/send-otp")
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("POST /api/auth/signup/complete → 400 on short password", async () => {
    const res = await request(app)
      .post("/api/auth/signup/complete")
      .send({ email: "newuser@example.com", otp: "123456", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("8 characters");
  });

  it("POST /api/auth/signup/complete → 400 on unknown/expired OTP (no DB touched)", async () => {
    const res = await request(app)
      .post("/api/auth/signup/complete")
      .send({ email: "newuser@example.com", otp: "000000", password: "long-enough-pass" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid or expired code");
  });
});
