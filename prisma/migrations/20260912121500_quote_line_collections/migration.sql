-- A quote is a promise, and the drift figure beside it compares today's rules
-- against the same line. Re-pricing that line with no collections reported a
-- drift that did not exist, so the membership is stored with the price.
--
-- Its own migration: Prisma records a migration by name, so appending to one
-- that has already been applied does nothing at all.
ALTER TABLE "QuoteLine" ADD COLUMN "collectionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
