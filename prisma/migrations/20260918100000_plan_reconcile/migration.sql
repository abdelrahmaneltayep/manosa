-- A lapsed plan used to pause nothing. Pricing rules over quota, order limits
-- and net terms all reach checkout through metafields this app writes, so the
-- gate on editing them stopped none of them: a merchant who cancelled kept
-- every one of them running, for ever, under copy saying paid features are
-- paused. `billing.reconcile` republishes what the effective plan allows; these
-- carry its progress through the buyers whose terms have to be withdrawn.
ALTER TABLE "Shop" ADD COLUMN "planReconcileCursor" TEXT;
ALTER TABLE "Shop" ADD COLUMN "planReconciledAt" TIMESTAMP(3);
