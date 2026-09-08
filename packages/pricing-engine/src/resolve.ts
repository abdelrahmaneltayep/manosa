import {
  formatMoney,
  money,
  roundMinorUnits,
  type Money,
  type RoundingMode,
} from "./money";
import { eligibilityReason } from "./eligibility";
import { nextVolumeTier, selectCartValueTier, selectVolumeTier } from "./tiers";
import type {
  CartValueTier,
  CurrencyAmount,
  NextTier,
  PriceResolution,
  PricingContext,
  PricingRule,
  ResolveInput,
  SkipReason,
  TraceEntry,
  VolumeTier,
} from "./types";

/**
 * Cascade precedence: a custom price beats a volume tier, which beats a
 * discount. This is the ordering the whole product is specified around — a
 * negotiated contract price is a promise, and a percentage rule must not
 * quietly undercut or override it.
 *
 * Amount-off and percentage share a rank: both are "a discount", and which one
 * wins between them is the merchant's business, expressed as priority.
 */
const CLASS_RANK: Record<PricingRule["kind"], number> = {
  fixed_price: 0,
  volume_tier: 1,
  cart_value_tier: 2,
  amount_off: 3,
  percentage: 3,
};

/** What a rule does to a price, once we know it can. */
type Effect =
  | { type: "set"; minorUnits: number }
  | { type: "subtract"; minorUnits: number }
  | { type: "multiply"; factor: number };

type EffectResult = { effect: Effect } | { skip: SkipReason; detail?: string };

/**
 * Total order over rules. Every component is deterministic, and `id` breaks the
 * final tie, so the same rules in any input order always resolve identically.
 * Golden vectors and a merchant's bug report both depend on that.
 */
function compareRules(a: PricingRule, b: PricingRule): number {
  const byClass = CLASS_RANK[a.kind] - CLASS_RANK[b.kind];
  if (byClass !== 0) return byClass;

  const byPriority = a.priority - b.priority;
  if (byPriority !== 0) return byPriority;

  const byAge = a.createdAt.getTime() - b.createdAt.getTime();
  if (byAge !== 0) return byAge;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The rule's amount in the context's currency.
 *
 * Returns null when the merchant has not priced this rule in that currency.
 * The engine will not convert: applying a rate we invented would put a number
 * on a storefront that nothing else in the system agrees with.
 */
function amountInCurrency(value: CurrencyAmount, currencyCode: string): Money | null {
  const override = value.overrides[currencyCode];
  if (override) return override;
  if (value.base.currencyCode === currencyCode) return value.base;
  return null;
}

function percentageEffect(percentage: number): EffectResult {
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    return { skip: "invalid_rule", detail: `percentage ${percentage} is outside 0–100` };
  }
  return { effect: { type: "multiply", factor: (100 - percentage) / 100 } };
}

function tierEffect(
  tier: VolumeTier | CartValueTier,
  currencyCode: string,
): EffectResult {
  if (tier.kind === "percentage") return percentageEffect(tier.percentage);

  if (tier.amount.currencyCode !== currencyCode) {
    return { skip: "no_price_in_currency", detail: currencyCode };
  }

  return tier.kind === "fixed_price"
    ? { effect: { type: "set", minorUnits: tier.amount.amount } }
    : { effect: { type: "subtract", minorUnits: tier.amount.amount } };
}

function effectFor(rule: PricingRule, context: PricingContext): EffectResult {
  const currency = context.market.currencyCode;

  switch (rule.kind) {
    case "percentage":
      return percentageEffect(rule.value.percentage);

    case "fixed_price":
    case "amount_off": {
      const amount = amountInCurrency(rule.value, currency);
      if (!amount) return { skip: "no_price_in_currency", detail: currency };
      return rule.kind === "fixed_price"
        ? { effect: { type: "set", minorUnits: amount.amount } }
        : { effect: { type: "subtract", minorUnits: amount.amount } };
    }

    case "volume_tier": {
      const tier = selectVolumeTier(rule.value.tiers, context.quantity);
      if (!tier) return { skip: "no_matching_tier" };
      return tierEffect(tier, currency);
    }

    case "cart_value_tier": {
      // On a product page there is no cart. Guessing one would show a price
      // checkout will not honour, so the rule stands aside and says why.
      if (!context.cartSubtotal) return { skip: "cart_unknown" };
      const tier = selectCartValueTier(rule.value.tiers, context.cartSubtotal);
      if (!tier) return { skip: "no_matching_tier" };
      return tierEffect(tier, currency);
    }

    default:
      return { skip: "invalid_rule", detail: "unknown rule kind" };
  }
}

interface ResolveState {
  /** Running price in fractional minor units. Rounded once, at the end. */
  fractional: number;
  clampedAtZero: boolean;
}

function applyEffect(state: ResolveState, effect: Effect): void {
  switch (effect.type) {
    case "set":
      state.fractional = effect.minorUnits;
      break;
    case "subtract":
      state.fractional -= effect.minorUnits;
      break;
    case "multiply":
      state.fractional *= effect.factor;
      break;
  }

  // A price is never negative. Further discounts on a floored price do nothing,
  // which is what a merchant means by "this can't go below zero".
  if (state.fractional < 0) {
    state.fractional = 0;
    state.clampedAtZero = true;
  }
}

