-- CreateEnum
CREATE TYPE "AgentOutcome" AS ENUM ('ANSWERED', 'CART', 'QUOTE', 'ESCALATED', 'DECLINED');

-- CreateEnum
CREATE TYPE "AgentRole" AS ENUM ('BUYER', 'AGENT', 'MERCHANT');

-- CreateTable
CREATE TABLE "AgentGuardrails" (
    "shop" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "canBuildCart" BOOLEAN NOT NULL DEFAULT true,
    "canRequestQuote" BOOLEAN NOT NULL DEFAULT true,
    "canReadOrders" BOOLEAN NOT NULL DEFAULT true,
    "canReadTerms" BOOLEAN NOT NULL DEFAULT true,
    "guestMode" BOOLEAN NOT NULL DEFAULT false,
    "tone" TEXT NOT NULL DEFAULT 'warm',
    "customInstructions" TEXT,
    "offLimits" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "AgentGuardrails_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "AgentConversation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT,
    "company" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "outcome" "AgentOutcome" NOT NULL DEFAULT 'ANSWERED',
    "takenOverAt" TIMESTAMP(3),
    "takenOverBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "AgentRole" NOT NULL,
    "text" TEXT NOT NULL,
    "toolCalls" JSONB,
    "refusal" TEXT,
    "aiModel" TEXT,
    "aiPromptVersion" TEXT,
    "aiRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentConversation_shop_lastMessageAt_idx" ON "AgentConversation"("shop", "lastMessageAt");

-- CreateIndex
CREATE INDEX "AgentConversation_shop_customerId_idx" ON "AgentConversation"("shop", "customerId");

-- CreateIndex
CREATE INDEX "AgentMessage_shop_conversationId_createdAt_idx" ON "AgentMessage"("shop", "conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
