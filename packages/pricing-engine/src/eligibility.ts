import type {
  Audience,
  CustomerContext,
  MarketContext,
  MarketScope,
  PricingContext,
  PricingRule,
  ProductContext,
  Schedule,
  SkipReason,
  Targeting,
} from "./types";

/** Tags are merchant-entered, so matching ignores case and surrounding space. */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function scheduleReason(schedule: Schedule, now: Date): SkipReason | null {
  if (schedule.startsAt && now < schedule.startsAt) return "not_started";
  // An end date is inclusive of the instant it names, so a rule ending at
  // 23:59:59 is live at 23:59:59 and dead at 23:59:60.
  if (schedule.endsAt && now > schedule.endsAt) return "ended";
  return null;
}

function audienceMatches(audience: Audience, customer: CustomerContext | null): boolean {
  switch (audience.mode) {
    case "all":
      return true;
    case "guests":
      return customer === null;
    case "tags": {
      if (!customer) return false;
      const wanted = new Set((audience.tags ?? []).map(normalizeTag));
      return customer.tags.some((tag) => wanted.has(normalizeTag(tag)));
    }
    case "groups": {
      if (!customer) return false;
      const wanted = new Set(audience.groupIds ?? []);
      return customer.groupIds.some((id) => wanted.has(id));
    }
    case "customers":
      return customer !== null && (audience.customerIds ?? []).includes(customer.id);
    case "companies":
      return (
        customer?.companyId != null &&
        (audience.companyIds ?? []).includes(customer.companyId)
      );
    default:
      // An audience mode we do not know cannot be shown to be a match, and
      // guessing would hand a price to the wrong buyer.
      return false;
  }
}

function targetExcluded(targets: Targeting, product: ProductContext): boolean {
  if ((targets.excludeVariantIds ?? []).includes(product.variantId)) return true;
  if ((targets.excludeProductIds ?? []).includes(product.productId)) return true;

  const excludedCollections = new Set(targets.excludeCollectionIds ?? []);
  return product.collectionIds.some((id) => excludedCollections.has(id));
}

function targetIncludes(targets: Targeting, product: ProductContext): boolean {
  switch (targets.mode) {
    case "all":
      return true;
    case "variants":
      return (targets.variantIds ?? []).includes(product.variantId);
    case "products":
      return (targets.productIds ?? []).includes(product.productId);
    case "collections": {
      const wanted = new Set(targets.collectionIds ?? []);
      return product.collectionIds.some((id) => wanted.has(id));
    }
    default:
      return false;
  }
}

function marketAllowed(markets: MarketScope, market: MarketContext): boolean {
  switch (markets.mode) {
    case "all":
      return true;
    case "include":
      return markets.marketIds.includes(market.marketId);
    case "exclude":
      return !markets.marketIds.includes(market.marketId);
    default:
      return false;
  }
}

/**
 * Can this rule apply at all, before we look at what it does?
 *
 * Returns the reason it cannot, or null when it can. Exclusions are checked
 * before inclusions so "everything except sale items" behaves the way the
 * merchant said it in words.
 */
export function eligibilityReason(
  rule: PricingRule,
  context: PricingContext,
): SkipReason | null {
  if (rule.status !== "active") return "not_active";

  const scheduled = scheduleReason(rule.schedule, context.now);
  if (scheduled) return scheduled;

  if (!marketAllowed(rule.markets, context.market)) return "market_excluded";
  if (!audienceMatches(rule.audience, context.customer)) return "audience_mismatch";

  if (targetExcluded(rule.targets, context.product)) return "target_excluded";
  if (!targetIncludes(rule.targets, context.product)) return "target_mismatch";

  return null;
}
