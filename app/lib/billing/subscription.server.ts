import type { BillingStatus } from "@prisma/client";
import type { AppSubscription } from "@shopify/shopify-api";

import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { GRACE_PERIOD_DAYS } from "~/lib/billing/entitlements.server";
import {
  parseBillingPlanId,
  PAID_BILLING_PLAN_IDS,
  type PlanInterval,
  type PlanKey,
} from "~/lib/billing/plans";
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
export function snapshotFrom(
  subscriptions: AppSubscription[],
  now: Date = new Date(),
): SubscriptionSnapshot {
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
  if (!subscription) return FREE_SNAPSHOT;

  const parsed = parseBillingPlanId(subscription.name);
  if (!parsed) {
    // A subscription we do not recognise — a plan renamed without a migration.
    // Falling back to Free would silently cut off a paying merchant, so keep
    // them working and make the mismatch loud.
    console.error(
      `[billing] unrecognised subscription name "${subscription.name}". ` +
        `Known plans: ${PAID_BILLING_PLAN_IDS.join(", ")}. ` +
        `Treating as Free — check the billing config before renaming a plan.`,
    );
    return FREE_SNAPSHOT;
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

  return {
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

  const snapshot = snapshotFrom(response.appSubscriptions ?? [], now);
  const previous = await db.shop.findUnique({ where: { shop } });

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
