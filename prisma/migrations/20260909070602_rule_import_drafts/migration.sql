-- CreateTable
CREATE TABLE "RuleImportDraft" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleImportDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RuleImportDraft_shop_createdAt_idx" ON "RuleImportDraft"("shop", "createdAt");
