import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { buyerData, type BuyerIdentity } from "~/lib/privacy/buyer-data.server";
import type { WebhookContext, WebhookPayload } from "~/lib/webhooks/registry";

/**
 * `customers/data_request` — somebody has asked what this shop holds on them.
 *
 * Mandatory for every app in Shopify's store. Shopify asks **the app**; the
 * merchant answers **the person**, because the merchant is the controller and
 * the one who has met them. So this does not email anybody: it counts what is
 * here and writes it to the audit log, which is the place a merchant already
 * looks and the place a regulator would.
 *
 * Counts rather than the rows themselves. The audit log is read in a list, and
 * pasting a buyer's order history into it would answer a request about their
 * data by copying their data somewhere new.
 */
export function identityFrom(payload: WebhookPayload): BuyerIdentity {
  const customer = (payload.customer ?? {}) as Record<string, unknown>;
  const id = customer.id;

  return {
    customerId:
      typeof customer.admin_graphql_api_id === "string"
        ? customer.admin_graphql_api_id
        : id === undefined || id === null
          ? null
          : `gid://shopify/Customer/${String(id)}`,
    email: typeof customer.email === "string" ? customer.email : null,
  };
}

export async function handleCustomersDataRequest({ shop, payload }: WebhookContext) {
  const identity = identityFrom(payload);

  if (!identity.customerId && !identity.email) {
    console.warn(`[mannon] customers/data_request for ${shop} named nobody`);
    return;
  }

  const held = await buyerData(identity);
  const counts = Object.fromEntries(
    Object.entries(held).map(([area, rows]) => [area, rows.length]),
  );
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "privacy.data_requested",
    summary:
      total === 0
        ? `A buyer asked what Mannon holds about them. Mannon holds nothing about this person.`
        : `A buyer asked what Mannon holds about them: ${total} record(s) across ${Object.entries(
            counts,
          )
            .filter(([, count]) => count > 0)
            .map(([area]) => area)
            .join(", ")}. Open their buyer page to see it.`,
    subject: { type: "Shop", id: shop },
    // The shape of what is held, never the contents: an audit entry is read in
    // a list, and answering a question about somebody's data by copying it
    // somewhere new is not an answer.
    metadata: { ...counts, customerId: identity.customerId ?? null },
  });
}
