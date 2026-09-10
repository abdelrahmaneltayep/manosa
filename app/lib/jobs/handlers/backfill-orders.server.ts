import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import { fetchOrderPage, ORDER_PAGE_SIZE } from "~/lib/orders/admin-graphql.server";
import { factsFromNode, isWholesaleOrder, upsertOrder } from "~/lib/orders/sync.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { unauthenticated } from "~/shopify.server";

/**
 * Copy a store's existing orders into the mirror, one page at a time.
 *
 * Webhooks only tell us about orders placed from now on. A store installing
 * Mannon with wholesale buyers who already order would otherwise see an empty
 * Orders page and no revenue figures until someone happened to check out.
 *
 * **This reaches 60 days back, not further.** `read_orders` is capped there by
 * Shopify unless an app is granted `read_all_orders`, which is a review-time
 * request and not something to assume. The page says so rather than presenting
 * a partial history as the whole of it.
 *
 * One page per run, then it re-queues itself with the cursor, for the same
 * reason as the customers backfill: a request-triggered runner has a timeout.
 */
export type AdminForShop = (shop: string) => Promise<AdminGraphql>;

const offlineAdmin: AdminForShop = async (shop) => {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
};

export async function backfillOrders(adminFor: AdminForShop = offlineAdmin) {
  const shop = shopScope.require("backfillOrders");
  const record = await db.shop.findUnique({ where: { shop } });

  if (!record) return { skipped: "no install record" as const };
  if (record.uninstalledAt) return { skipped: "uninstalled" as const };

  const admin = await adminFor(shop);
  const page = await fetchOrderPage(admin, record.ordersBackfillCursor);

  let wholesale = 0;

  for (const node of page.nodes) {
    const facts = factsFromNode(node, record.currencyCode ?? "USD");

    // Existing orders are not tagged in Shopify. Writing a tag onto hundreds of
    // historical orders on install is a lot of noise in a merchant's admin for
    // something they did not ask for.
    const isWholesale = await isWholesaleOrder(facts, record.wholesaleTag);
    await upsertOrder(facts, isWholesale);
    if (isWholesale) wholesale += 1;
  }

  if (page.hasNextPage && page.endCursor) {
    await db.shop.update({
      where: { shop },
      data: { ordersBackfillCursor: page.endCursor },
    });
    await enqueueJob({ kind: "orders.backfill", runAt: new Date() });
    return { synced: page.nodes.length, wholesale, done: false };
  }

  await db.shop.update({
    where: { shop },
    data: { ordersBackfillCursor: null, ordersBackfilledAt: new Date() },
  });

  const wholesaleCount = await db.order.count({ where: { isWholesale: true } });

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "order.backfill_finished",
    summary: `Imported the last 60 days of orders from Shopify — ${wholesaleCount} of them wholesale.`,
    subject: { type: "Shop", id: shop },
    metadata: { wholesaleCount },
  });

  return { synced: page.nodes.length, wholesale, done: true, wholesaleCount };
}

/** How many orders one run reads. Exported for the tests to assert on. */
export const BACKFILL_PAGE_SIZE = ORDER_PAGE_SIZE;
