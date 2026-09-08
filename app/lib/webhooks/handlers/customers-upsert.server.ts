import { publishBuyerFacts } from "~/lib/pricing/buyer-facts.server";
import type { WebhookContext } from "~/lib/webhooks/registry";
import { unauthenticated } from "~/shopify.server";

/**
 * Keep each buyer's checkout facts in step with their Shopify tags.
 *
 * A tag change is how a merchant approves someone for wholesale, so this is
 * the moment their price actually changes. Until it runs, the admin would show
 * a wholesale price the checkout does not honour — the exact disagreement
 * Mannon exists to prevent.
 */
interface CustomerPayload {
  admin_graphql_api_id?: string;
  id?: number;
  tags?: string | string[] | null;
}

export async function handleCustomersUpsert({ shop, payload }: WebhookContext) {
  const customer = payload as CustomerPayload;
  const customerId =
    customer.admin_graphql_api_id ??
    (customer.id ? `gid://shopify/Customer/${customer.id}` : null);

  if (!customerId) {
    console.warn(`[mannon] customers webhook for ${shop} had no customer id`);
    return;
  }

  // Webhooks arrive without a session, so the offline token is loaded here.
  const { admin } = await unauthenticated.admin(shop);

  // Groups land in phase 2.1; tags are what gate wholesale pricing today.
  await publishBuyerFacts(admin, customerId, { tags: customer.tags ?? [], groupIds: [] });
}
