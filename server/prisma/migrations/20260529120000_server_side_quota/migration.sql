-- CreateTable
CREATE TABLE "usage_counter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "promptTokens" BIGINT NOT NULL DEFAULT 0,
    "completionTokens" BIGINT NOT NULL DEFAULT 0,
    "totalTokens" BIGINT NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_counter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usage_counter_userId_key" ON "usage_counter"("userId");
