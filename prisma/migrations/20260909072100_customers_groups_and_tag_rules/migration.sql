-- CreateEnum
CREATE TYPE "BuyerStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "customerCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "customersBackfillCursor" TEXT,
ADD COLUMN     "customersBackfilledAt" TIMESTAMP(3),
ADD COLUMN     "requireVatForTaxExempt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "wholesaleTag" TEXT NOT NULL DEFAULT 'wholesale';

-- CreateTable
CREATE TABLE "CustomerGroup" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "color" TEXT,
    "description" TEXT,
    "tag" TEXT NOT NULL,
    "netTermsDays" INTEGER,
    "orderMinimum" INTEGER,
    "orderIncrement" INTEGER,
    "freeShippingOver" INTEGER,
    "visibleCollectionIds" TEXT[],
    "template" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "CustomerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "company" TEXT,
    "phone" TEXT,
    "countryCode" TEXT,
    "province" TEXT,
    "tags" TEXT[],
    "state" TEXT NOT NULL DEFAULT 'enabled',
    "taxExempt" BOOLEAN NOT NULL DEFAULT false,
    "vatNumber" TEXT,
    "vatVerifiedAt" TIMESTAMP(3),
    "groupId" TEXT,
    "status" "BuyerStatus" NOT NULL DEFAULT 'APPROVED',
    "lifetimeSpend" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "lastOrderAt" TIMESTAMP(3),
    "internalNote" TEXT,
    "deletedInShopifyAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerTagRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "matchMode" TEXT NOT NULL DEFAULT 'all',
    "conditions" JSONB NOT NULL,
    "addTags" TEXT[],
    "removeTags" TEXT[],
    "lastRunAt" TIMESTAMP(3),
    "lastMatchCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "CustomerTagRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerGroup_shop_sortOrder_idx" ON "CustomerGroup"("shop", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerGroup_shop_handle_key" ON "CustomerGroup"("shop", "handle");

-- CreateIndex
CREATE INDEX "Customer_shop_status_lastOrderAt_idx" ON "Customer"("shop", "status", "lastOrderAt");

-- CreateIndex
CREATE INDEX "Customer_shop_groupId_idx" ON "Customer"("shop", "groupId");

-- CreateIndex
CREATE INDEX "Customer_shop_email_idx" ON "Customer"("shop", "email");

-- CreateIndex
CREATE INDEX "Customer_shop_deletedInShopifyAt_idx" ON "Customer"("shop", "deletedInShopifyAt");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_shop_customerId_key" ON "Customer"("shop", "customerId");

-- CreateIndex
CREATE INDEX "CustomerTagRule_shop_enabled_priority_idx" ON "CustomerTagRule"("shop", "enabled", "priority");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CustomerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

