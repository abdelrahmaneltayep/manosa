import { db } from "~/db.server";
import { factsFromWebhook, upsertOrder } from "~/lib/orders/sync.server";
import type { WebhookContext } from "~/lib/webhooks/registry";

/**
 * An order cancelled in Shopify.
 *
 * The row stays and records the cancellation. A cancelled wholesale order is
 * still something a merchant needs to see — it is the row they are about to ask
 * their buyer about — and dropping it would also quietly change last month's
 * revenue figure.
 *
 * The payload is a whole order, so the mirror is refreshed from it rather than
 * only stamping a date: a cancellation usually comes with a refund, and the
 * list should show both at once.
 */
export async function handleOrdersCancelled({ shop, payload }: WebhookContext) {
  const record = await db.shop.findUnique({ where: { shop } });
  const facts = factsFromWebhook(payload, record?.currencyCode ?? "USD");

  if (!facts) {
    console.warn(`[mannon] orders/cancelled for ${shop} had no order id`);
    return;
  }

  const existing = await db.order.findFirst({
    where: { orderId: facts.orderId },
    select: { isWholesale: true },
  });

  await upsertOrder(facts, existing?.isWholesale ?? false, {
    // Cancelled at, from the payload, but never unset: an order that arrives
    // without the date after we recorded one has not been un-cancelled.
    cancelledAt: facts.cancelledAt ?? new Date(),
  });
}
