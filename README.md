# Codiee 🚀

**Codiee** is a terminal-native AI coding companion. Chat with AI, use tool-calling (search / code execution), or let Agent Mode generate complete applications — all from your terminal.

> Fully terminal-based authentication: no browser flows, no social login. Run `codiee wakeup` — a **Login / Signup** picker opens when you're not signed in.

## Demo

<!-- TODO: replace these placeholders with real screenshots/GIFs in docs/images/ -->

![Codiee signup — email OTP flow](docs/images/signup.png)
![Codiee chat — themed markdown, tool calling, RAG grounding](docs/images/chat.png)
![codiee index — semantic indexing with progress](docs/images/index.png)

## Project Structure

```
codiee/
└── server/   # Express auth API + the `codiee` CLI
```

## Quick Start

### 1. Auth server (port 3005)

```bash
cd server
npm install
npx prisma generate && npx prisma migrate dev
npm run dev
```

Environment (`.env`):

```
DATABASE_URL=postgresql://...
GOOGLE_GENERATIVE_AI_API_KEY=...   # optional if using Ollama
CODIEE_SERVER_URL=http://localhost:3005
```

### 2. CLI

```bash
cd server
npm run cli -- --help        # or link globally: npm link
```

## CLI Commands

| Command | Description |
|---|---|
| `codiee wakeup` | Not signed in? A **Login / Signup** picker opens (signup = email → OTP → password) |
| `codiee whoami` | Show current user |
| `codiee logout` | Clear stored credentials |
| `codiee wakeup` | Start Chat / Tool Calling / Agent mode |
| `codiee wakeup -c` | Resume your most recent conversation |
| `codiee conversations` | List saved conversations |
| `codiee conversations export [id] -o file.md` | Export a conversation to Markdown |
| `codiee conversations clear <id>` | Delete a conversation |
| `codiee config set provider ollama` | Switch to local models (no API key needed) |
| `codiee config set key <gemini-key>` | Store your Gemini API key |

## AI Models

- **Google Gemini** (cloud): `gemini-3.6-flash` (default), `gemini-3.7-flash`, `gemini-2.5-pro`, …
- **Ollama** (local & free): `qwen2.5-coder`, `llama3.2`, `mistral`, `phi4`
- **OpenRouter** (open models): DeepSeek Chat, Qwen3 Coder, Llama 4 Maverick, …
- **NVIDIA NIM** (free-tier hosted): Llama 3.3 70B, DeepSeek R1, GPT-OSS 120B, …

Switch any time with `codiee config` or pick interactively. Config lives in `~/.codiee/config.json`; sessions in `~/.codiee/token.json`.

> 🗺️ **Roadmap:** a "Codiee Hosted" provider so new users can chat without any
> API key (metered server-side). Design: [HOSTED-MODEL.md](./HOSTED-MODEL.md)

> **Signup OTP emails**: the server sends a one-time code to new users via SMTP.
> Configure `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` in `server/.env`
> (Gmail App Password works great). Without SMTP configured the OTP is printed
> in the server console — and in dev you can run the bundled Mailpit container
> (`docker compose up mailpit`) and read mails at http://localhost:8025.
