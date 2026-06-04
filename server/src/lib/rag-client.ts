import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { DEFAULT_IGNORED_DIRS, isIgnored, type IgnoreRule } from "./project-context.js";

// CLI-side RAG helpers: file collection, chunking, hashing, context formatting.
// No database access here — persistence goes through the server API.

export const INDEXER_LIMITS = {
  maxFileBytes: 200 * 1024, // skip files > 200 KB
  chunkTargetChars: 1500, // ~350–400 tokens per chunk
  chunkOverlapChars: 200, // overlap so context isn't cut mid-thought
  maxFiles: 2000,
  maxChunks: 5000,
};

const TEXT_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts",
  ".json", ".md", ".mdx", ".txt", ".yml", ".yaml", ".toml",
  ".css", ".scss", ".sass", ".less", ".html", ".htm", ".svg",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c",
  ".h", ".cpp", ".hpp", ".cs", ".php", ".sh", ".bash", ".zsh",
  ".sql", ".prisma", ".graphql", ".gql", ".vue", ".svelte",
]);

const TEXT_DOTFILES = [".gitignore", ".dockerignore", ".env.example", ".codieeignore"];

export function sha1Short(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function hasTextExtension(fileName: string): boolean {
  const name = fileName.toLowerCase();
  if (TEXT_EXTENSIONS.has(path.extname(name))) return true;
  return TEXT_DOTFILES.some((f) => name === f || name.endsWith(f));
}

/** Recursively collect indexable text files under root. */
export async function collectFiles(
  root: string,
  rules: IgnoreRule[]
): Promise<{ relPath: string; fullPath: string }[]> {
  const files: { relPath: string; fullPath: string }[] = [];

  async function walk(dir: string) {
    if (files.length >= INDEXER_LIMITS.maxFiles) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= INDEXER_LIMITS.maxFiles) return;

      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath).split(path.sep).join("/");
      const isDir = entry.isDirectory();

      if (isDir) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
        if (entry.isSymbolicLink()) continue;
        if (isIgnored(relPath, true, rules)) continue;
        await walk(fullPath);
        continue;
      }

      if (entry.isSymbolicLink()) continue;
      if (!hasTextExtension(entry.name)) continue;
      if (isIgnored(relPath, false, rules)) continue;

      try {
        const stat = await fs.stat(fullPath);
        if (stat.size > INDEXER_LIMITS.maxFileBytes) continue;
        files.push({ relPath, fullPath });
      } catch {
        continue;
      }
    }
  }

  await walk(root);
  return files;
}

/** Chunk file content by lines into ~chunkTargetChars pieces with overlap. */
export function chunkContent(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const chunks: string[] = [];
  let current: string[] = [];

  const sizeOf = (arr: string[]) => arr.reduce((n, l) => n + l.length + 1, 0);

  for (const line of lines) {
    // Hard-split pathological single lines longer than the target
    if (line.length > INDEXER_LIMITS.chunkTargetChars) {
      if (current.length) {
        chunks.push(current.join("\n"));
        current = [];
      }
      for (let i = 0; i < line.length; i += INDEXER_LIMITS.chunkTargetChars) {
        chunks.push(line.slice(i, i + INDEXER_LIMITS.chunkTargetChars));
      }
      continue;
    }

    if (
      sizeOf(current) + line.length + 1 > INDEXER_LIMITS.chunkTargetChars &&
      current.length
    ) {
      chunks.push(current.join("\n"));
      // Keep an overlap tail for continuity between chunks
      const tail: string[] = [];
      let tailSize = 0;
      for (let j = current.length - 1; j >= 0; j--) {
        if (tailSize + current[j].length + 1 > INDEXER_LIMITS.chunkOverlapChars) break;
        tail.unshift(current[j]);
        tailSize += current[j].length + 1;
      }
      current = tail;
    }
    current.push(line);
  }
  if (current.length) chunks.push(current.join("\n"));

  return chunks.filter((c) => c.trim().length > 0);
}

export interface RetrievedChunk {
  filePath: string;
  chunkIndex: number;
  content: string;
  score: number;
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
