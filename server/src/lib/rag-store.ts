import { Prisma } from "@prisma/client";
import prisma from "./db.js";

// Server-side RAG storage: hash-diffing, chunk upserts, stats, clearing.
// The CLI scans/chunks/embeds locally and syncs through these functions
// (exposed via /api/rag/* endpoints).

interface ExistingHashRow {
  filePath: string;
  chunkIndex: number;
  contentHash: string;
}

async function loadExistingHashes(userId: string, root: string): Promise<ExistingHashRow[]> {
  const rows = (await prisma.$queryRaw`
    SELECT "filePath", "chunkIndex", "contentHash"
      FROM "project_chunk"
     WHERE "userId" = ${userId} AND "rootPath" = ${root}`) as any[];
  return rows.map((r) => ({
    filePath: r.filePath,
    chunkIndex: Number(r.chunkIndex),
    contentHash: r.contentHash,
  }));
}

/**
 * Compare the CLI's scanned file hashes against the stored index.
 * `dirty` = files whose chunks changed (re-index), `toDelete` = files that
 * disappeared from disk (drop their rows).
 */
export async function diffIndexedFiles(
  userId: string,
  root: string,
  files: { relPath: string; hashes: string[] }[]
): Promise<{ dirty: string[]; toDelete: string[] }> {
  const existing = await loadExistingHashes(userId, root);

  const existingByFile = new Map<string, string[]>();
  for (const row of existing) {
    const hashes = existingByFile.get(row.filePath) ?? [];
    hashes.push(row.contentHash);
    existingByFile.set(row.filePath, hashes);
  }

  const wanted = new Map(files.map((f) => [f.relPath, f.hashes]));
  const toDelete = [...existingByFile.keys()].filter((fp) => !wanted.has(fp));

  const dirty: string[] = [];
  for (const [filePath, hashes] of wanted) {
    const old = existingByFile.get(filePath);
    const same =
      old && old.length === hashes.length && hashes.every((h, i) => old[i] === h);
    if (!same) dirty.push(filePath);
  }

  return { dirty, toDelete };
}

export interface UpsertableChunk {
  filePath: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  embedding: number[];
}

/** Delete stored rows for specific files (removed from disk or about to be re-indexed). */
export async function deleteIndexedFiles(
  userId: string,
  root: string,
  filePaths: string[]
): Promise<number> {
  if (!filePaths.length) return 0;
  const list = Prisma.join(filePaths.map((f) => `${f}`));
  const result = await prisma.$executeRaw`
    DELETE FROM "project_chunk"
     WHERE "userId" = ${userId}
       AND "rootPath" = ${root}
       AND "filePath" IN (${list})`;
  return result;
}

/** Store embedded chunks (upsert on userId+root+file+chunkIndex). */
export async function upsertChunks(
  userId: string,
  root: string,
  chunks: UpsertableChunk[]
): Promise<number> {
  let indexed = 0;
  for (const c of chunks) {
    const vec = `[${c.embedding.join(",")}]`;
    await prisma.$executeRaw`
      INSERT INTO "project_chunk"
        ("id", "userId", "rootPath", "filePath", "chunkIndex",
         "content", "contentHash", "embedding", "createdAt", "updatedAt")
      VALUES
        (gen_random_uuid(), ${userId}, ${root}, ${c.filePath},
         ${c.chunkIndex}, ${c.content}, ${c.contentHash}, ${vec}::vector,
         NOW(), NOW())
      ON CONFLICT ("userId", "rootPath", "filePath", "chunkIndex")
      DO UPDATE SET
        "content" = EXCLUDED."content",
        "contentHash" = EXCLUDED."contentHash",
        "embedding" = EXCLUDED."embedding",
        "updatedAt" = NOW()`;
    indexed += 1;
  }
  return indexed;
}

/** Delete the whole index for a user+project; returns rows removed. */
export async function clearIndex(userId: string, rootPath: string): Promise<number> {
  return await prisma.$executeRaw`
    DELETE FROM "project_chunk"
     WHERE "userId" = ${userId} AND "rootPath" = ${rootPath}`;
}

/** Index statistics (chunk + file counts) for a user+project. */
export async function getIndexStats(
  userId: string,
  rootPath: string
): Promise<{ chunks: number; files: number }> {
  try {
    const rows = (await prisma.$queryRaw`
      SELECT COUNT(*)::int AS chunks,
             COUNT(DISTINCT "filePath")::int AS files
        FROM "project_chunk"
       WHERE "userId" = ${userId} AND "rootPath" = ${rootPath}`) as any[];
    return {
      chunks: Number(rows[0]?.chunks ?? 0),
      files: Number(rows[0]?.files ?? 0),
    };
  } catch {
    return { chunks: 0, files: 0 };
  }
}
