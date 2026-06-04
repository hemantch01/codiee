/**
 * Semantic retrieval for Codiee RAG — embeds a query and runs pgvector
 * cosine-distance search over indexed chunks. Degrades gracefully (returns [])
 * when the index, pgvector, or embeddings are unavailable.
 */

import prisma from "./db.js";
import { embedQuery, toVectorLiteral } from "./embeddings.js";

const DEFAULT_TOP_K = 8;
/** Cosine-similarity floor; below this a chunk is considered noise. */
const MIN_SCORE = 0.3;

interface RetrievedChunk {
  filePath: string;
  chunkIndex: number;
  content: string;
  score: number;
}

/** Retrieve the most relevant project chunks for a query. */
export async function retrieveRelevantChunks(
  query: string | null | undefined,
  userId: string,
  rootPath: string,
  topK: number = DEFAULT_TOP_K
): Promise<RetrievedChunk[]> {
  if (!query || !query.trim() || !userId || !rootPath) return [];

  let literal;
  try {
    literal = toVectorLiteral(await embedQuery(query));
  } catch {
    // No API key / quota issue — retrieval is best-effort, never fatal.
    return [];
  }

  try {
    const rows = await prisma.$queryRaw`
      SELECT "filePath",
             "chunkIndex",
             "content",
             1 - ("embedding" <=> ${literal}::vector) AS score
        FROM "project_chunk"
       WHERE "userId" = ${userId}
         AND "rootPath" = ${rootPath}
         AND "embedding" IS NOT NULL
       ORDER BY "embedding" <=> ${literal}::vector
       LIMIT ${topK}`;

    // Prisma decimal/float mapping: normalize scores to plain numbers.
    return (rows as any[])
      .map((r) => ({
        filePath: r.filePath,
        chunkIndex: Number(r.chunkIndex),
        content: r.content,
        score: Number(r.score),
      }))
      .filter((r) => r.score >= MIN_SCORE);
  } catch {
    // Table missing / extension missing / DB down — degrade gracefully.
    return [];
  }
}

/** Format retrieved chunks into a system-context block; null when there are no chunks. */
export function formatChunksAsContext(
  chunks: { filePath: string; chunkIndex: number; content: string }[] | null,
  maxChars = 9000
): string | null {
  if (!chunks?.length) return null;

  const header =
    "Semantic search matched these excerpts from the user's actual project files. " +
    "Treat them as ground truth about the codebase. File paths are relative to the project root.\n";

  const bodyParts = chunks.map(
    (c) => `--- ${c.filePath} (chunk ${c.chunkIndex}) ---\n${c.content.trim()}`
  );

  let block = header + bodyParts.join("\n\n");
  if (block.length > maxChars) {
    block = block.slice(0, maxChars) + "\n… (retrieved context truncated)";
  }
  return block;
}

