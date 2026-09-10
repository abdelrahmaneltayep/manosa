import { eligibilityReason } from "./eligibility";
import { compareMoney, subtractMoney, type Money } from "./money";
import { resolvePrice } from "./resolve";
import type {
  CustomerContext,
  MarketContext,
  PriceResolution,
  PricingRule,
  ResolveOptions,
} from "./types";

export interface MarginReport {
  unitPrice: Money;
  unitCost: Money;
  /** Price less cost. Negative means the rule sells below cost. */
  margin: Money;
  /** Margin as a share of price, or null when the price is zero. */
  marginRatio: number | null;
  belowCost: boolean;
}

/**
 * What a resolved price leaves after cost.
 *
 * The margin guard (spec §2) warns before a rule is saved, and the analytics
 * pages report on the same number. Both read it from here so a "sells below
 * cost" warning and the price it is warning about can never disagree.
 */
export function marginFor(resolution: PriceResolution, unitCost: Money): MarginReport {
  const margin = subtractMoney(resolution.unitPrice, unitCost);

  return {
    unitPrice: resolution.unitPrice,
    unitCost,
    margin,
    marginRatio:
      resolution.unitPrice.amount === 0
        ? null
        : margin.amount / resolution.unitPrice.amount,
    belowCost: margin.amount < 0,
  };
}

/* -------------------------------------------------------------------------- */
/* The margin guard                                                            */
/* -------------------------------------------------------------------------- */

/** One variant the guard can price: everything the engine needs, plus its cost. */
export interface MarginCandidate {
  variantId: string;
  productId: string;
  /** Shopify's SKU. The merchant's own name for the thing, when they set one. */
  sku: string | null;
  title: string;
  collectionIds: string[];
  price: Money;
  /** Null when the merchant has never recorded a cost for it. */
  cost: Money | null;
}

export interface BelowCostFinding {
  variantId: string;
  sku: string | null;
  title: string;
  /** The quantity at which it goes under — for tiers, the break that does it. */
  quantity: number;
  unitPrice: Money;
  unitCost: Money;
  /** How far under cost, per unit. Always positive. */
  shortfall: Money;
}

export interface MarginGuardReport {
  /** Variants the rule actually priced. Excluded ones are not "checked". */
  checked: number;
  /** Priced, but with no cost on record — nothing can be said about them. */
  costUnknown: number;
  /** Handed to the guard but not priced by this rule (excluded, or no tier). */
  notApplicable: number;
  /** Worst first. Every one of them, not a sample of the sample. */
  belowCost: BelowCostFinding[];
}

/**
 * The quantities worth pricing for this rule.
 *
 * A volume rule can be safe at 10 and below cost at 50, which is exactly the
 * warning the spec asks for ("this tier sells SKU-123 below cost"), so every
 * break gets priced rather than one representative basket.
 */
export function checkpointQuantities(rule: PricingRule): number[] {
  const quantities = new Set<number>([1]);

  if (rule.kind === "volume_tier") {
    for (const tier of rule.value.tiers) {
      if (Number.isSafeInteger(tier.minQuantity) && tier.minQuantity > 0) {
        quantities.add(tier.minQuantity);
      }
    }
  }

  return [...quantities].sort((a, b) => a - b);
}

/** Stands in for a real id where the rule does not name one. */
const GUARD_ID = "mannon-margin-guard";

/**
 * A buyer this rule would actually price.
 *
 * Checking a wholesale-tagged rule against a guest tells the merchant nothing:
 * every candidate would come back "audience_mismatch" and the guard would
 * report a clean bill of health for a rule that sells at a loss. So the guard
 * asks the question the merchant is asking — "when this applies, what happens?"
 * — and builds the buyer it applies to.
 */
