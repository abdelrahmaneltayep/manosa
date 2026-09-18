import type { BillingStatus } from "@prisma/client";

import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { GRACE_PERIOD_DAYS } from "~/lib/billing/entitlements.server";
import { parseBillingPlanId } from "~/lib/billing/plans";
import { enqueueJob } from "~/lib/jobs/queue.server";
import type { WebhookContext } from "~/lib/webhooks/registry";

/**
 * Shopify tells us the moment a subscription changes — approved, cancelled, or
 * frozen because a charge failed.
 *
 * This keeps the cached plan correct without waiting for the merchant's next
 * page load, which matters most in the case they are least likely to be
 * watching: a card expiring overnight.
 *
 * The payload is Shopify's, so it is narrowed here rather than trusted.
 */
interface SubscriptionPayload {
  app_subscription?: {
    admin_graphql_api_id?: string;
    name?: string;
    status?: string;
    created_at?: string;
    test?: boolean;
    /** Shopify sends these; the handler used to read neither. */
    trial_days?: number;
    current_period_end?: string;
  };
}

export async function handleAppSubscriptionsUpdate({ shop, payload }: WebhookContext) {
  const subscription = (payload as SubscriptionPayload).app_subscription;

  if (!subscription?.name || !subscription.status) {
    console.warn(`[billing] app_subscriptions/update for ${shop} had no subscription`);
    return;
  }

  const parsed = parseBillingPlanId(subscription.name);
  const status = mapStatus(subscription.status);

  // An unrecognised plan name would otherwise silently drop a paying merchant
  // to Free. Leave the cached plan alone and make it loud instead.
  if (!parsed && status !== "CANCELLED") {
    console.error(
      `[billing] unrecognised subscription "${subscription.name}" for ${shop}; ` +
        `leaving the cached plan untouched.`,
    );
    return;
  }

  const existing = await db.shop.findUnique({ where: { shop } });
  if (!existing) {
    console.warn(`[billing] app_subscriptions/update for unknown shop ${shop}`);
    return;
  }

  // An upgrade is exactly when Shopify emits two deliveries — the new
  // subscription becoming ACTIVE and the replaced one becoming CANCELLED — and
  // their order is not guaranteed. This handler used to write whatever the
  // payload said, so a cancellation landing second dropped a merchant who had
  // just been charged for Growth to Free, with an audit line saying their pro
  // subscription had ended. The dispatch layer's idempotency does not help:
  // both deliveries are genuinely distinct events.
  if (isStale(subscription, existing)) {
    console.info(
      `[billing] ignoring app_subscriptions/update for ${shop}: ` +
        `"${subscription.name}" (${subscription.status}) is not this shop's current ` +
        `subscription.`,
    );
    return;
  }

  const now = new Date();
  const plan = status === "CANCELLED" ? "free" : (parsed?.plan ?? "free");

  // A delivery arriving during a trial used to erase the trial from the cache:
  // it mapped `ACTIVE → ACTIVE` and wrote neither `trialEndsAt` nor
  // `currentPeriodEnd`, so the days-left pill and the three-day banner vanished
  // until a Plans page sync happened to restore them. The payload carries both.
  const dates = readDates(subscription, existing, status, now);

  await db.shop.update({
    where: { shop },
    data: {
      planKey: plan,
      billingStatus: dates.status,
      trialEndsAt: dates.trialEndsAt,
      currentPeriodEnd: dates.currentPeriodEnd,
      // Stamped once and never cleared — a trial is a thing a shop has had.
      ...(dates.trialEndsAt && !existing.trialUsedAt ? { trialUsedAt: now } : {}),
      billingInterval: status === "CANCELLED" ? null : (parsed?.interval ?? null),
      subscriptionId: subscription.admin_graphql_api_id ?? existing.subscriptionId,
      subscriptionName: subscription.name,
      isTestSubscription: subscription.test ?? existing.isTestSubscription,
      // Start the grace clock on the first frozen notification only, so a
      // repeated webhook cannot extend it indefinitely.
      graceEndsAt:
        status === "PAST_DUE"
          ? (existing.graceEndsAt ??
            new Date(now.getTime() + GRACE_PERIOD_DAYS * 86_400_000))
          : null,
      billingSyncedAt: now,
    },
  });

  // Same reason as the sync path: three capabilities reach a buyer through
  // metafields Shopify evaluates without asking us, so withdrawing or
  // restoring them is work rather than a flag. Only when something actually
  // moved — a repeated delivery must not queue a sweep per delivery.
  if (existing.planKey !== plan || existing.billingStatus !== dates.status) {
    await enqueueJob({
      kind: "billing.reconcile",
      runAt: now,
      replacePending: true,
    });
  }

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: `billing.${dates.status.toLowerCase()}`,
    summary: summarise(dates.status, plan, existing.planKey),
    subject: { type: "Shop", id: shop },
    metadata: {
      subscriptionName: subscription.name,
      shopifyStatus: subscription.status,
      from: existing.planKey,
      to: plan,
    },
  });
}

