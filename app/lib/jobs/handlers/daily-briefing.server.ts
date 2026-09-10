import { db } from "~/db.server";
import { isAiAvailable } from "~/lib/ai/client.server";
import { generateBriefing } from "~/lib/agent/briefing.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * This morning's briefing, written before the merchant opens the app.
 *
 * A job rather than a page load, for the reason the checklist implies: a
 * briefing that regenerated on every refresh would say something different each
 * time, and a merchant cannot act on that. It is written once and shown until
 * the next one.
 *
 * Re-enqueues itself for tomorrow. A shop with no key, or on a plan without the
 * Merchant Agent, writes nothing and stops asking — the home page shows the
 * "switched off" state rather than an empty card with no explanation.
 */

/** How often a briefing is written. Daily, per the spec's "daily briefing". */
export const BRIEFING_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function dailyBriefing() {
  const shop = shopScope.require("dailyBriefing");
  const record = await db.shop.findUnique({ where: { shop } });

  // An uninstalled shop is the one case where the job genuinely stops: there is
  // nobody to brief, and `app/uninstalled` cancels the rest anyway.
  if (!record) return { skipped: "no install record" as const };
  if (record.uninstalledAt) return { skipped: "uninstalled" as const };

  // Tomorrow is queued *first*, and unconditionally. Returning early before
  // this is how the briefing stopped for good on a shop that was on the wrong
  // plan, or had no key, on the one day the job happened to run — upgrading or
  // adding a key later started nothing.
  await enqueueTomorrow();

  const entitlements = await loadEntitlements();
  if (!hasFeature(entitlements, "merchant_agent")) {
    return { skipped: "not on this plan" as const };
  }
  if (!isAiAvailable()) return { skipped: "no key" as const };

  const { briefing, failure } = await generateBriefing({
    locale: record.primaryLocale,
  });

  return {
    written: briefing !== null,
    quiet: briefing?.quiet ?? false,
    failure,
  };
}

async function enqueueTomorrow() {
  await enqueueJob({
    kind: "agent.daily_briefing",
    runAt: new Date(Date.now() + BRIEFING_INTERVAL_MS),
    replacePending: true,
  });
}

/**
 * Make sure this shop has a briefing job queued.
 *
 * Called on every admin page load, which is the only reliable way to reach a
 * shop that installed before the job existed — there is no backfill for a
 * schedule. `replacePending` makes it idempotent, so a merchant clicking
 * around does not queue a hundred of them.
 */
export async function ensureBriefingScheduled(): Promise<void> {
  shopScope.require("ensureBriefingScheduled");

  const queued = await db.scheduledJob.count({
    where: { kind: "agent.daily_briefing", status: "PENDING" },
  });
  if (queued > 0) return;

  await enqueueJob({
    kind: "agent.daily_briefing",
    runAt: new Date(),
    replacePending: true,
  });
}
