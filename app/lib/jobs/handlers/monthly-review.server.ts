import { db } from "~/db.server";
import { generateMonthlyReview, monthToReview } from "~/lib/analytics/review-run.server";
import { monthOf, monthStart, nextMonth } from "~/lib/analytics/review.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Last month's review, written on the first of this one.
 *
 * Checklist §7: "generated 1st of month, kept forever". A job rather than a
 * page load, for the same reason the daily briefing is one — a review that
 * regenerated on every visit would say something different each time, and a
 * merchant cannot read March against February if March keeps changing.
 *
 * The first of the month **in the shop's own timezone**: a Sydney merchant's
 * March begins while it is still February in UTC, and a review headed "March"
 * that was written from a February boundary is a review of something else.
 */
export async function monthlyReviewJob(now = new Date()) {
  const shop = shopScope.require("monthlyReviewJob");
  const record = await db.shop.findUnique({ where: { shop } });

  if (!record) return { skipped: "no install record" as const };
  if (record.uninstalledAt) return { skipped: "uninstalled" as const };

  // Next month is queued **first** and unconditionally. Returning early before
  // this is how the daily briefing once stopped for good on a shop that
  // happened to be on the wrong plan the day it ran; upgrading later started
  // nothing. The same mistake costs a year here rather than a day.
  await enqueueNextMonth(record.ianaTimezone, now);

  const month = await monthToReview(now);
  const run = await generateMonthlyReview({ month, locale: record.primaryLocale, now });

  return { month, ...run };
}

/** The first instant of next month, in the shop's own timezone. */
export async function enqueueNextMonth(
  timeZone: string | null,
  now = new Date(),
): Promise<void> {
  const runAt = monthStart(nextMonth(monthOf(now, timeZone)), timeZone);

  await enqueueJob({
    kind: "analytics.monthly_review",
    runAt,
    // Idempotent: a shop opening the admin twice in a morning must not end up
    // with two of these queued.
    replacePending: true,
  });
}

/**
 * Make sure a shop has one of these queued.
 *
 * Called from the analytics page rather than on install, so a shop that
 * installed before this shipped starts getting reviews the first time somebody
 * looks at their numbers.
 */
export async function ensureMonthlyReviewScheduled(now = new Date()): Promise<void> {
  const shop = shopScope.require("ensureMonthlyReviewScheduled");
  const record = await db.shop.findUnique({ where: { shop } });
  if (!record || record.uninstalledAt) return;

  await enqueueNextMonth(record.ianaTimezone, now);
}
