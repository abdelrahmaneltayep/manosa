-- The 14-day trial could be taken repeatedly. Shopify issues whatever the
-- billing config asks for, and nothing recorded that a shop had already had
-- one — so cancel-and-resubscribe, or the monthly/annual toggle on the Plans
-- page, bought another fortnight free every time.
ALTER TABLE "Shop" ADD COLUMN "trialUsedAt" TIMESTAMP(3);
