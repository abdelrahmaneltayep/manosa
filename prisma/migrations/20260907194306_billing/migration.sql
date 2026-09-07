-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('NONE', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED');

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "billingInterval" TEXT,
ADD COLUMN     "billingStatus" "BillingStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "billingSyncedAt" TIMESTAMP(3),
ADD COLUMN     "currentPeriodEnd" TIMESTAMP(3),
ADD COLUMN     "graceEndsAt" TIMESTAMP(3),
ADD COLUMN     "isTestSubscription" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "planKey" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN     "subscriptionId" TEXT,
ADD COLUMN     "subscriptionName" TEXT,
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);
