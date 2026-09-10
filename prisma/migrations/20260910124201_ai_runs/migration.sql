-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('OK', 'TIMEOUT', 'RATE_LIMITED', 'REFUSED', 'INVALID_OUTPUT', 'ERROR', 'NO_KEY');

-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "status" "AiRunStatus" NOT NULL DEFAULT 'OK',
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "requestId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiRun_shop_createdAt_idx" ON "AiRun"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "AiRun_shop_feature_createdAt_idx" ON "AiRun"("shop", "feature", "createdAt");

-- CreateIndex
CREATE INDEX "AiRun_shop_status_createdAt_idx" ON "AiRun"("shop", "status", "createdAt");
