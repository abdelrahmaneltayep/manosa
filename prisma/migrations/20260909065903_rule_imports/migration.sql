-- CreateTable
CREATE TABLE "RuleImport" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "createdCount" INTEGER NOT NULL,
    "errorCount" INTEGER NOT NULL,
    "warningCount" INTEGER NOT NULL,
    "createdRuleIds" TEXT[],
    "undoableUntil" TIMESTAMP(3) NOT NULL,
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "RuleImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RuleImport_shop_createdAt_idx" ON "RuleImport"("shop", "createdAt");
