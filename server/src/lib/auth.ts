import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import prisma from "./db.js";

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  baseURL: process.env.CODIEE_SERVER_URL || "http://localhost:3005",
  basePath: "/api/auth",
  emailAndPassword: {
    enabled: true, // Terminal-native sign-in: no social providers, no browser flows
    minPasswordLength: 8,
  },
  logger: {
    level: "debug",
  },
});
