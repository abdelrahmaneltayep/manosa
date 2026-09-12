-- The PRODUCT discount class was never sent when the app's automatic discount
-- was created, so the Function was permitted to produce nothing. Shops created
-- before the fix are repaired once by `ensureDiscount`; this records that it
-- happened so it is not repeated on every page view.
ALTER TABLE "Shop" ADD COLUMN "discountClassesAt" TIMESTAMP(3);

-- Collection membership reaches checkout only through a product metafield, and
-- the only writers were the products/update and collections/update webhooks.
-- Every product on a store that installed Mannon with an existing catalogue was
-- therefore priced with no collections at all. These carry the one-off backfill
-- that fixes it.
ALTER TABLE "Shop" ADD COLUMN "productsBackfilledAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "productsBackfillCursor" TEXT;
ALTER TABLE "Shop" ADD COLUMN "productsPublished" INTEGER NOT NULL DEFAULT 0;
