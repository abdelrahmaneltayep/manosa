import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { cancelPendingJobs } from "~/lib/jobs/queue.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";

/**
 * Make sure the install record exists for the active tenant.
 *
 * Called from the /app layout loader, so it runs on the first authenticated
 * page view after install. Cheap enough per navigation: one indexed read, and
 * a write only when something actually changed.
 *
 * The reinstall path matters. A merchant who removes the app and puts it back
 * within 48 hours must not lose their setup to the scheduled PII purge, so
 * seeing them again cancels it.
 */
export async function ensureShopRecord() {
  const shop = shopScope.require("ensureShopRecord");
  const existing = await db.shop.findUnique({ where: { shop } });

  if (!existing) {
    const created = await db.shop.create({ data: { ...tenant() } });
    await recordAudit({
      actor: SYSTEM_ACTOR,
      action: "app.installed",
      summary: `Mannon installed on ${shop}.`,
      subject: { type: "Shop", id: shop },
    });
    return created;
  }

  if (!existing.uninstalledAt) return existing;

  const restored = await db.shop.update({
    where: { shop },
    data: { uninstalledAt: null },
  });
  const cancelled = await cancelPendingJobs("shop.purge_pii");

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "app.reinstalled",
    summary:
      cancelled > 0
        ? `Mannon reinstalled on ${shop}. The scheduled deletion of your data was cancelled and your previous setup is intact.`
        : `Mannon reinstalled on ${shop}.`,
    subject: { type: "Shop", id: shop },
    metadata: {
      cancelledPurgeJobs: cancelled,
      piiAlreadyPurged: Boolean(existing.piiPurgedAt),
    },
  });

  return restored;
}
