import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import yoctoSpinner from "yocto-spinner";
import { confirm, isCancel, cancel } from "@clack/prompts";
import fs from "fs/promises";
import { requireAuth } from "./auth/login.js";
import { api } from "../api.js";
import { findProjectRoot, loadCodieeIgnore } from "../../lib/project-context.js";
import { EMBEDDING_MODEL_ID, embedTexts } from "../../lib/embeddings.js";
import { INDEXER_LIMITS, collectFiles, chunkContent, sha1Short } from "../../lib/rag-client.js";

// `codiee index` — scan + chunk + embed locally, sync vectors to the server.
// Project files never leave the machine un-embedded; only vectors + text
// chunks are stored server-side (per user).

export const indexCommand = new Command("index")
  .description(
    "Build/update the semantic code index for RAG (pgvector + Gemini embeddings)"
  )
  .option("--clear", "Delete the semantic index for this project")
  .option("--stats", "Show index statistics only")
  .action(async (options) => {
    try {
      await requireAuth();
      const root = await findProjectRoot();

      if (options.stats) {
        const res = await api<{ chunks: number; files: number; error?: string }>(
          `/api/rag/stats?root=${encodeURIComponent(root)}`
        );
        if (!res.ok) throw new Error(res.data.error || "Could not read index stats");
        console.log(
          boxen(
            `${chalk.bold("Project")}: ${root}\n` +
              `${chalk.bold("Files indexed")}: ${res.data.files}\n` +
              `${chalk.bold("Chunks stored")}: ${res.data.chunks}`,
            {
              padding: 1,
              borderStyle: "round",
              title: "RAG Index Stats",
            }
          )
        );
        return;
      }

      if (options.clear) {
        const ok = await confirm({
          message: `Delete the semantic index for ${root}?`,
          initialValue: false,
        });
        if (isCancel(ok) || !ok) {
          cancel("Index clear cancelled");
          return;
        }
        const spinner = yoctoSpinner({ text: "Clearing index..." }).start();
        const res = await api<{ removed: number; error?: string }>("/api/rag/clear", {
          method: "POST",
          body: { root },
        });
        if (!res.ok) throw new Error(res.data.error || "Could not clear the index");
        spinner.success(`Removed ${res.data.removed} indexed chunks`);
        return;
      }

      console.log(
        boxen(
          `${chalk.bold("Project")}: ${root}\n${chalk.gray("Embedding model")}: Gemini ${EMBEDDING_MODEL_ID} → pgvector`,
          {
            padding: 1,
            margin: { bottom: 1 },
            borderStyle: "round",
            title: "Codiee Semantic Index",
          }
        )
      );

      // 1. Scan + chunk locally
      const spinner = yoctoSpinner({ text: "Scanning project..." }).start();
      const rules = await loadCodieeIgnore(root);
      const files = await collectFiles(root, rules);

      const wanted = new Map<string, { chunkIndex: number; content: string; contentHash: string }[]>();
      for (const file of files) {
        let content;
        try {
          content = await fs.readFile(file.fullPath, "utf-8");
        } catch {
          continue;
        }
        const pieces = chunkContent(content);
        if (!pieces.length) continue;
        wanted.set(
          file.relPath,
          pieces.map((content, chunkIndex) => ({
            chunkIndex,
            content,
            contentHash: sha1Short(content),
          }))
        );
      }
      spinner.text = `Scanning project (${files.length} files)...`;

      // 2. Server tells us which files are new/changed and which vanished
      const diff = await api<{ dirty: string[]; toDelete: string[]; error?: string }>("/api/rag/diff", {
        method: "POST",
        body: {
          root,
          files: [...wanted.entries()].map(([relPath, chunks]) => ({
            relPath,
            hashes: chunks.map((c) => c.contentHash),
          })),
        },
      });
      if (!diff.ok) throw new Error(diff.data.error || "Could not diff the index");

      const { dirty, toDelete } = diff.data;
      const dirtyChunks = dirty.flatMap((fp) =>
        (wanted.get(fp) ?? []).map((c) => ({ filePath: fp, ...c }))
      );
      const capped = dirtyChunks.slice(0, INDEXER_LIMITS.maxChunks);

      // 3. Drop rows for removed + re-indexed files
      const removedRes = await api<{ removed: number }>("/api/rag/delete-files", {
        method: "POST",
        body: { root, files: [...toDelete, ...dirty] },
      });
      const chunksDeleted = removedRes.data.removed ?? 0;

      // 4. Embed dirty chunks locally, store server-side
      const BATCH = 16;
      let chunksIndexed = 0;
      for (let i = 0; i < capped.length; i += BATCH) {
        const batch = capped.slice(i, i + BATCH);
        const vectors = await embedTexts(batch.map((c) => c.content));

        const upsert = await api<{ indexed: number; error?: string }>("/api/rag/upsert", {
          method: "POST",
          body: {
            root,
            chunks: batch.map((c, j) => ({
              filePath: c.filePath,
              chunkIndex: c.chunkIndex,
              content: c.content,
              contentHash: c.contentHash,
              embedding: vectors[j],
            })),
          },
        });
        if (!upsert.ok) throw new Error(upsert.data.error || "Could not store chunks");

        chunksIndexed += batch.length;
        spinner.text = `Embedding chunks (${Math.min(i + BATCH, capped.length)}/${capped.length})...`;
      }

      spinner.success(
        `Indexed ${chunksIndexed} chunks from ${dirty.length}/${files.length} files` +
          (chunksDeleted ? ` (cleaned ${chunksDeleted} stale)` : "")
      );

      console.log(
        chalk.gray(
          `\nTip: run 'codiee index' after significant code changes so chat & agent stay grounded.\n`
        )
      );
    } catch (error) {
      console.error(chalk.red(`❌ ${error.message}`));
      process.exit(1);
    }
  });
