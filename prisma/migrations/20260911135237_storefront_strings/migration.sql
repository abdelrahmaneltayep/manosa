-- CreateTable
CREATE TABLE "StorefrontString" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "aiFilled" BOOLEAN NOT NULL DEFAULT false,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "StorefrontString_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StorefrontString_shop_locale_idx" ON "StorefrontString"("shop", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "StorefrontString_shop_key_locale_key" ON "StorefrontString"("shop", "key", "locale");
