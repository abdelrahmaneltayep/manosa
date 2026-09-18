import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { GRACE_PERIOD_DAYS } from "~/lib/billing/entitlements.server";
import { PLANS, isPlanKey, priceFor } from "~/lib/billing/plans";
import { deliverEmail } from "~/lib/email/deliver.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Tell the merchant their trial is about to start charging.
 *
 * Checklist §9 asks for this at three days and it did not exist. The only
 * warning was a banner on the Plans page — the one page a merchant whose trial
 * is ending is least likely to be sitting on, and the one they have no reason
 * to open until something has already gone wrong.
 *
 * It says the **real** number: the plan and the interval they are actually on,
 * so an annual trialist reads "$990 for the year, charged once" rather than a
 * monthly figure they will not see. That mistake was live on the banner too.
 *
 * Sent once per trial. `trialReminderSentAt` is stamped here and cleared when a
 * new trial begins, so a merchant who trials twice is warned twice and never
 * twice for the same one.
 *
 * Re-queues itself daily, like the briefing. Nothing is sent for a shop with no
 * address or no mail transport — `deliverEmail` records that as failed with the
 * reason rather than leaving it QUEUED, which is Invariant 4 in the one place a
 * merchant cannot check for themselves.
 */

/** How many days before a trial ends the merchant hears about it. §9. */
export const TRIAL_REMINDER_DAYS = 3;

const DAY_MS = 86_400_000;

/** Next run: this time tomorrow. Daily is enough for a fortnight-long trial. */
export const nextRun = (now: Date): Date => new Date(now.getTime() + DAY_MS);

export async function sendTrialReminder(now: Date = new Date()) {
  const shop = shopScope.require("sendTrialReminder");
  const record = await db.shop.findUnique({ where: { shop } });

  // Re-queued before anything can go wrong, so one bad day does not end the
  // schedule. The same shape as the daily briefing.
  await enqueueJob({
    kind: "billing.trial_reminder",
    runAt: nextRun(now),
    replacePending: true,
  });

  if (!record) return { skipped: "no install record" as const };
  if (record.uninstalledAt) return { skipped: "uninstalled" as const };
  if (record.billingStatus !== "TRIAL" || !record.trialEndsAt) {
    return { skipped: "not in a trial" as const };
  }
  if (record.trialReminderSentAt) return { skipped: "already sent" as const };

  const daysLeft = Math.ceil((record.trialEndsAt.getTime() - now.getTime()) / DAY_MS);
  if (daysLeft > TRIAL_REMINDER_DAYS) return { skipped: "too early" as const, daysLeft };

  if (!record.email) {
    // Nothing to send to. Recorded as skipped rather than retried for ever
    // against an address this app does not have.
    return { skipped: "no address" as const };
  }

  const plan = isPlanKey(record.planKey) ? PLANS[record.planKey] : PLANS.free;
  const annual = record.billingInterval === "annual";
  const price = priceFor(plan, annual ? "annual" : "monthly");

  await deliverEmail({
    kind: "trial_ending",
    to: record.email,
    template: {
      subject: `Your Mannon trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
      body: [
        `Your ${plan.key} trial ends on ${record.trialEndsAt.toISOString().slice(0, 10)}.`,
        "",
        annual
          ? `After that you will be charged $${price} for the year, once.`
          : `After that you will be charged $${price} a month.`,
        "",
        "If you would rather not continue, change your plan before then and nothing",
        "is deleted — your rules, forms and buyers stay exactly as they are, and",
        "you can pick a plan again whenever you like.",
        "",
        `${process.env.SHOPIFY_APP_URL ?? ""}/app/plans`,
      ].join("\n"),
    },
    // `renderTemplate` substitutes the merge tags a registration form knows;
    // this message belongs to the store, so the two values it needs are put in
    // directly rather than added to a vocabulary meant for buyer email.
    values: {},
  });

  await db.shop.update({ where: { shop }, data: { trialReminderSentAt: now } });

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "billing.trial_reminder_sent",
    summary: `Told ${record.email} that the ${plan.key} trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`,
    subject: { type: "Shop", id: shop },
    metadata: { daysLeft, interval: annual ? "annual" : "monthly", price },
  });

  return { sent: true as const, daysLeft, gracePeriodDays: GRACE_PERIOD_DAYS };
}
