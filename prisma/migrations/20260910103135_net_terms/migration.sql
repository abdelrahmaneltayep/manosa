-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "autoRemind" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "creditLimit" INTEGER,
ADD COLUMN     "netTermsDays" INTEGER;

-- AlterTable
ALTER TABLE "CustomerGroup" ADD COLUMN     "creditLimit" INTEGER;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "amountPaid" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "remindedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "paymentCustomizationId" TEXT,
ADD COLUMN     "paymentFunctionId" TEXT,
ADD COLUMN     "termsMethodName" TEXT NOT NULL DEFAULT 'Net terms',
ADD COLUMN     "termsOverdueBlocks" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "termsPublishedAt" TIMESTAMP(3),
ADD COLUMN     "termsSettingsHash" TEXT,
ADD COLUMN     "termsShowDays" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payment_shop_orderId_idx" ON "Payment"("shop", "orderId");

-- CreateIndex
CREATE INDEX "Payment_shop_receivedAt_idx" ON "Payment"("shop", "receivedAt");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
