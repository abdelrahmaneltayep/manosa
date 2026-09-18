import type { BillingStatus } from "@prisma/client";
import type { AppSubscription } from "@shopify/shopify-api";

import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { GRACE_PERIOD_DAYS } from "~/lib/billing/entitlements.server";
import {
  isPlanKey,
  parseBillingPlanId,
  PAID_BILLING_PLAN_IDS,
  type PlanInterval,
  type PlanKey,
} from "~/lib/billing/plans";
import { enqueueJob } from "~/lib/jobs/queue.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/** Re-sync from Shopify if the cache is older than this. */
const STALE_AFTER_MS = 60 * 60_000;

export interface SubscriptionSnapshot {
  plan: PlanKey;
  interval: PlanInterval | null;
  status: BillingStatus;
  subscriptionId: string | null;
  subscriptionName: string | null;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  graceEndsAt: Date | null;
  isTest: boolean;
}

const FREE_SNAPSHOT: SubscriptionSnapshot = {
  plan: "free",
  interval: null,
  status: "NONE",
  subscriptionId: null,
  subscriptionName: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
  graceEndsAt: null,
  isTest: false,
};

/**
 * Turn what Shopify reports into what the gate needs.
 *
 * Exported and pure so the awkward cases — a trial still running, a frozen
 * subscription inside its grace window, two subscriptions during a plan change
 * — are testable without a Shopify session.
 */
/**
 * An answer Shopify gave that we are not willing to act on.
 *
 * `billing.check` filters `activeSubscriptions` by plan name **and** by test
 * mode, so an empty list is not the same fact as "this shop cancelled". All of
 * these produce one:
 *
 * - a plan renamed or added without updating `PAID_BILLING_PLAN_IDS`;
 * - `SHOPIFY_BILLING_TEST_MODE` flipped, which hides every subscription of the
 *   other kind;
 * - a frozen subscription, if Shopify omits it — in which case a merchant
 *   inside their documented 7-day grace would lose it the first time they open
 *   the page they were told to open to fix their card.
 *
 * Writing Free on any of those cut off a paying merchant and erased the grace
 * period, on a page load, with an audit line announcing a change that had not
 * happened. So it is a distinct answer now, and the caller decides.
 */
export type SubscriptionReading =
  | { known: true; snapshot: SubscriptionSnapshot }
  | { known: false; reason: "no-subscriptions" | "unrecognised-plan"; detail: string };

export function readSubscriptions(
  subscriptions: AppSubscription[],
  now: Date = new Date(),
): SubscriptionReading {
  // During a plan change Shopify can briefly report more than one. The active
  // one wins; otherwise take the most recently created, which is the one the
  // merchant just acted on.
  const relevant = [...subscriptions].sort((a, b) => {
    if (a.status === b.status) {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }
    return a.status === "ACTIVE" ? -1 : b.status === "ACTIVE" ? 1 : 0;
  });

  const subscription = relevant[0];
  if (!subscription) {
    return {
      known: false,
      reason: "no-subscriptions",
      detail:
        `Shopify reported no subscription matching ${PAID_BILLING_PLAN_IDS.join(", ")} ` +
        `with isTest=${process.env.SHOPIFY_BILLING_TEST_MODE === "true"}.`,
    };
  }

  const parsed = parseBillingPlanId(subscription.name);
  if (!parsed) {
    // A subscription we do not recognise — a plan renamed without a migration.
    // Falling back to Free would silently cut off a paying merchant, so keep
    // them working and make the mismatch loud. The comment said that before;
    // the code returned Free anyway.
    return {
      known: false,
      reason: "unrecognised-plan",
      detail:
        `Shopify reported subscription "${subscription.name}", which is not one of ` +
        `${PAID_BILLING_PLAN_IDS.join(", ")}. Check the billing config before renaming a plan.`,
    };
  }

  const createdAt = new Date(subscription.createdAt);
  const trialEndsAt =
    subscription.trialDays > 0
      ? new Date(createdAt.getTime() + subscription.trialDays * 86_400_000)
      : null;
  const currentPeriodEnd = subscription.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd)
    : null;

  const status = mapStatus(subscription.status, trialEndsAt, now);

  const snapshot: SubscriptionSnapshot = {
    plan: parsed.plan,
    interval: parsed.interval,
    status,
    subscriptionId: subscription.id,
    subscriptionName: subscription.name,
    trialEndsAt,
    currentPeriodEnd,
    // Shopify freezes a subscription when a charge fails. We keep the plan
    // working for a week rather than cutting access the moment a card expires.
    graceEndsAt:
      status === "PAST_DUE"
        ? new Date(now.getTime() + GRACE_PERIOD_DAYS * 86_400_000)
        : null,
    isTest: subscription.test,
  };

  return { known: true, snapshot };
}

