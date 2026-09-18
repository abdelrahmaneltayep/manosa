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
  "quick_order",
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

/**
 * Capabilities the plans name and the product does not have yet.
 *
 * Every one of these appeared **nowhere** in `app/`, `extensions/` or
 * `packages/` outside this file, and the comparison table rendered each of them
 * "Included" against the plans that list them — so Growth was sold on wholesale
 * shipping rules and Agentic on quote drafting, an API and priority support.
 * Invariant 4, on the page that takes the money.
 *
 * Marked rather than deleted, deliberately. Deleting them would hide a roadmap
 * a merchant may reasonably want to see; leaving them indistinguishable from
 * what ships today is selling them. So the table says **Planned** in its own
 * column and the plan cards leave them out of what a tier "adds", because a
 * card is a promise about now.
 *
 * Moving one to shipped is deleting a line from this set — and the test in
 * `tests/unit/plans.test.ts` fails if the capability still has no code behind
 * it, so the line cannot be deleted in hope.
 */
export const PLANNED_FEATURES = [
  "shipping_rules",
  "quote_assistant",
  "api_sync",
  "priority_support",
  // `pos` occurs once, as an order-source label, and `markets` once, as a rule
  // targeting dimension. Neither is gated, and neither is a thing a merchant
  // gets by paying more. Market scoping is unbuilt on purpose — see ADR 0031.
  "pos",
  "markets",
] as const satisfies readonly FeatureKey[];

export type PlannedFeature = (typeof PLANNED_FEATURES)[number];

export const isPlanned = (feature: FeatureKey): boolean =>
  (PLANNED_FEATURES as readonly FeatureKey[]).includes(feature);

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
  // Quick order sits here rather than higher: it is a wholesale convenience
  // like CSV import, not a premium capability like terms or an agent. The spec
  // does not place it — see DECISIONS.md, 2026-09-10.
  "quick_order",
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

/**
 * What this plan adds over the one below it, in ladder order.
 *
 * The card's one-line summary used to be four hand-written strings in the
 * catalogue, and they were written from `docs/spec/pages-features.md`, where
 * the tier names are the other way round from this file. So the Pro card read
 * "$29/month · Net terms, draft orders … and the Merchant Agent" while the
 * comparison table immediately below it marked all six of those *Not included*
 * for Pro — and a merchant who read the card and subscribed had bought
 * something they were not going to get.
 *
 * Deriving it is the fix, not correcting the strings: a hand-kept list beside
 * a real one is a registration step, and this repo has now found six of them.
 * Move a capability between tiers and both the card and the table move with it.
 */
export function featuresAddedBy(plan: PlanKey): readonly FeatureKey[] {
  const ladder = [...PLAN_KEYS].sort((a, b) => PLANS[a].rank - PLANS[b].rank);
  const index = ladder.indexOf(plan);
  const below = index > 0 ? PLANS[ladder[index - 1]!].features : [];
  return PLANS[plan].features.filter(
    // A card is a promise about now, so what is planned stays off it. The
    // comparison table shows those in their own column instead.
    (feature) => !below.includes(feature) && !isPlanned(feature),
  );
}

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
