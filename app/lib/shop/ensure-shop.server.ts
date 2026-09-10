import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { cancelPendingJobs, enqueueJob } from "~/lib/jobs/queue.server";
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
    // Webhooks only report customers who change. Without this, a store with an
    // existing wholesale customer base sees an empty Customers page until each
    // buyer happens to be edited.
    await enqueueJob({
      kind: "customers.backfill",
      runAt: new Date(),
      replacePending: true,
    });
    // And the same for orders, so the Orders page and the dashboard's revenue
    // figures are not empty on a store that already sells wholesale.
    await enqueueJob({
      kind: "orders.backfill",
      runAt: new Date(),
      replacePending: true,
    });
    return created;
  }

  if (!existing.uninstalledAt) return existing;

  const restored = await db.shop.update({
    where: { shop },
    data: { uninstalledAt: null },
  });
  const cancelled = await cancelPendingJobs("shop.purge_pii");

  // A reinstall may have missed months of customer changes while the app was
  // gone, and webhooks do not backfill. Only when the previous run finished:
  // an interrupted one is still queued with its cursor.
  if (restored.customersBackfilledAt) {
    await db.shop.update({
      where: { shop },
      data: { customersBackfilledAt: null, customersBackfillCursor: null },
    });
    await enqueueJob({
      kind: "customers.backfill",
      runAt: new Date(),
      replacePending: true,
    });
  }

  if (restored.ordersBackfilledAt) {
    await db.shop.update({
      where: { shop },
      data: { ordersBackfilledAt: null, ordersBackfillCursor: null },
    });
    await enqueueJob({
      kind: "orders.backfill",
      runAt: new Date(),
      replacePending: true,
    });
  }

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
