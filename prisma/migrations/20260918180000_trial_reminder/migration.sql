-- Checklist §9 asks for a "your trial ends in three days" email and there was
-- none: the only warning was an in-app banner, on the one page a merchant whose
-- trial is ending may not be looking at. Stamped so it is sent once per trial.
ALTER TABLE "Shop" ADD COLUMN "trialReminderSentAt" TIMESTAMP(3);
