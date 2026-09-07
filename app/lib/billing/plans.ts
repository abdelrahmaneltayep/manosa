/**
 * The plan ladder. One source of truth for pricing, entitlements and quotas —
 * the Plans page, the gate, and the Shopify billing config all read from here,
 * so they cannot drift apart.
 */

/**
 * Ladder order: Free → Pro → Growth → Agentic.
 *
 * Pro is the entry paid tier and Growth the mid tier — deliberately, not a
 * typo. Entitlements are attached to the price point, so read `rank` rather
 * than assuming an alphabetical or familiar ordering.
 */
export const PLAN_KEYS = ["free", "pro", "growth", "agentic"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export const BILLING_INTERVALS = ["monthly", "annual"] as const;
export type PlanInterval = (typeof BILLING_INTERVALS)[number];

/**
 * Everything a plan can unlock. Gating is by capability, not by plan name, so
 * moving a capability between tiers is a one-line change here rather than a
 * search for every `plan === "pro"` in the codebase.
 */
export const FEATURE_KEYS = [
  "csv_import",
  "auto_tagging",
  "order_limits",
  "net_terms",
  "shipping_rules",
  "draft_orders",
  "pos",
  "markets",
  "merchant_agent",
  "buyer_agent",
  "po_to_order",
  "quote_assistant",
  "api_sync",
  "priority_support",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** Countable things a plan caps. `null` means unlimited. */
export interface PlanLimits {
  pricingRules: number | null;
  forms: number | null;
}

export type LimitKey = keyof PlanLimits;
export const LIMIT_KEYS: LimitKey[] = ["pricingRules", "forms"];

export interface PlanDefinition {
  key: PlanKey;
  /** Position in the ladder. Higher is more capable; drives upgrade vs downgrade. */
  rank: number;
  /** Monthly price in USD. */
  monthlyPrice: number;
  /** Charged once a year. Two months free, per the pricing convention. */
  annualPrice: number;
  trialDays: number;
  features: readonly FeatureKey[];
  limits: PlanLimits;
}

// Each tier is a superset of the one below it, in ladder order.
const PRO_FEATURES = [
  "csv_import",
  "auto_tagging",
  "order_limits",
] as const satisfies readonly FeatureKey[];

const GROWTH_FEATURES = [
  ...PRO_FEATURES,
  "net_terms",
  "shipping_rules",
  "draft_orders",
  "pos",
  "markets",
  "merchant_agent",
] as const satisfies readonly FeatureKey[];

const AGENTIC_FEATURES = [
  ...GROWTH_FEATURES,
  "buyer_agent",
  "po_to_order",
  "quote_assistant",
  "api_sync",
  "priority_support",
] as const satisfies readonly FeatureKey[];

export const PLANS: Record<PlanKey, PlanDefinition> = {
  free: {
    key: "free",
    rank: 0,
    monthlyPrice: 0,
    annualPrice: 0,
    trialDays: 0,
    features: [],
    // "1 pricing rule, 1 form, basic limits" — enough to see Mannon work on a
    // real product before paying for it.
    limits: { pricingRules: 1, forms: 1 },
  },
  pro: {
    key: "pro",
    rank: 1,
    monthlyPrice: 29,
    annualPrice: 290,
    trialDays: 14,
    features: PRO_FEATURES,
    limits: { pricingRules: null, forms: null },
  },
  growth: {
    key: "growth",
    rank: 2,
    monthlyPrice: 59,
    annualPrice: 590,
    trialDays: 14,
    features: GROWTH_FEATURES,
    limits: { pricingRules: null, forms: null },
  },
  agentic: {
    key: "agentic",
    rank: 3,
    monthlyPrice: 99,
    annualPrice: 990,
    trialDays: 14,
    features: AGENTIC_FEATURES,
    limits: { pricingRules: null, forms: null },
  },
};

export const PLAN_LIST: readonly PlanDefinition[] = PLAN_KEYS.map((key) => PLANS[key]);

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && (PLAN_KEYS as readonly string[]).includes(value);
}

export function isPlanInterval(value: unknown): value is PlanInterval {
  return (
    typeof value === "string" && (BILLING_INTERVALS as readonly string[]).includes(value)
  );
}

export function priceFor(plan: PlanDefinition, interval: PlanInterval): number {
  return interval === "annual" ? plan.annualPrice : plan.monthlyPrice;
}

/** What an annual subscription saves against paying monthly, in whole dollars. */
export function annualSaving(plan: PlanDefinition): number {
  return plan.monthlyPrice * 12 - plan.annualPrice;
}

export function planHasFeature(plan: PlanKey, feature: FeatureKey): boolean {
  return PLANS[plan].features.includes(feature);
}

/** The cheapest plan that includes a capability — what an upsell should offer. */
export function lowestPlanWithFeature(feature: FeatureKey): PlanKey {
  const found = PLAN_LIST.find((plan) => plan.features.includes(feature));
  if (!found) {
    throw new Error(
      `No plan grants "${feature}" — the ladder and FEATURE_KEYS disagree.`,
    );
  }
  return found.key;
}

/**
 * The Shopify billing config key for a plan and interval. This string becomes
 * the subscription's `name` in Shopify and is how a live subscription maps back
 * to a plan, so it must stay stable once any merchant is on it.
 */
export function billingPlanId(plan: PlanKey, interval: PlanInterval): string {
  return `${plan}-${interval}`;
}

export function parseBillingPlanId(
  id: string,
): { plan: PlanKey; interval: PlanInterval } | undefined {
  const [plan, interval] = id.split("-");
  if (!isPlanKey(plan) || !isPlanInterval(interval)) return undefined;
  return { plan, interval };
}

/** Every paid billing config key, for the Shopify billing configuration. */
export const PAID_BILLING_PLAN_IDS = PLAN_LIST.filter(
  (plan) => plan.monthlyPrice > 0,
).flatMap((plan) =>
  BILLING_INTERVALS.map((interval) => billingPlanId(plan.key, interval)),
);
