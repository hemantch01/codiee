import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";

/**
 * Codiee AI configuration — persists provider/model/apiKey/theme in
 * ~/.codiee/config.json, with per-repo overrides via a `.codiee.json` file.
 */

export const CONFIG_DIR = path.join(os.homedir(), ".codiee");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const PROJECT_CONFIG_FILE = ".codiee.json";

const DEFAULT_CONFIG = {
  provider: "google",
  model: "gemini-3.6-flash",
  apiKey: "",
  theme: "dark",
};

export const PROVIDERS = [
  {
    id: "google",
    name: "Google Gemini (cloud)",
    hint: "Requires GOOGLE_GENERATIVE_AI_API_KEY",
    models: [
      { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash (default, fast)" },
      { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash (newer)" },
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash (newest flash)" },
      { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite (cheapest)" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (smartest stable)" },
      { id: "gemini-flash-latest", name: "Latest Flash (auto-updating alias)" },
    ],
    requiresKey: true,
    keyField: "apiKey",
    keyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  {
    id: "ollama",
    name: "Ollama (local & free)",
    hint: "Runs locally - no API key needed (requires Ollama installed)",
    models: [
      { id: "qwen2.5-coder", name: "Qwen 2.5 Coder (best for code)" },
      { id: "llama3.2", name: "Llama 3.2" },
      { id: "mistral", name: "Mistral" },
      { id: "phi4", name: "Phi-4" },
    ],
    requiresKey: false,
  },
  {
    id: "openrouter",
    name: "OpenRouter (open models)",
    hint: "DeepSeek, Qwen, Llama & more via one API key",
    baseURL: "https://openrouter.ai/api/v1",
    models: [
      { id: "deepseek/deepseek-chat-v3.1", name: "DeepSeek Chat v3.1" },
      { id: "qwen/qwen3-coder-480b-a35b-instruct", name: "Qwen3 Coder 480B" },
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick" },
      { id: "mistralai/mistral-small-3.2-24b-instruct", name: "Mistral Small 3.2" },
    ],
    requiresKey: true,
    keyField: "openrouterApiKey",
    keyEnv: "OPENROUTER_API_KEY",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM (build.nvidia.com)",
    hint: "Free-tier hosted open models (nvapi-... key)",
    baseURL: "https://integrate.api.nvidia.com/v1",
    models: [
      { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B" },
      { id: "qwen/qwen2.5-coder-32b-instruct", name: "Qwen 2.5 Coder 32B" },
      { id: "deepseek-ai/deepseek-r1", name: "DeepSeek R1" },
      { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B" },
    ],
    requiresKey: true,
    keyField: "nvidiaApiKey",
    keyEnv: "NVIDIA_API_KEY",
  },
] as const;

/**
 * Resolve the API key for a provider: its stored config field > env var.
 * Providers without key metadata (ollama) resolve to "".
 */
export function resolveProviderKey(cfg: Record<string, any>, providerId: string): string {
  const meta = (PROVIDERS as readonly any[]).find((p) => p.id === providerId);
  if (!meta?.keyField) return "";
  return (
    (cfg[meta.keyField] as string | undefined) ||
    (meta.keyEnv ? process.env[meta.keyEnv] : "") ||
    ""
  );
}

/**
 * Locate the nearest `.codiee.json` project override file, walking up from
 * startDir. Returns the absolute path or null when none exists.
 */
export async function findProjectConfigPath(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, PROJECT_CONFIG_FILE);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read + parse the project override file ({} when missing/invalid).
 */
export async function loadProjectConfig(startDir = process.cwd()) {
  const filePath = await findProjectConfigPath(startDir);
  if (!filePath) return {};
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // invalid JSON — ignore overrides rather than crash
  }
}

/**
 * Load user configuration: defaults < global (~/.codiee/config.json) < project (.codiee.json)
 */
export async function loadConfig() {
  let globalCfg = {};
  try {
    globalCfg = JSON.parse(await fs.readFile(CONFIG_FILE, "utf-8"));
  } catch {
    globalCfg = {};
  }
  const projectCfg = await loadProjectConfig();
  return { ...DEFAULT_CONFIG, ...globalCfg, ...projectCfg };
}

/**
 * Synchronous variant of loadConfig() for hot paths (AI service init).
 */
export function loadConfigSync(startDir = process.cwd()) {
  let globalCfg = {};
  try {
    globalCfg = JSON.parse(fsSync.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    globalCfg = {};
  }

  let dir = path.resolve(startDir);
  let projectCfg = {};
  while (true) {
    try {
      projectCfg = JSON.parse(
        fsSync.readFileSync(path.join(dir, PROJECT_CONFIG_FILE), "utf-8")
      );
      break;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return { ...DEFAULT_CONFIG, ...globalCfg, ...projectCfg };
}

/**
 * Persist partial config updates
 */
export async function saveConfig(partial) {
  const current = await loadConfig();
  const next = { ...current, ...partial };
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

/**
 * Resolve the effective API key (stored config > env)
 */
export function resolveApiKey(cfg) {
  return (
    cfg.apiKey ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ""
  );
}
