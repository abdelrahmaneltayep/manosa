import { db } from "~/db.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Make sure the install record exists for the active tenant.
 *
 * Called from the /app layout loader, so it runs on the first authenticated
 * page view after install (and heals the row if it was cleaned up by a
 * previous uninstall). Cheap enough to run per navigation: one upsert on a
 * unique index.
 */
export async function ensureShopRecord() {
  const shop = shopScope.require("ensureShopRecord");

  return db.shop.upsert({
    where: { shop },
    // Re-install after an uninstall: clear the tombstone, keep the history.
    update: { uninstalledAt: null },
    create: { shop },
  });
}