function mapStatus(
  shopifyStatus: string,
  trialEndsAt: Date | null,
  now: Date,
): BillingStatus {
  switch (shopifyStatus) {
    case "ACTIVE":
      return trialEndsAt && trialEndsAt > now ? "TRIAL" : "ACTIVE";
    case "FROZEN":
      return "PAST_DUE";
    case "CANCELLED":
    case "EXPIRED":
    case "DECLINED":
      return "CANCELLED";
    default:
      // PENDING — the merchant has not approved the charge yet, so nothing is
      // unlocked.
      return "NONE";
  }
}

/** What the caller needs of the billing context. Keeps this testable. */
export interface BillingChecker {
  check: (options: {
    plans?: string[];
    isTest?: boolean;
  }) => Promise<{ appSubscriptions: AppSubscription[] }>;
}

/**
 * Pull the current subscription from Shopify and cache it on the Shop row.
 *
 * Shopify is the source of truth. The cache exists so the gate can answer on
 * every request without an Admin API round trip — that call would cost latency
 * on every page against the LCP budget, and burn rate limit on navigation.
 */
export async function syncSubscription(
  billing: BillingChecker,
  now: Date = new Date(),
): Promise<SubscriptionSnapshot> {
  const shop = shopScope.require("syncSubscription");

  const response = await billing.check({
    plans: PAID_BILLING_PLAN_IDS,
    isTest: process.env.SHOPIFY_BILLING_TEST_MODE === "true",
  });

  const reading = readSubscriptions(response.appSubscriptions ?? [], now);
  const previous = await db.shop.findUnique({ where: { shop } });

  if (!reading.known && !mayActOn(reading, previous, now)) {
    // Stamped, and nothing else. Without this the staleness check would call
    // Shopify again on every single page load for a shop whose config has
    // drifted — the one situation where that call cannot help.
    if (previous)
      await db.shop.update({ where: { shop }, data: { billingSyncedAt: now } });
    return previous ? snapshotOf(previous) : FREE_SNAPSHOT;
  }

  const snapshot = reading.known ? reading.snapshot : FREE_SNAPSHOT;

  await db.shop.update({
    where: { shop },
    data: {
      planKey: snapshot.plan,
      billingStatus: snapshot.status,
      billingInterval: snapshot.interval,
      subscriptionId: snapshot.subscriptionId,
      subscriptionName: snapshot.subscriptionName,
      trialEndsAt: snapshot.trialEndsAt,
      currentPeriodEnd: snapshot.currentPeriodEnd,
      // Don't restart the grace clock on every sync — the merchant would never
      // run out of it.
      graceEndsAt:
        snapshot.status === "PAST_DUE"
          ? (previous?.graceEndsAt ?? snapshot.graceEndsAt)
          : null,
      isTestSubscription: snapshot.isTest,
      billingSyncedAt: now,
    },
  });

  if (
    previous &&
    (previous.planKey !== snapshot.plan || previous.billingStatus !== snapshot.status)
  ) {
    // What the shop may do has changed, and three capabilities reach a buyer
    // through metafields Shopify evaluates without asking us. Withdrawing or
    // restoring them is work, not a flag. Both directions: a downgrade pauses,
    // resubscribing puts it back.
    await enqueueJob({
      kind: "billing.reconcile",
      runAt: now,
      replacePending: true,
    });

    await recordAudit({
      actor: SYSTEM_ACTOR,
      action: "billing.subscription_changed",
      summary: `Plan is now ${snapshot.plan} (${snapshot.status.toLowerCase()}), was ${previous.planKey} (${previous.billingStatus.toLowerCase()}).`,
      subject: { type: "Shop", id: shop },
      metadata: {
        from: { plan: previous.planKey, status: previous.billingStatus },
        to: { plan: snapshot.plan, status: snapshot.status },
      },
    });
  }

  return snapshot;
}