export function representativeCustomer(rule: PricingRule): CustomerContext | null {
  const { audience } = rule;
  if (audience.mode === "guests") return null;

  return {
    id:
      audience.mode === "customers" ? (audience.customerIds?.[0] ?? GUARD_ID) : GUARD_ID,
    tags: audience.mode === "tags" ? (audience.tags ?? []) : [],
    groupIds: audience.mode === "groups" ? (audience.groupIds ?? []) : [],
    companyId: audience.mode === "companies" ? (audience.companyIds?.[0] ?? null) : null,
    companyLocationId: null,
  };
}

/** A market this rule is not excluded from. */
export function representativeMarket(
  rule: PricingRule,
  currencyCode: string,
  countryCode = "US",
): MarketContext {
  const scope = rule.markets;
  const marketId = scope.mode === "include" ? (scope.marketIds[0] ?? GUARD_ID) : GUARD_ID;

  return { marketId, countryCode, currencyCode };
}

/**
 * Would this rule ever sell one of these below cost?
 *
 * Deterministic, and deliberately so: the model never computes what a module
 * can. Claude drafts the rule; this decides whether the draft loses money, and
 * the merchant sees the arithmetic rather than an opinion.
 *
 * Status and schedule are neutralised before pricing. A draft that starts next
 * month would otherwise come back "not_active" for every SKU, which reads as
 * safe — the most dangerous possible answer for a guard to give.
 */
export function guardMargins(
  rule: PricingRule,
  candidates: readonly MarginCandidate[],
  options: {
    currencyCode: string;
    now: Date;
    /** Only the worst few are shown; the count is still the true one. */
    resolve?: ResolveOptions;
  },
): MarginGuardReport {
  const asIfLive: PricingRule = {
    ...rule,
    status: "active",
    schedule: { startsAt: null, endsAt: null },
  };
  const customer = representativeCustomer(asIfLive);
  const market = representativeMarket(asIfLive, options.currencyCode);
  const quantities = checkpointQuantities(asIfLive);

  const report: MarginGuardReport = {
    checked: 0,
    costUnknown: 0,
    notApplicable: 0,
    belowCost: [],
  };

  for (const candidate of candidates) {
    // The engine refuses to invent an exchange rate, and so does the guard: a
    // variant priced in another currency is reported as unchecked, not as safe.
    if (candidate.price.currencyCode !== options.currencyCode) {
      report.notApplicable += 1;
      continue;
    }

    let priced = false;
    let worst: BelowCostFinding | null = null;

    for (const quantity of quantities) {
      const context = {
        customer,
        product: {
          productId: candidate.productId,
          variantId: candidate.variantId,
          collectionIds: candidate.collectionIds,
          price: candidate.price,
          cost: candidate.cost,
        },
        quantity,
        market,
        cartSubtotal: null,
        now: options.now,
      };

      if (eligibilityReason(asIfLive, context)) continue;

      const resolution = resolvePrice({
        rules: [asIfLive],
        context,
        options: options.resolve,
      });
      if (resolution.appliedRuleIds.length === 0) continue;

      priced = true;
      if (!candidate.cost) continue;

      const margin = marginFor(resolution, candidate.cost);
      if (!margin.belowCost) continue;

      const finding: BelowCostFinding = {
        variantId: candidate.variantId,
        sku: candidate.sku,
        title: candidate.title,
        quantity,
        unitPrice: margin.unitPrice,
        unitCost: margin.unitCost,
        shortfall: { amount: -margin.margin.amount, currencyCode: options.currencyCode },
      };

      // One finding per variant, at the quantity where it is worst — five rows
      // for one SKU would bury the four other SKUs that are also losing money.
      if (!worst || finding.shortfall.amount > worst.shortfall.amount) worst = finding;
    }

    if (!priced) {
      report.notApplicable += 1;
      continue;
    }

    report.checked += 1;
    if (!candidate.cost) report.costUnknown += 1;
    if (worst) report.belowCost.push(worst);
  }

  report.belowCost.sort(
    (a, b) =>
      compareMoney(b.shortfall, a.shortfall) || a.variantId.localeCompare(b.variantId),
  );

  return report;
}
