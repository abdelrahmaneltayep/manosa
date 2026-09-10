-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "productId" TEXT,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" INTEGER NOT NULL DEFAULT 0,
    "originalTotal" INTEGER NOT NULL DEFAULT 0,
    "discountedTotal" INTEGER NOT NULL DEFAULT 0,
    "discounts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderLine_shop_orderId_idx" ON "OrderLine"("shop", "orderId");

-- CreateIndex
CREATE INDEX "OrderLine_shop_productId_idx" ON "OrderLine"("shop", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_shop_lineItemId_key" ON "OrderLine"("shop", "lineItemId");

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
