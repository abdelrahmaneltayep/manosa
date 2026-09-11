-- CreateTable
CREATE TABLE "MonthlyReview" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "sections" JSONB NOT NULL,
    "facts" JSONB NOT NULL,
    "diff" JSONB,
    "quiet" BOOLEAN NOT NULL DEFAULT false,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "aiModel" TEXT,
    "aiPromptVersion" TEXT,
    "aiRequestId" TEXT,

    CONSTRAINT "MonthlyReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonthlyReview_shop_generatedAt_idx" ON "MonthlyReview"("shop", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyReview_shop_month_key" ON "MonthlyReview"("shop", "month");
