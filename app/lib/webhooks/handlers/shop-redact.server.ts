import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import type { WebhookContext } from "~/lib/webhooks/registry";

/**
 * `shop/redact` — 48 hours after the app was uninstalled, remove the shop.
 *
 * Mandatory. It overlaps with what `app/uninstalled` already scheduled, and
 * that is the point: the uninstall webhook schedules the purge at +47h from
 * *our* clock, and this one arrives when *Shopify* says the window is up. Two
 * signals for the same promise, and the job is idempotent, so whichever lands
 * first does the work and the other finds it done.
 *
 * It runs the purge **now** rather than waiting for the scheduled one: by the
 * time Shopify sends this, the 48 hours a merchant had to change their mind
 * are over.
 */
export async function handleShopRedact({ shop }: WebhookContext) {
  const record = await db.shop.findUnique({ where: { shop } });

  if (record && !record.uninstalledAt) {
    // Shopify says redact a shop that looks installed here. Believe Shopify —
    // they only send this after an uninstall — but record the disagreement,
    // because the alternative is deleting a live merchant's data on a webhook
    // we did not expect.
    console.warn(`[mannon] shop/redact for ${shop}, which has no uninstall recorded`);
    await db.shop.update({ where: { shop }, data: { uninstalledAt: new Date() } });
  }

  if (!record) {
    // Uninstalled before any authenticated page view. Nothing to purge, and
    // recording it is how somebody later can tell that from a missed webhook.
    await db.shop.create({ data: { shop, uninstalledAt: new Date() } });
  }

  // Due now: the window this waits for has already passed.
  await enqueueJob({ kind: "shop.purge_pii", runAt: new Date(), replacePending: true });

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "privacy.shop_redact_requested",
    summary: `Shopify asked for this shop's data to be removed. The purge is queued to run now.`,
    subject: { type: "Shop", id: shop },
  });
}
