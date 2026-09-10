-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "briefingMuted" TEXT[];

-- CreateTable
CREATE TABLE "MerchantBriefing" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "quiet" BOOLEAN NOT NULL DEFAULT false,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "aiModel" TEXT,
    "aiPromptVersion" TEXT,
    "aiRequestId" TEXT,

    CONSTRAINT "MerchantBriefing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MerchantBriefing_shop_generatedAt_idx" ON "MerchantBriefing"("shop", "generatedAt");
