import type { BillingStatus, Shop } from "@prisma/client";

import { db } from "~/db.server";
import {
  PLANS,
  type FeatureKey,
  type LimitKey,
  type PlanInterval,
  type PlanKey,
  type PlanLimits,
  isPlanKey,
} from "~/lib/billing/plans";
import { shopScope } from "~/lib/tenant/shop-context.server";

/** Days a paid plan keeps working after a failed charge. */
export const GRACE_PERIOD_DAYS = 7;

export interface Entitlements {
  /** The plan the merchant has bought. */
  plan: PlanKey;
  /**
   * The plan that actually applies right now. Differs from `plan` when a
   * subscription has lapsed: paid features pause, and the data behind them is
   * kept, so the merchant gets everything back by resubscribing.
   */
  effectivePlan: PlanKey;
  status: BillingStatus;
  interval: PlanInterval | null;
  features: readonly FeatureKey[];
  limits: PlanLimits;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  /** Whole days left, or null when not in a trial. */
  trialDaysRemaining: number | null;
  /** Whole days of grace left after a failed charge, or null. */
  graceDaysRemaining: number | null;
  isTest: boolean;
}

function daysUntil(date: Date | null, now: Date): number | null {
  if (!date) return null;
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 86_400_000));
}

/**
 * Resolve what a shop can do right now.
 *
 * Pure, so the states the Plans page has to render — trial ending, charge
 * failed, subscription cancelled — are testable without a database or a
 * Shopify session.
 */
export function entitlementsFor(
  shop: Pick<
    Shop,
    | "planKey"
    | "billingStatus"
    | "billingInterval"
    | "trialEndsAt"
    | "graceEndsAt"
    | "currentPeriodEnd"
    | "isTestSubscription"
  >,
  now: Date = new Date(),
): Entitlements {
  const plan: PlanKey = isPlanKey(shop.planKey) ? shop.planKey : "free";
  const status = shop.billingStatus;

  // A cancelled or expired subscription pauses paid capability but never
  // deletes anything. A failed charge keeps the plan through the grace window.
  const lapsed =
    status === "CANCELLED" ||
    (status === "PAST_DUE" && shop.graceEndsAt !== null && shop.graceEndsAt <= now) ||
    status === "NONE";

  const effectivePlan: PlanKey = lapsed ? "free" : plan;
  const definition = PLANS[effectivePlan];

  return {
    plan,
    effectivePlan,
    status,
    interval:
      shop.billingInterval === "monthly" || shop.billingInterval === "annual"
        ? shop.billingInterval
        : null,
    features: definition.features,
    limits: definition.limits,
    trialEndsAt: shop.trialEndsAt,
    graceEndsAt: shop.graceEndsAt,
    currentPeriodEnd: shop.currentPeriodEnd,
    trialDaysRemaining: status === "TRIAL" ? daysUntil(shop.trialEndsAt, now) : null,
    graceDaysRemaining: status === "PAST_DUE" ? daysUntil(shop.graceEndsAt, now) : null,
    isTest: shop.isTestSubscription,
  };
}

/** Entitlements for the active tenant. */
export async function loadEntitlements(now: Date = new Date()): Promise<Entitlements> {
  const shop = shopScope.require("loadEntitlements");
  const record = await db.shop.findUnique({ where: { shop } });

  if (!record) {
    // No install record yet — the layout creates one on the first authenticated
    // page view. Free is the safe answer: it grants nothing.
    return entitlementsFor(
      {
        planKey: "free",
        billingStatus: "NONE",
        billingInterval: null,
        trialEndsAt: null,
        graceEndsAt: null,
        currentPeriodEnd: null,
        isTestSubscription: false,
      },
      now,
    );
  }

  return entitlementsFor(record, now);
}

export function hasFeature(entitlements: Entitlements, feature: FeatureKey): boolean {
  return entitlements.features.includes(feature);
}

export function limitFor(entitlements: Entitlements, limit: LimitKey): number | null {
  return entitlements.limits[limit];
}
