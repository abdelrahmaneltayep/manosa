-- CreateEnum
CREATE TYPE "FormStatus" AS ENUM ('DRAFT', 'LIVE');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SPAM');

-- CreateEnum
CREATE TYPE "VatCheckStatus" AS ENUM ('NONE', 'VALID', 'INVALID', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "FormEventKind" AS ENUM ('VIEW', 'SUBMIT');

-- CreateTable
CREATE TABLE "RegistrationForm" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "FormStatus" NOT NULL DEFAULT 'DRAFT',
    "publicId" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "appearance" JSONB NOT NULL,
    "emails" JSONB NOT NULL,
    "publish" JSONB NOT NULL,
    "template" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "RegistrationForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormSubmission" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "answers" JSONB NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "vatNumber" TEXT,
    "vatStatus" "VatCheckStatus" NOT NULL DEFAULT 'NONE',
    "vatNote" TEXT,
    "spamReason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "customerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormUpload" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "submissionId" TEXT,
    "fieldKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "scannedAt" TIMESTAMP(3),
    "quarantinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "kind" "FormEventKind" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationForm_publicId_key" ON "RegistrationForm"("publicId");

-- CreateIndex
CREATE INDEX "RegistrationForm_shop_status_updatedAt_idx" ON "RegistrationForm"("shop", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationForm_shop_slug_key" ON "RegistrationForm"("shop", "slug");

-- CreateIndex
CREATE INDEX "FormSubmission_shop_status_createdAt_idx" ON "FormSubmission"("shop", "status", "createdAt");

-- CreateIndex
CREATE INDEX "FormSubmission_shop_formId_createdAt_idx" ON "FormSubmission"("shop", "formId", "createdAt");

-- CreateIndex
CREATE INDEX "FormSubmission_shop_email_idx" ON "FormSubmission"("shop", "email");

-- CreateIndex
CREATE INDEX "FormSubmission_shop_ip_createdAt_idx" ON "FormSubmission"("shop", "ip", "createdAt");

-- CreateIndex
CREATE INDEX "FormUpload_shop_submissionId_idx" ON "FormUpload"("shop", "submissionId");

-- CreateIndex
CREATE INDEX "FormEvent_shop_formId_kind_at_idx" ON "FormEvent"("shop", "formId", "kind", "at");

-- CreateIndex
CREATE INDEX "FormEvent_at_idx" ON "FormEvent"("at");

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "RegistrationForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormUpload" ADD CONSTRAINT "FormUpload_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "FormSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormEvent" ADD CONSTRAINT "FormEvent_formId_fkey" FOREIGN KEY ("formId") REFERENCES "RegistrationForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
