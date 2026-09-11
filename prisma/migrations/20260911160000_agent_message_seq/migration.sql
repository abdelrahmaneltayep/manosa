-- Insertion order for a conversation's messages.
--
-- `answerBuyerTurn` stamps both halves of a turn with one `now`, so ordering a
-- thread by `createdAt` alone left the order of equal timestamps undefined —
-- and a merchant reading a transcript could find the agent's reply above the
-- question it answered.
ALTER TABLE "AgentMessage" ADD COLUMN "seq" SERIAL NOT NULL;

CREATE UNIQUE INDEX "AgentMessage_seq_key" ON "AgentMessage"("seq");

CREATE INDEX "AgentMessage_shop_conversationId_seq_idx"
  ON "AgentMessage"("shop", "conversationId", "seq");
