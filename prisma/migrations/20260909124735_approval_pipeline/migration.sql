-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "FormSubmission" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedAutomatically" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "decidedBy" TEXT,
ADD COLUMN     "decisionNote" TEXT,
ADD COLUMN     "rejectionCode" TEXT,
ADD COLUMN     "undoableUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RegistrationForm" ADD COLUMN     "approval" JSONB;

-- CreateTable
CREATE TABLE "BlockedDomain" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "BlockedDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "transport" TEXT,
    "submissionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BlockedDomain_shop_createdAt_idx" ON "BlockedDomain"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedDomain_shop_domain_key" ON "BlockedDomain"("shop", "domain");

-- CreateIndex
CREATE INDEX "EmailMessage_shop_createdAt_idx" ON "EmailMessage"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "EmailMessage_shop_submissionId_idx" ON "EmailMessage"("shop", "submissionId");

-- CreateIndex
CREATE INDEX "EmailMessage_shop_status_idx" ON "EmailMessage"("shop", "status");