/**
 * Should an answer we do not understand be allowed to drop this shop to Free?
 *
 * Only when there is nothing to lose, or when the merchant has already had
 * what they paid for. Everything else leaves the cached row exactly as it is
 * — including `graceEndsAt`, which a page load used to erase — logs what is
 * wrong, and lets the webhook or the next sync settle it. Returning `false`
 * means "do not write".
 *
 * The bounded case matters: refusing for ever would mean a cancellation whose
 * webhook was lost keeps a shop on a paid plan indefinitely. A `currentPeriodEnd`
 * in the past is the merchant having received the period they were charged
 * for, so an empty answer after it is corroborated rather than guessed.
 */
function mayActOn(
  reading: Extract<SubscriptionReading, { known: false }>,
  previous: { planKey: string; currentPeriodEnd: Date | null } | null,
  now: Date,
): boolean {
  const hadNothing = !previous || previous.planKey === "free";
  const periodOver =
    previous?.currentPeriodEnd !== null &&
    previous?.currentPeriodEnd !== undefined &&
    previous.currentPeriodEnd <= now;

  // An unrecognised *name* is config drift, never a cancellation: there is a
  // live subscription, we simply cannot read it. It never downgrades anybody.
  const trustable = reading.reason === "no-subscriptions" && (hadNothing || periodOver);

  if (trustable) return true;

  console.error(
    `[billing] refusing to change the cached plan. ${reading.detail} ` +
      `The shop stays on "${previous?.planKey ?? "free"}" until a webhook or a ` +
      `later sync says otherwise.`,
  );
  return false;
}

/** The cached row, read back as a snapshot. */
function snapshotOf(record: {
  planKey: string;
  billingStatus: BillingStatus;
  billingInterval: string | null;
  subscriptionId: string | null;
  subscriptionName: string | null;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  graceEndsAt: Date | null;
  isTestSubscription: boolean;
}): SubscriptionSnapshot {
  return {
    plan: isPlanKey(record.planKey) ? record.planKey : "free",
    interval:
      record.billingInterval === "monthly" || record.billingInterval === "annual"
        ? record.billingInterval
        : null,
    status: record.billingStatus,
    subscriptionId: record.subscriptionId,
    subscriptionName: record.subscriptionName,
    trialEndsAt: record.trialEndsAt,
    currentPeriodEnd: record.currentPeriodEnd,
    graceEndsAt: record.graceEndsAt,
    isTest: record.isTestSubscription,
  };
}

/** Re-sync only if the cache has gone stale. Used on ordinary page loads. */
export async function syncSubscriptionIfStale(
  billing: BillingChecker,
  now: Date = new Date(),
): Promise<void> {
  const shop = shopScope.require("syncSubscriptionIfStale");
  const record = await db.shop.findUnique({
    where: { shop },
    select: { billingSyncedAt: true },
  });

  const syncedAt = record?.billingSyncedAt;
  if (syncedAt && now.getTime() - syncedAt.getTime() < STALE_AFTER_MS) return;

  try {
    await syncSubscription(billing, now);
  } catch (error) {
    // A billing API blip must not take the admin down. The cached plan stays
    // in effect until the next successful sync or the webhook.
    console.error("[billing] subscription sync failed; using cached plan", error);
  }
}