/**
 * Is this delivery about a subscription the shop has already moved on from?
 *
 * Two independent signals, because Shopify sends both and either alone has a
 * hole:
 *
 * - **A different subscription id.** A terminal status for a subscription that
 *   is not the cached one is the replaced half of a plan change. It says
 *   nothing about what the shop is on now. (A *non*-terminal status for a
 *   different id is a new subscription taking over, which is not stale.)
 * - **An older `created_at`.** When ids are missing — the field is optional in
 *   the payload — a delivery created before the one we have cached cannot be
 *   describing a later state than the one we already hold.
 */
function isStale(
  subscription: { admin_graphql_api_id?: string; created_at?: string; status?: string },
  existing: { subscriptionId: string | null; billingSyncedAt: Date | null },
): boolean {
  const id = subscription.admin_graphql_api_id;
  const terminal = ["CANCELLED", "EXPIRED", "DECLINED"].includes(
    (subscription.status ?? "").toUpperCase(),
  );

  if (id && existing.subscriptionId && id !== existing.subscriptionId) {
    // Only the terminal half. A different id going ACTIVE is the merchant's
    // new plan and must be applied.
    return terminal;
  }

  const createdAt = subscription.created_at ? new Date(subscription.created_at) : null;
  if (createdAt && existing.billingSyncedAt && createdAt < existing.billingSyncedAt) {
    // Nothing cached is older than this delivery's subject, so it cannot be
    // news. Only used to break a tie the id could not.
    return !id && terminal;
  }

  return false;
}

/**
 * The trial and period dates this delivery carries, and the status they change.
 *
 * `ACTIVE` with a trial still running is `TRIAL`, which this handler could not
 * express at all — it mapped `ACTIVE → ACTIVE` unconditionally, so any delivery
 * during a trial told the cache the trial was over.
 *
 * On a cancellation the period end is cleared rather than left behind: it is
 * what `plans.change.takesEffectAtPeriodEnd` prints as the date the merchant
 * "keeps" their plan until, and a stale one is a promise about a subscription
 * that has ended.
 */
function readDates(
  subscription: { created_at?: string; trial_days?: number; current_period_end?: string },
  existing: { trialEndsAt: Date | null; currentPeriodEnd: Date | null },
  status: BillingStatus,
  now: Date,
): { status: BillingStatus; trialEndsAt: Date | null; currentPeriodEnd: Date | null } {
  if (status === "CANCELLED") {
    return { status, trialEndsAt: null, currentPeriodEnd: null };
  }

  const createdAt = subscription.created_at ? new Date(subscription.created_at) : null;
  const trialDays = subscription.trial_days ?? 0;

  const trialEndsAt =
    createdAt && !Number.isNaN(createdAt.getTime()) && trialDays > 0
      ? new Date(createdAt.getTime() + trialDays * 86_400_000)
      : // A payload without the fields must not erase what a sync already knew.
        existing.trialEndsAt;

  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end)
    : null;

  return {
    // The one status this handler could not reach.
    status: status === "ACTIVE" && trialEndsAt && trialEndsAt > now ? "TRIAL" : status,
    trialEndsAt,
    currentPeriodEnd:
      periodEnd && !Number.isNaN(periodEnd.getTime())
        ? periodEnd
        : existing.currentPeriodEnd,
  };
}

function mapStatus(shopifyStatus: string): BillingStatus {
  switch (shopifyStatus.toUpperCase()) {
    case "ACTIVE":
      return "ACTIVE";
    case "FROZEN":
      return "PAST_DUE";
    case "CANCELLED":
    case "EXPIRED":
    case "DECLINED":
      return "CANCELLED";
    default:
      return "NONE";
  }
}

function summarise(status: BillingStatus, plan: string, previousPlan: string): string {
  switch (status) {
    case "PAST_DUE":
      return `The charge for the ${previousPlan} plan failed. Paid features keep working for ${GRACE_PERIOD_DAYS} days while the payment method is updated.`;
    case "CANCELLED":
      return `The ${previousPlan} subscription ended. Paid features are paused and nothing has been deleted.`;
    case "ACTIVE":
      return `The ${plan} plan is active.`;
    default:
      return `Subscription status is now ${status.toLowerCase()}.`;
  }
}
