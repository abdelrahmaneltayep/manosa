-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "aiMayAutoApprove" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiMayDraft" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "aiMayScreen" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "BrandVoiceSample" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "BrandVoiceSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BrandVoiceSample_shop_createdAt_idx" ON "BrandVoiceSample"("shop", "createdAt");
