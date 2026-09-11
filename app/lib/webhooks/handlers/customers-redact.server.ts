import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { redactBuyer } from "~/lib/privacy/buyer-data.server";
import { identityFrom } from "~/lib/webhooks/handlers/customers-data-request.server";
import type { WebhookContext } from "~/lib/webhooks/registry";

/**
 * `customers/redact` — remove one buyer.
 *
 * Mandatory, and sent by Shopify 10 days after the merchant asks (or 6 months
 * after the customer's last order, if there are outstanding ones). By the time
 * it arrives the decision has been made elsewhere; there is nothing here to
 * confirm and nobody to ask.
 *
 * Idempotent, because Shopify delivers at least once: a second delivery finds
 * nothing left and says so rather than failing.
 */
export async function handleCustomersRedact({ shop, payload }: WebhookContext) {
  const identity = identityFrom(payload);

  if (!identity.customerId && !identity.email) {
    console.warn(`[mannon] customers/redact for ${shop} named nobody`);
    return;
  }

  const counts = await redactBuyer(identity);
  const removed = counts.customers + counts.applications + counts.conversations;

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "privacy.customer_redacted",
    summary:
      removed === 0 && counts.orders === 0
        ? `A buyer's data was requested for deletion. Mannon held nothing about this person.`
        : `Deleted a buyer's application, files, mail and conversations, and removed their name and address from ${counts.orders} order(s) and ${counts.quotes} quote(s) — which stay as the merchant's own business records.`,
    subject: { type: "Shop", id: shop },
    metadata: { ...counts, customerId: identity.customerId ?? null },
  });
}
