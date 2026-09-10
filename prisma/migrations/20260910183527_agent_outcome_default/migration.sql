-- The new value is committed by now, so it can be a default.
ALTER TABLE "AgentConversation" ALTER COLUMN "outcome" SET DEFAULT 'FAILED';
