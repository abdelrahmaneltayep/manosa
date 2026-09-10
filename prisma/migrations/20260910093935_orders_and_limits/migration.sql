/*
  Warnings:

  - You are about to drop the column `orderIncrement` on the `CustomerGroup` table. All the data in the column will be lost.
  - You are about to drop the column `orderMinimum` on the `CustomerGroup` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('STOREFRONT', 'QUICK_ORDER', 'BUYER_AGENT', 'DRAFT', 'POS', 'OTHER');

-- AlterTable
ALTER TABLE "CustomerGroup" DROP COLUMN "orderIncrement",
DROP COLUMN "orderMinimum";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "limitsHash" TEXT,
ADD COLUMN     "limitsPublishedAt" TIMESTAMP(3),
ADD COLUMN     "ordersBackfillCursor" TEXT,
ADD COLUMN     "ordersBackfilledAt" TIMESTAMP(3),
ADD COLUMN     "posBypassesLimits" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "wholesaleOrderTag" TEXT NOT NULL DEFAULT 'wholesale';

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customerId" TEXT,
    "email" TEXT,
    "company" TEXT,
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "totalPrice" INTEGER NOT NULL DEFAULT 0,
    "subtotalPrice" INTEGER NOT NULL DEFAULT 0,
    "refundedAmount" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "totalQuantity" INTEGER NOT NULL DEFAULT 0,
    "source" "OrderSource" NOT NULL DEFAULT 'STOREFRONT',
    "sourceName" TEXT,
    "tags" TEXT[],
    "isWholesale" BOOLEAN NOT NULL DEFAULT false,
    "netTermsDueAt" TIMESTAMP(3),
    "netTermsDays" INTEGER,
    "paidAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "shopifyUpdatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "needsResync" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLimit" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "groupId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minSubtotal" INTEGER,
    "maxSubtotal" INTEGER,
    "minQuantity" INTEGER,
    "maxQuantity" INTEGER,
    "quantityIncrement" INTEGER,
    "countries" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "OrderLimit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_shop_processedAt_idx" ON "Order"("shop", "processedAt");

-- CreateIndex
CREATE INDEX "Order_shop_isWholesale_processedAt_idx" ON "Order"("shop", "isWholesale", "processedAt");

-- CreateIndex
CREATE INDEX "Order_shop_netTermsDueAt_idx" ON "Order"("shop", "netTermsDueAt");

-- CreateIndex
CREATE INDEX "Order_shop_customerId_idx" ON "Order"("shop", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shop_orderId_key" ON "Order"("shop", "orderId");

-- CreateIndex
CREATE INDEX "OrderLimit_shop_enabled_idx" ON "OrderLimit"("shop", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLimit_shop_groupId_key" ON "OrderLimit"("shop", "groupId");

-- AddForeignKey
ALTER TABLE "OrderLimit" ADD CONSTRAINT "OrderLimit_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CustomerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
