-- CreateEnum
CREATE TYPE "ScreeningVerdict" AS ENUM ('WAITING', 'RECOMMEND', 'LOOK', 'UNAVAILABLE', 'OFF');

-- AlterTable
ALTER TABLE "FormSubmission" ADD COLUMN     "screenedAt" TIMESTAMP(3),
ADD COLUMN     "screening" "ScreeningVerdict" NOT NULL DEFAULT 'WAITING',
ADD COLUMN     "screeningModel" TEXT,
ADD COLUMN     "screeningPromptVersion" TEXT,
ADD COLUMN     "screeningReasons" JSONB,
ADD COLUMN     "screeningRequestId" TEXT;

-- CreateTable
CREATE TABLE "CustomerSegment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "sentence" TEXT,
    "aiModel" TEXT,
    "aiPromptVersion" TEXT,
    "lastCount" INTEGER,
    "lastCountAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "CustomerSegment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerSegment_shop_updatedAt_idx" ON "CustomerSegment"("shop", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSegment_shop_name_key" ON "CustomerSegment"("shop", "name");
