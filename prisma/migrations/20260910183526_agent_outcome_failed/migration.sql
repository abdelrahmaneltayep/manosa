-- Adding an enum value and using it as a default cannot happen in one
-- transaction: Postgres refuses "unsafe use of new value" until the ADD VALUE
-- has committed. So the value lands here and the default in the next migration.
ALTER TYPE "AgentOutcome" ADD VALUE 'FAILED';
