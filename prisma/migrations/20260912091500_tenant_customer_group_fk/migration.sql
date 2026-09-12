
-- Customer -> CustomerGroup, the one `SET NULL` relation.
--
-- A plain composite `SET NULL` would try to null `shop` as well, which is NOT
-- NULL. Postgres 15+ can null a named subset, which is exactly what is wanted:
-- when a merchant deletes a group its members stay theirs and fall back to
-- tag-only pricing, which is a real product state the buyers list shows with a
-- banner.
--
-- Prisma cannot express the column list, so its own `onDelete: SetNull` reads
-- as the whole key. That is a schema/SQL difference on paper only — referential
-- actions are executed by Postgres, never by the client.
ALTER TABLE "Customer" DROP CONSTRAINT "Customer_groupId_fkey";
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_shop_groupId_fkey"
  FOREIGN KEY ("shop", "groupId") REFERENCES "CustomerGroup"("shop", "id")
  ON DELETE SET NULL ("groupId") ON UPDATE CASCADE;
