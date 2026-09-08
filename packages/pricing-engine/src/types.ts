import type { Money, RoundingMode } from "./money";

/* -------------------------------------------------------------------------- */
/* Context — what we are pricing, and for whom                                 */
/* -------------------------------------------------------------------------- */

export interface CustomerContext {
  id: string;
  /** Shopify customer tags, as stored. Matching is case-insensitive. */
  tags: string[];
  /** Mannon customer group ids. */
  groupIds: string[];
  /** Shopify B2B company, on Plus. */
  companyId?: string | null;
  companyLocationId?: string | null;
}

export interface ProductContext {
  productId: string;
  variantId: string;
  collectionIds: string[];
  /** The price this buyer would otherwise pay, in the market's currency. */
  price: Money;
  /** Unit cost, when known. Only used by the margin guard, never by pricing. */
  cost?: Money | null;
}

export interface MarketContext {
  marketId: string;
  countryCode: string;
  /** Presentment currency. Every Money in a resolution is in this currency. */
  currencyCode: string;
}

export interface PricingContext {
  /** null means a guest — not logged in. */
  customer: CustomerContext | null;
  product: ProductContext;
  quantity: number;
  market: MarketContext;
  /**
   * Cart subtotal, when the caller knows it. Cart-value rules are skipped
   * rather than guessed at when this is absent: a product page has no cart, and
   * showing a cart-tier price there would promise something checkout will not
   * honour.
   */
  cartSubtotal?: Money | null;
  now: Date;
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

export type RuleStatus = "draft" | "active" | "archived";

export type RuleKind =
  "fixed_price" | "volume_tier" | "cart_value_tier" | "amount_off" | "percentage";

/**
 * An absolute amount, per currency.
 *
 * A rule priced in USD has no meaning in EUR unless the merchant has said what
 * it is. The engine will not convert — see `no_price_in_currency`.
 */
export interface CurrencyAmount {
  base: Money;
  overrides: Record<string, Money>;
}

export type VolumeTier = { minQuantity: number; maxQuantity: number | null } & (
  | { kind: "percentage"; percentage: number }
  | { kind: "amount_off"; amount: Money }
  | { kind: "fixed_price"; amount: Money }
);

export type CartValueTier = { minSubtotal: Money; maxSubtotal: Money | null } & (
  { kind: "percentage"; percentage: number } | { kind: "fixed_price"; amount: Money }
);

export type TargetingMode = "all" | "collections" | "products" | "variants";

export interface Targeting {
  mode: TargetingMode;
  collectionIds?: string[];
  productIds?: string[];
  variantIds?: string[];
  /** Exclusions win over inclusions — "everything except sale items". */
  excludeCollectionIds?: string[];
  excludeProductIds?: string[];
  excludeVariantIds?: string[];
}

export type AudienceMode =
  "all" | "tags" | "groups" | "customers" | "companies" | "guests";

export interface Audience {
  mode: AudienceMode;
  tags?: string[];
  groupIds?: string[];
  customerIds?: string[];
  companyIds?: string[];
}

export interface MarketScope {
  mode: "all" | "include" | "exclude";
  marketIds: string[];
}

export interface Schedule {
  startsAt?: Date | null;
  endsAt?: Date | null;
}

interface RuleBase {
  id: string;
  name: string;
  status: RuleStatus;
  /**
   * Lower runs first and wins. Merchants drag rules up a list to make them
   * matter more, so "first in the list" has to mean "wins".
   */
  priority: number;
  /** Whether this rule may stack with other Mannon rules. */
  combinable: boolean;
  targets: Targeting;
  audience: Audience;
  markets: MarketScope;
  schedule: Schedule;
  /** Deterministic tie-break when two rules share a priority. */
  createdAt: Date;
}

export type PricingRule = RuleBase &
  (
    | { kind: "fixed_price"; value: CurrencyAmount }
    | { kind: "amount_off"; value: CurrencyAmount }
    | { kind: "percentage"; value: { percentage: number } }
    | { kind: "volume_tier"; value: { tiers: VolumeTier[] } }
    | { kind: "cart_value_tier"; value: { tiers: CartValueTier[] } }
  );

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Why a rule did not apply. These are codes, not sentences: the admin's "Why
 * this price?" panel and the Buyer Agent translate them, in the merchant's or
 * the buyer's language.
 */
export type SkipReason =
  | "not_active"
  | "not_started"
  | "ended"
  | "audience_mismatch"
  | "target_mismatch"
  | "target_excluded"
  | "market_excluded"
  | "no_matching_tier"
  | "cart_unknown"
  | "no_price_in_currency"
  | "not_combinable_with_winner"
  | "not_combinable"
  | "invalid_rule";

export interface TraceEntry {
  ruleId: string;
  ruleName: string;
  applied: boolean;
  reason?: SkipReason;
  /** Extra context for the reason, e.g. which currency was missing. */
  detail?: string;
  /** Price before and after this rule, when it applied. */
  priceBefore?: Money;
  priceAfter?: Money;
}

export interface NextTier {
  /** The quantity at which the next break starts. */
  quantity: number;
  /** What a unit costs at that quantity. */
  unitPrice: Money;
  /** How many more units the buyer needs. */
  additionalQuantity: number;
}

export interface PriceResolution {
  /** What the buyer would have paid with no Mannon rules. */
  basePrice: Money;
  /** What they pay per unit. */
  unitPrice: Money;
  /** unitPrice × quantity. What a cart line charges. */
  lineTotal: Money;
  appliedRuleIds: string[];
  /** True when stacking drove the price to the floor. */
  clampedAtZero: boolean;
  /** The next volume break, for tier-aware upsell. Null when there is none. */
  nextTier: NextTier | null;
  /** Every rule considered, and what happened to it. */
  trace: TraceEntry[];
}

export interface ResolveOptions {
  rounding?: RoundingMode;
}

export interface ResolveInput {
  rules: PricingRule[];
  context: PricingContext;
  options?: ResolveOptions;
}
