-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "discountFunctionId" TEXT,
ADD COLUMN     "discountId" TEXT,
ADD COLUMN     "rulesetHash" TEXT,
ADD COLUMN     "rulesetPublishedAt" TIMESTAMP(3),
ADD COLUMN     "rulesetRuleCount" INTEGER NOT NULL DEFAULT 0;
