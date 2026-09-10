-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "briefingFailedAt" TIMESTAMP(3),
ADD COLUMN     "briefingFailedReason" TEXT;
