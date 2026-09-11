import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import type { WebhookContext } from "~/lib/webhooks/registry";

/**
 * `shop/redact` — Shopify's own signal that a shop's data should go.
 *
 * Sent 48 hours after an uninstall. It overlaps with what `app/uninstalled`
 * already scheduled, and that is the point: two signals for one promise, and
 * the job is idempotent, so whichever lands first does the work.
 *
 * **It never purges a shop this app believes is installed.** The first version
 * of this handler stamped `uninstalledAt` onto a shop that had none and then
 * queued the purge to run immediately — which meant one delivery for a shop
 * whose `app/uninstalled` we had missed, or one replay with an unseen webhook
 * id, deleted a live merchant's entire dataset with their staff still logged
 * in. The purge's only guard against that is the `uninstalledAt` this handler
 * was writing.
 *
 * So a shop we have no uninstall for is treated exactly as an uninstall: it is
 * tombstoned and the purge is scheduled for the same +47h `app/uninstalled`
 * uses, which is the window in which any authenticated page view clears the
 * tombstone and cancels the job. If they really are gone, no page view
 * happens and the purge runs. If they are not, the merchant is still here to
 * stop it — which is the whole reason that delay exists.
 */
const CATCH_UP_DELAY_MS = 47 * 60 * 60 * 1000;

export async function handleShopRedact({ shop }: WebhookContext) {
  const record = await db.shop.findUnique({ where: { shop } });
  const known = record?.uninstalledAt ?? null;

  if (!record) {
    // Uninstalled before any authenticated page view ever ran. Recording it is
    // how somebody later tells that from a missed webhook.
    await db.shop.create({ data: { shop, uninstalledAt: new Date() } });
  } else if (!known) {
    console.warn(`[mannon] shop/redact for ${shop}, which has no uninstall recorded`);
    await db.shop.update({ where: { shop }, data: { uninstalledAt: new Date() } });
  }

  await enqueueJob({
    kind: "shop.purge_pii",
    // Now only when we already knew they were gone. Otherwise the same delay
    // an uninstall gets, so a merchant who is in fact still trading has their
    // next page view to cancel it.
    runAt: known ? new Date() : new Date(Date.now() + CATCH_UP_DELAY_MS),
    replacePending: true,
  });

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "privacy.shop_redact_requested",
    summary: known
      ? `Shopify asked for this shop's data to be removed. The purge is queued to run now.`
      : `Shopify asked for this shop's data to be removed, but Mannon has no record of an uninstall. Treating it as one: the purge is queued for 47 hours from now, and opening Mannon before then cancels it.`,
    subject: { type: "Shop", id: shop },
    metadata: { hadUninstallRecord: known !== null },
  });
}
