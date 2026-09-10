import type { Money } from "@mannon/pricing-engine";

/**
 * One limit, as the merchant set it.
 *
 * Every bound is optional. A limit with no bounds at all is not a limit, and
 * `validateLimit` refuses it: a rule that constrains nothing on a screen headed
 * "Order limits" is a merchant believing they set something they did not.
 */
export interface OrderLimit {
  id: string;
  enabled: boolean;
  /** The customer group it applies to. Null is the store-wide fallback. */
  groupId: string | null;

  minSubtotal: Money | null;
  maxSubtotal: Money | null;

  minQuantity: number | null;
  maxQuantity: number | null;
  /** Case packs: the cart's total quantity must be a multiple of this. */
  quantityIncrement: number | null;

  /**
   * ISO 3166-1 alpha-2 codes this applies in. Empty means everywhere.
   *
   * Countries, not markets: the cart validation Function is handed the
   * country directly, while mapping a country to a market needs a query we
   * cannot verify without a store. See DECISIONS.md.
   */
  countries: string[];
}

/** What the buyer has in front of them. */
export interface CartFacts {
  subtotal: Money;
  totalQuantity: number;
  /** The buyer's group ids, from the published buyer facts. */
  groupIds: string[];
  /** The buyer's tags, lowercased by the caller or not — we compare loosely. */
  tags: string[];
  /** Where the buyer is, from the storefront's localisation. */
  countryCode: string | null;
  /** True when this is a Shopify POS sale. */
  isPos: boolean;
  /** True when the buyer is signed in. Limits never apply to guests. */
  isAuthenticated: boolean;
}

export type ViolationCode =
  | "below_minimum_subtotal"
  | "above_maximum_subtotal"
  | "below_minimum_quantity"
  | "above_maximum_quantity"
  | "not_a_multiple";

export interface Violation {
  code: ViolationCode;
  limitId: string;
  /** The bound that was not met. */
  required: Money | number;
  /** What the cart actually has. */
  actual: Money | number;
  /**
   * How far off they are, in the same unit as `required`. Always positive.
   *
   * This is the number the message is built from — "add $38", "remove 4" — and
   * the reason a violation carries numbers rather than a sentence.
   */
  gap: Money | number;
}

export interface LimitVerdict {
  /** Every unmet bound, in a stable order. Empty means the cart may proceed. */
  violations: Violation[];
  /** The limit that was applied, or null when none did. */
  applied: OrderLimit | null;
  /** Why no limit applied, when none did. */
  skipped:
    | "guest"
    | "empty_cart"
    | "pos_bypass"
    | "no_limit_for_this_buyer"
    | "wrong_country"
    | "disabled"
    | null;
}
