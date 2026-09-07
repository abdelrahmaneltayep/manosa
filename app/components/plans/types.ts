import type { BillingStatus } from "@prisma/client";

import type { LimitKey, PlanInterval, PlanKey } from "~/lib/billing/plans";
import type { UsageMeter } from "~/lib/billing/usage.server";

/**
 * Everything the Plans page renders, as plain serialisable data.
 *
 * The page is a pure function of this, which is what makes every state — trial
 * ending, charge failed, subscription cancelled, over quota — renderable in a
 * test without a Shopify session. That matters more than usual here: the
 * embedded admin cannot be exercised outside the Shopify iframe.
 */
export interface PlansView {
  /** The plan the merchant pays for. */
  plan: PlanKey;
  /** What actually applies right now — differs when a subscription lapsed. */
  effectivePlan: PlanKey;
  status: BillingStatus;
  /** The interval they are billed on, if any. */
  interval: PlanInterval | null;
  /** The interval the cards are priced in — the toggle. */
  selectedInterval: PlanInterval;
  trialDaysRemaining: number | null;
  graceDaysRemaining: number | null;
  /** Localised date the current period ends, or null. */
  currentPeriodEndLabel: string | null;
  isTest: boolean;
  meters: UsageMeter[];
  /** Set when the merchant is confirming a change. */
  pendingChange: PendingChangeView | null;
  /** Set when Shopify rejected the last attempt. */
  error: boolean;
}

export interface PendingChangeView {
  to: PlanKey;
  toInterval: PlanInterval;
  direction: "upgrade" | "downgrade" | "interval-only" | "same";
  price: number;
  gaining: string[];
  losing: string[];
  limitImpacts: { key: LimitKey; used: number; becomes: number | null; overBy: number }[];
  hasOverage: boolean;
}
