-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "allowShopifyDiscounts" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hidePricesFromGuests" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "senderCheckError" TEXT,
ADD COLUMN     "senderCheckedAt" TIMESTAMP(3),
ADD COLUMN     "senderDnsRecords" JSONB,
ADD COLUMN     "senderDomain" TEXT,
ADD COLUMN     "senderEmail" TEXT,
ADD COLUMN     "senderVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "showCompareAt" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "taxDisplay" TEXT NOT NULL DEFAULT 'excl',
ADD COLUMN     "taxExemptNeedsApproval" BOOLEAN NOT NULL DEFAULT true;
