import { markNeedsResync } from "~/lib/orders/sync.server";
import type { WebhookContext } from "~/lib/webhooks/registry";

/**
 * An order edited in Shopify's own admin.
 *
 * This payload is a *diff* — the line items added and removed — not the order.
 * It cannot be mirrored, so the row is flagged rather than rewritten from a
 * partial picture, and the list shows a resync badge against a total that is
 * honestly out of date.
 *
 * The `orders/updated` that follows the edit carries the whole order and clears
 * the flag. If it never arrives, the badge stays, which is the correct thing to
 * show a merchant looking at a number we know is stale.
 */
export async function handleOrdersEdited({ shop, payload }: WebhookContext) {
  const edit = (payload as { order_edit?: { order_id?: number | string } }).order_edit;
  const orderId = edit?.order_id;

  if (orderId === undefined || orderId === null) {
    console.warn(`[mannon] orders/edited for ${shop} had no order id`);
    return;
  }

  const flagged = await markNeedsResync(`gid://shopify/Order/${orderId}`, new Date());

  if (flagged === 0) {
    // A retail order, or one older than our 60-day reach. Nothing to do.
    console.info(`[mannon] orders/edited for ${shop}: ${orderId} was not mirrored`);
  }
}
