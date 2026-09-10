-- AlterTable
ALTER TABLE "AgentConversation" ADD COLUMN     "guestKey" TEXT;

-- CreateIndex
CREATE INDEX "AgentConversation_shop_guestKey_idx" ON "AgentConversation"("shop", "guestKey");
