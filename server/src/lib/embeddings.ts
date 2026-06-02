/**
 * Embeddings for Codiee RAG (Gemini gemini-embedding-001, 768-dim via
 * outputDimensionality truncation — replaces the retired text-embedding-004).
 * Every call is paced by lib/rate-limiter.js: exactly one attempt, no retries.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embed, embedMany } from "ai";
import { loadConfigSync, resolveApiKey } from "../config/ai.config.js";
import { acquire } from "./rate-limiter.js";

export const EMBEDDING_MODEL_ID = "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = 768;

const BATCH_SIZE = 16;

function resolveEmbeddingModel() {
  const cfg = loadConfigSync();
  const apiKey = resolveApiKey(cfg);
  if (!apiKey) {
    throw new Error(
      "No Gemini API key found. Embeddings require one:\n" +
        "run `codiee config set key <your-key>` or set GOOGLE_GENERATIVE_AI_API_KEY."
    );
  }
  return createGoogleGenerativeAI({ apiKey }).textEmbeddingModel(EMBEDDING_MODEL_ID);
}

/** Embed many texts in batches; one attempt per batch, no retries. */
export async function embedTexts(values: string[]): Promise<number[][]> {
  if (!values?.length) return [];

  const model = resolveEmbeddingModel();
  const out: number[][] = [];

  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    const batch = values.slice(i, i + BATCH_SIZE);
    await acquire("embed");
    const { embeddings } = await embedMany({
      model,
      values: batch,
      maxRetries: 0,
      providerOptions: {
        google: {
          outputDimensionality: EMBEDDING_DIMENSIONS,
          taskType: "RETRIEVAL_DOCUMENT",
        },
      },
    });
    out.push(...embeddings);
  }

  return out;
}

/** Embed a single query text. */
export async function embedQuery(text: string): Promise<number[]> {
  await acquire("embed");
  const { embedding } = await embed({
    model: resolveEmbeddingModel(),
    value: text,
    maxRetries: 0,
    providerOptions: {
      google: {
        outputDimensionality: EMBEDDING_DIMENSIONS,
        taskType: "RETRIEVAL_QUERY",
      },
    },
  });
  return embedding;
}

/** Serialize a vector into pgvector's literal format: '[0.1,0.2,...]' */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
