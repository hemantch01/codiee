-- RAG + context management:
--  1. pgvector extension for semantic search
--  2. Conversation.summary column (rolling summarization)
--  3. project_chunk table storing file chunks + vector(768) embeddings
--     (Gemini text-embedding-004). The HNSW cosine index is created with
--     raw SQL because Prisma cannot model pgvector indexes.

CREATE EXTENSION IF NOT EXISTS vector;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "summary" TEXT;

-- CreateTable
CREATE TABLE "project_chunk" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector(768),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_chunk_userId_rootPath_filePath_chunkIndex_key" ON "project_chunk"("userId", "rootPath", "filePath", "chunkIndex");

-- CreateIndex
CREATE INDEX "project_chunk_userId_rootPath_idx" ON "project_chunk"("userId", "rootPath");

-- AddForeignKey
ALTER TABLE "project_chunk" ADD CONSTRAINT "project_chunk_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- HNSW index for approximate nearest-neighbor cosine search (pgvector).
CREATE INDEX IF NOT EXISTS "project_chunk_embedding_hnsw" ON "project_chunk" USING hnsw ("embedding" vector_cosine_ops);
