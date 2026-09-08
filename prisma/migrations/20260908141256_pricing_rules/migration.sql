-- CreateEnum
CREATE TYPE "PricingRuleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PricingRuleKind" AS ENUM ('FIXED_PRICE', 'VOLUME_TIER', 'CART_VALUE_TIER', 'AMOUNT_OFF', 'PERCENTAGE');

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "PricingRuleStatus" NOT NULL DEFAULT 'DRAFT',
    "kind" "PricingRuleKind" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "combinable" BOOLEAN NOT NULL DEFAULT false,
    "value" JSONB NOT NULL,
    "targets" JSONB NOT NULL,
    "audience" JSONB NOT NULL,
    "markets" JSONB NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "missingTargetCount" INTEGER NOT NULL DEFAULT 0,
    "usageCount30d" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PricingRule_shop_status_priority_idx" ON "PricingRule"("shop", "status", "priority");

-- CreateIndex
CREATE INDEX "PricingRule_shop_archivedAt_idx" ON "PricingRule"("shop", "archivedAt");

-- CreateIndex
CREATE INDEX "PricingRule_shop_updatedAt_idx" ON "PricingRule"("shop", "updatedAt");
