-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('NEW', 'DRAFTED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "QuoteSource" AS ENUM ('MERCHANT', 'STOREFRONT', 'BUYER_AGENT');

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "quoteCounter" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN     "quoteExpiryDays" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "quoteReminderDays" INTEGER NOT NULL DEFAULT 3;

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "customerId" TEXT,
    "email" TEXT,
    "company" TEXT,
    "status" "QuoteStatus" NOT NULL DEFAULT 'NEW',
    "source" "QuoteSource" NOT NULL DEFAULT 'MERCHANT',
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "subtotal" INTEGER NOT NULL DEFAULT 0,
    "requestNote" TEXT,
    "message" TEXT,
    "internalNote" TEXT,
    "expiresAt" TIMESTAMP(3),
    "expiryDays" INTEGER,
    "lockedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "draftOrderId" TEXT,
    "draftOrderName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLine" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" INTEGER NOT NULL,
    "listPrice" INTEGER NOT NULL,
    "appliedRuleIds" TEXT[],
    "ruleSummary" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Quote_publicId_key" ON "Quote"("publicId");

-- CreateIndex
CREATE INDEX "Quote_shop_status_createdAt_idx" ON "Quote"("shop", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Quote_shop_expiresAt_idx" ON "Quote"("shop", "expiresAt");

-- CreateIndex
CREATE INDEX "Quote_shop_customerId_idx" ON "Quote"("shop", "customerId");

-- CreateIndex
CREATE INDEX "QuoteLine_shop_quoteId_idx" ON "QuoteLine"("shop", "quoteId");

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
