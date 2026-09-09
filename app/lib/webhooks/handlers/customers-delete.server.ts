import { customerIdFromPayload, markCustomerDeleted } from "~/lib/customers/sync.server";
import type { WebhookContext } from "~/lib/webhooks/registry";

/**
 * A customer removed in Shopify.
 *
 * The mirror row is flagged rather than deleted. A merchant looking at the
 * buyers list should see "deleted in Shopify" against the row they were about
 * to act on, not find it silently missing and wonder whether they imagined it;
 * group member counts stay explainable; and the retention job (7.2) is what
 * eventually removes the row for good.
 *
 * Nothing is published to Shopify here: the customer is gone, so their
 * metafield went with them.
 */
export async function handleCustomersDelete({ shop, payload }: WebhookContext) {
  const customerId = customerIdFromPayload(payload);

  if (!customerId) {
    console.warn(`[mannon] customers/delete for ${shop} had no customer id`);
    return;
  }

  const marked = await markCustomerDeleted(customerId);

  if (marked === 0) {
    // Never mirrored — a retail customer the backfill had not reached. Nothing
    // to do, and not an error.
    console.info(`[mannon] customers/delete for ${shop}: ${customerId} was not mirrored`);
  }
}
