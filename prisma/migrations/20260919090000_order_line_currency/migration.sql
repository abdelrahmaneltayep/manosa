-- Every amount on an OrderLine is minor units, and until now the currency they
-- were in lived only on the parent order. A reader that queried the table
-- without joining summed across currencies silently.
ALTER TABLE "OrderLine" ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT '';

UPDATE "OrderLine" AS l
SET "currencyCode" = o."currencyCode"
FROM "Order" AS o
WHERE o."id" = l."orderId" AND o."shop" = l."shop";

-- The default existed only to add the column to rows that already had values.
-- Leaving it would let a future insert write an empty currency, which is the
-- same silence in a new place.
ALTER TABLE "OrderLine" ALTER COLUMN "currencyCode" DROP DEFAULT;
