import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { nextRun as auditPurgeNextRun } from "~/lib/jobs/handlers/purge-audit.server";
import { cancelPendingJobs, enqueueJob } from "~/lib/jobs/queue.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { repairDiscountClasses } from "~/lib/pricing/ruleset.server";
import { syncShopFacts } from "~/lib/shop/domains.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";

/**
 * How stale the shop's own facts may get before they are read again.
 *
 * A merchant changes their currency or their timezone rarely, and `shop/update`
 * catches it when they do — this is the belt to that brace, for an install
 * whose webhook was missed.
 */
export const SHOP_FACTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
export async function ensureShopRecord(admin?: AdminGraphql) {
  const shop = shopScope.require("ensureShopRecord");
  const existing = await db.shop.findUnique({ where: { shop } });

  if (existing && !existing.uninstalledAt) {
    await refreshShopFacts(existing, admin);
    // Once per shop, and only for a discount created before the app sent
    // `discountClasses`: Shopify never granted it the one class the Function
    // produces, so that store has no wholesale pricing at checkout at all.
    // Here rather than in `ensureDiscount`, which runs only when rules are
    // published — a merchant whose rules are already set up would never have
    // reached it, and nothing would have told them to.
    if (admin) await repairDiscountClasses(admin, existing);
    return existing;
  }

  if (!existing) {
    const created = await db.shop.create({ data: { ...tenant() } });
    // The shop's own currency, timezone and name. Without this every money
    // figure in the admin is labelled with the fallback currency, and §7's
    // "timezone = store timezone" footer has nothing to state.
    await refreshShopFacts(created, admin);
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
    // And every existing product's collection membership, which reaches
    // checkout only through a metafield this app writes. Without it a rule
    // that excludes a collection excludes nothing at checkout, so the
    // discount lands on exactly the products the merchant protected.
    await enqueueJob({
      kind: "products.backfill",
      runAt: new Date(),
      replacePending: true,
    });
    // And the Merchant Agent's first briefing, which then re-enqueues itself
    // daily. Nothing is written for a shop without the key or the plan — the
    // home page says so rather than showing an empty card.
    await enqueueJob({
      kind: "agent.daily_briefing",
      runAt: new Date(),
      replacePending: true,
    });

    // The audit log's twelve-month retention, enforced from install. It used
    // to be scheduled only from `/app/activity` — so a merchant who read the
    // promise in Settings and never opened the log had a table that grew
    // forever, which is the promise broken by the page that makes it.
    await enqueueJob({
      kind: "audit.purge",
      runAt: auditPurgeNextRun(new Date()),
      replacePending: true,
    });
    return created;
  }

  const restored = await db.shop.update({
    where: { shop },
    // `piiPurgedAt` goes with `uninstalledAt`, and forgetting it was a silent
    // one-way door: the purge skips any shop that has one, so a merchant who
    // uninstalled, was purged, reinstalled and traded for a year was **never
    // purged again** — under copy promising deletion within 48 hours. The
    // stamp records that *the last uninstall* was dealt with; a new install is
    // a new life, and nothing in it has been purged.
    data: { uninstalledAt: null, piiPurgedAt: null },
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

  // A reinstall may have missed a catalogue's worth of collection changes, and
  // the metafields the app wrote before are still there — stale, which reads
  // to checkout exactly like correct.
  if (restored.productsBackfilledAt) {
    await db.shop.update({
      where: { shop },
      data: {
        productsBackfilledAt: null,
        productsBackfillCursor: null,
        productsPublished: 0,
      },
    });
    await enqueueJob({
      kind: "products.backfill",
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

  await refreshShopFacts(restored, admin);
  return restored;
}

/**
 * Read the shop's facts, if we have an admin client and they are stale.
 *
 * Never on every navigation: this costs an Admin API call, and a currency does
 * not change between two page views. Failure is swallowed inside
 * `syncShopFacts` — a page must not 500 because a fact could not be refreshed.
 */
async function refreshShopFacts(
  record: { shopFactsSyncedAt: Date | null },
  admin: AdminGraphql | undefined,
  now = new Date(),
): Promise<void> {
  if (!admin) return;

  const age = record.shopFactsSyncedAt
    ? now.getTime() - record.shopFactsSyncedAt.getTime()
    : Number.POSITIVE_INFINITY;
  if (age < SHOP_FACTS_MAX_AGE_MS) return;

  await syncShopFacts(admin);
}
