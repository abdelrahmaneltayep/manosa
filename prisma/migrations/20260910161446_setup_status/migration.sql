-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "embedConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "setupDismissedAt" TIMESTAMP(3),
ADD COLUMN     "storefrontSeenAt" TIMESTAMP(3);
