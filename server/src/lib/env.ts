import dotenv from "dotenv";

// Import this FIRST in every entrypoint so .env is loaded before any
// module reads process.env at load time (PrismaClient, better-auth, etc.).
dotenv.config({ quiet: true });