function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new RangeError(
      `Quantity must be a whole number of at least 1; got ${quantity}. ` +
        `If you are pricing an empty line, do not price it.`,
    );
  }
}

/**
 * Resolve `{ customer, product, quantity, market } → price`.
 *
 * Every price Mannon shows or charges comes from here. Pure and deterministic:
 * the same input always produces the same output, including the same trace.
 */
export function resolvePrice(input: ResolveInput): PriceResolution {
  return resolveInternal(input, true);
}

function resolveInternal(input: ResolveInput, withNextTier: boolean): PriceResolution {
  const { rules, context } = input;
  const rounding: RoundingMode = input.options?.rounding ?? "half_up";
  const currency = context.market.currencyCode;

  assertQuantity(context.quantity);

  if (context.product.price.currencyCode !== currency) {
    throw new Error(
      `Product price is in ${context.product.price.currencyCode} but the market ` +
        `presents ${currency}. Convert before calling the engine — it will not ` +
        `invent an exchange rate.`,
    );
  }

  const trace: TraceEntry[] = [];
  const eligible: PricingRule[] = [];

  // 1. Which rules could apply at all.
  for (const rule of rules) {
    const reason = eligibilityReason(rule, context);
    if (reason) {
      trace.push({ ruleId: rule.id, ruleName: rule.name, applied: false, reason });
    } else {
      eligible.push(rule);
    }
  }

  eligible.sort(compareRules);

  // 2. Walk them in cascade order, applying what can apply.
  const state: ResolveState = {
    fractional: context.product.price.amount,
    clampedAtZero: false,
  };
  const appliedRuleIds: string[] = [];
  let winnerCombinable: boolean | null = null;

  for (const rule of eligible) {
    if (winnerCombinable === false) {
      // The winning rule forbids stacking, so nothing else gets a look in.
      trace.push({
        ruleId: rule.id,
        ruleName: rule.name,
        applied: false,
        reason: "not_combinable_with_winner",
      });
      continue;
    }

    if (winnerCombinable === true && !rule.combinable) {
      // Stacking is opt-in from both sides.
      trace.push({
        ruleId: rule.id,
        ruleName: rule.name,
        applied: false,
        reason: "not_combinable",
      });
      continue;
    }

    const result = effectFor(rule, context);

    if ("skip" in result) {
      // A rule that cannot produce an effect is not the winner — the next one
      // still gets its chance.
      trace.push({
        ruleId: rule.id,
        ruleName: rule.name,
        applied: false,
        reason: result.skip,
        ...(result.detail ? { detail: result.detail } : {}),
      });
      continue;
    }

    const before = money(roundMinorUnits(state.fractional, rounding), currency);
    applyEffect(state, result.effect);
    const after = money(roundMinorUnits(state.fractional, rounding), currency);

    appliedRuleIds.push(rule.id);
    trace.push({
      ruleId: rule.id,
      ruleName: rule.name,
      applied: true,
      priceBefore: before,
      priceAfter: after,
    });

    if (winnerCombinable === null) winnerCombinable = rule.combinable;
  }

  // 3. Round once, at the end. Rounding every step compounds the error.
  const unitPrice = money(roundMinorUnits(state.fractional, rounding), currency);

  return {
    basePrice: context.product.price,
    unitPrice,
    lineTotal: money(unitPrice.amount * context.quantity, currency),
    appliedRuleIds,
    clampedAtZero: state.clampedAtZero,
    nextTier: withNextTier ? computeNextTier(input) : null,
    trace,
  };
}

/**
 * The next volume break and what a unit costs there — "add 8 more units and you
 * unlock the 12% tier" (spec §6).
 *
 * The price is obtained by resolving again at that quantity rather than by
 * applying the tier in isolation, so the number the Buyer Agent quotes is the
 * number the buyer will actually be charged, cascade and all.
 */
function computeNextTier(input: ResolveInput): NextTier | null {
  const { rules, context } = input;

  const tierRule = rules
    .filter((rule) => rule.kind === "volume_tier")
    .filter((rule) => eligibilityReason(rule, context) === null)
    .sort(compareRules)[0];

  if (!tierRule || tierRule.kind !== "volume_tier") return null;

  const next = nextVolumeTier(tierRule.value.tiers, context.quantity);
  if (!next) return null;

  const atNextQuantity = resolveInternal(
    { ...input, context: { ...context, quantity: next.minQuantity } },
    false,
  );

  return {
    quantity: next.minQuantity,
    unitPrice: atNextQuantity.unitPrice,
    additionalQuantity: next.minQuantity - context.quantity,
  };
}

/** Human-readable one-liner for a resolution. Handy in logs and tests. */
export function describeResolution(result: PriceResolution): string {
  const applied =
    result.appliedRuleIds.length > 0 ? result.appliedRuleIds.join(" → ") : "no rules";
  return `${formatMoney(result.basePrice)} → ${formatMoney(result.unitPrice)} (${applied})`;
}
