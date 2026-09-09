import { db } from "~/db.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { factsFromWebhook, upsertCustomer } from "~/lib/customers/sync.server";
import { publishBuyerFacts } from "~/lib/pricing/buyer-facts.server";
import type { WebhookContext } from "~/lib/webhooks/registry";
import { unauthenticated } from "~/shopify.server";

/**
 * Mirror a customer, and keep their checkout facts in step with their tags.
 *
 * A tag change is how a merchant approves someone for wholesale, so this is
 * the moment their price actually changes. Until it runs, the admin would show
 * a wholesale price the checkout does not honour — the exact disagreement
 * Mannon exists to prevent, so the metafield is published on every create and
 * update rather than only when we think it matters.
 */
/**
 * How a webhook reaches the Admin API. Injectable so the handler can be driven
 * in tests without a Shopify session — the alternative is not testing the one
 * path that decides whether a buyer gets their wholesale price.
 */
export type AdminForShop = (shop: string) => Promise<AdminGraphql>;

const offlineAdmin: AdminForShop = async (shop) => {
  // Webhooks arrive without a session, so the offline token is loaded here.
  const { admin } = await unauthenticated.admin(shop);
  return admin;
};

export async function handleCustomersUpsert(
  { shop, payload }: WebhookContext,
  adminFor: AdminForShop = offlineAdmin,
) {
  const record = await db.shop.findUnique({ where: { shop } });
  const facts = factsFromWebhook(payload, record?.currencyCode ?? "USD");

  if (!facts) {
    console.warn(`[mannon] customers webhook for ${shop} had no customer id`);
    return;
  }

  const saved = await upsertCustomer(facts);
  const admin = await adminFor(shop);

  await publishBuyerFacts(admin, saved.customerId, {
    tags: saved.tags,
    groupIds: saved.groupId ? [saved.groupId] : [],
  });
}
