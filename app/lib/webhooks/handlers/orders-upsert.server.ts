import { db } from "~/db.server";
import { tagOrder } from "~/lib/orders/admin-graphql.server";
import {
  factsFromWebhook,
  isWholesaleOrder,
  upsertOrder,
} from "~/lib/orders/sync.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import type { WebhookContext } from "~/lib/webhooks/registry";
import { unauthenticated } from "~/shopify.server";

/**
 * Mirror an order, and tag it in Shopify if a wholesale buyer placed it.
 *
 * `orders/create` and `orders/updated` both land here. An update carries the
 * whole order, so re-running the same work is not waste — it is how a refund,
 * an edit or a payment reaches the wholesale list at all.
 *
 * The tag is written once. A merchant who removed it deliberately should not
 * have it put back on the next update, which would be an app arguing with the
 * person using it.
 */
export type AdminForShop = (shop: string) => Promise<AdminGraphql>;

const offlineAdmin: AdminForShop = async (shop) => {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
};

export async function handleOrdersUpsert(
  { shop, payload, topic }: WebhookContext,
  adminFor: AdminForShop = offlineAdmin,
) {
  const record = await db.shop.findUnique({ where: { shop } });
  const facts = factsFromWebhook(payload, record?.currencyCode ?? "USD");

  if (!facts) {
    console.warn(`[mannon] ${topic} for ${shop} had no order id`);
    return;
  }

  const existing = await db.order.findFirst({
    where: { orderId: facts.orderId },
    select: { id: true, isWholesale: true },
  });

  // Decided once, on the way in. Approving a buyer today does not make the
  // order they placed last month a wholesale one, and re-deciding on every
  // update would silently rewrite the merchant's own revenue history.
  const isWholesale = existing
    ? existing.isWholesale
    : await isWholesaleOrder(facts, record?.wholesaleTag ?? "wholesale");

  await upsertOrder(facts, isWholesale);

  // Retail orders are mirrored but not tagged: this app has no business
  // labelling a store's ordinary orders. Nor is the tag re-applied on an
  // update — a merchant who removed it meant to.
  if (!isWholesale || existing) return;

  const orderTag = (record?.wholesaleOrderTag ?? "wholesale").trim();
  if (!orderTag) return;
  if (facts.tags.some((tag) => tag.toLowerCase() === orderTag.toLowerCase())) return;

  try {
    const admin = await adminFor(shop);
    await tagOrder(admin, facts.orderId, [orderTag]);
  } catch (error) {
    // A tag is a convenience in Shopify's own admin. Failing to write it must
    // not fail the webhook, because Shopify would then redeliver the whole
    // order for two days over a label.
    console.warn(
      `[mannon] could not tag ${facts.orderId} for ${shop}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
