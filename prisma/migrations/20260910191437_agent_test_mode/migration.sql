-- AlterTable
ALTER TABLE "AgentConversation" ADD COLUMN     "testMode" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AgentGuardrails" ADD COLUMN     "reviewedAt" TIMESTAMP(3);
