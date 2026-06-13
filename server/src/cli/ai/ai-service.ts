import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import chalk from "chalk";
import {
  loadConfigSync,
  resolveApiKey,
  resolveProviderKey,
  PROVIDERS,
} from "../../config/ai.config.js";
import { acquire } from "../../lib/rate-limiter.js";

/** A single message in AI SDK format. */
export interface AIMessage {
  role: string;
  content: string;
}

interface ToolCallRecord {
  toolName: string;
  args?: unknown;
  [key: string]: unknown;
}

interface SendResult {
  content: string;
  usage?: any;
  toolResults: any[];
}

/** Sync config read: defaults + global config + per-project .codiee.json overrides. */
function readConfigSync() {
  return loadConfigSync() as Record<string, any>;
}

/** Resolve the configured model into an AI SDK model instance:
 * google, ollama, openrouter or nvidia (all via config / .codiee.json overrides). */
function resolveModel(cfg: Record<string, any>) {
  if (cfg.provider === "ollama") {
    const baseURL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
    const ollama = createOpenAICompatible({ name: "ollama", baseURL });
    return ollama.chatModel(cfg.model);
  }

  if (cfg.provider === "openrouter" || cfg.provider === "nvidia") {
    const meta = (PROVIDERS as readonly any[]).find((p) => p.id === cfg.provider);
    const apiKey = resolveProviderKey(cfg, cfg.provider);
    if (!apiKey) {
      throw new Error(
        `No ${meta?.name ?? cfg.provider} API key found. Run /models inside a chat\n` +
          `session to pick a provider and paste your key${
            meta?.keyEnv ? `, or set ${meta.keyEnv} in .env` : ""
          }.`
      );
    }
    const provider = createOpenAICompatible({
      name: cfg.provider,
      baseURL: meta?.baseURL,
      apiKey,
    });
    return provider.chatModel(cfg.model);
  }

  const apiKey = resolveApiKey(cfg);
  if (!apiKey) {
    throw new Error(
      "No Gemini API key found. Set GOOGLE_GENERATIVE_AI_API_KEY in .env,\n" +
        "run `codiee config set key <your-key>`, or switch to a local model:\n" +
        "`codiee config set provider ollama`"
    );
  }
  return createGoogleGenerativeAI({ apiKey })(cfg.model);
}

export class AIService {
  config: Record<string, any>;
  private _model: ReturnType<typeof resolveModel> | undefined;

  constructor() {
    this.config = readConfigSync();
    // Lazy: resolved on first use so `codiee config` works without keys
    this._model = undefined;
  }

  get model() {
    if (!this._model) {
      this._model = resolveModel(this.config);
    }
    return this._model;
  }

  get label(): string {
    return `${this.config.provider}:${this.config.model}`;
  }

  /** Re-read config from disk and drop the cached model (e.g. after /models). */
  reloadConfig() {
    this.config = readConfigSync();
    this._model = undefined;
  }

  /** Send a message and get a streaming response. */
  async sendMessage(
    messages: AIMessage[],
    onChunk?: ((chunk: string) => void) | null,
    tools: Record<string, any> | undefined = undefined,
    onToolCall: ((toolCall: ToolCallRecord) => void) | null = null
  ): Promise<SendResult> {
    try {
      const streamConfig: Record<string, any> = {
        model: this.model,
        messages: messages,
        temperature: 0.7,
        // Zero retries — the rate limiter paces us under the provider's
        // limits; if a request still fails, fail fast with one clean error.
        maxRetries: 0,
      };

      // Proactive pacing so free-tier RPM caps are never hit
      await acquire("chat");

      // Add tools if provided with maxSteps for multi-step tool calling
      if (tools && Object.keys(tools).length > 0) {
        streamConfig.tools = tools;
        streamConfig.maxSteps = 5; // Allow up to 5 tool call steps
      }

      const result = streamText(streamConfig as any);

      let fullResponse = "";
      let usage: any;
      const toolResults: any[] = [];

      // Consume the full stream ourselves so every event — including errors —
      // surfaces in this loop instead of a floating promise that crashes later.
      for await (const part of (result as any).fullStream) {
        const p: any = part;
        switch (p.type) {
          case "text-delta": {
            const text = p.text ?? p.textDelta ?? "";
            if (text) {
              fullResponse += text;
              onChunk?.(text);
            }
            break;
          }
          case "tool-call": {
            const call: ToolCallRecord = { toolName: p.toolName, args: p.input ?? p.args };
            onToolCall?.(call);
            break;
          }
          case "tool-result": {
            toolResults.push({ toolName: p.toolName, result: p.output ?? p.result });
            break;
          }
          case "error":
            throw p.error ?? new Error("Unknown stream error");
          case "finish":
            usage = p.totalUsage ?? p.usage;
            break;
          // start/finish-step, reasoning, source, file, etc. — ignored
        }
      }

      return {
        content: fullResponse,
        usage,
        toolResults,
      };
    } catch (error: any) {
      console.error(chalk.red("AI Service Error:"), error?.message ?? error);
      throw error;
    }
  }

  /** Get a non-streaming response. */
  async getMessage(messages: AIMessage[]): Promise<string> {
    let fullResponse = "";
    const result = await this.sendMessage(messages, (chunk) => {
      fullResponse += chunk;
    });
    return result.content;
  }
}

