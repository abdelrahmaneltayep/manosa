-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "reviewFailedAt" TIMESTAMP(3),
ADD COLUMN     "reviewFailedMonth" TEXT,
ADD COLUMN     "reviewFailedReason" TEXT;
