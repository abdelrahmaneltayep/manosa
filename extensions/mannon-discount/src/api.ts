/**
 * The slice of Shopify's discount Function API this extension uses.
 *
 * Hand-written rather than generated: `shopify app function typegen` needs
 * network access to fetch the schema, and generated types for the whole API
 * would be thousands of lines of which we select about thirty. These mirror
 * `cart_lines_discounts_generate_run.graphql` exactly — if the query changes,
 * change these with it.
 */

/** A signed decimal serialised as a string, e.g. "29.99". */
export type Decimal = string;

export interface MoneyV2 {
  amount: Decimal;
  currencyCode: string;
}

export interface MetafieldValue {
  jsonValue: unknown;
}

export interface FunctionInput {
  cart: {
    cost: { subtotalAmount: MoneyV2 };
    buyerIdentity?: {
      customer?: {
        id: string;
        buyer?: MetafieldValue | null;
      } | null;
      purchasingCompany?: { company: { id: string } } | null;
    } | null;
    lines: CartLine[];
  };
  discount: {
    discountClasses: string[];
    ruleset?: MetafieldValue | null;
  };
  localization: { country: { isoCode: string } };
}

export interface CartLine {
  id: string;
  quantity: number;
  cost: { amountPerQuantity: MoneyV2 };
  merchandise:
    | {
        __typename: "ProductVariant";
        id: string;
        product: { id: string; collections?: MetafieldValue | null };
      }
    | { __typename: "CustomProduct" };
}

export interface ProductDiscountCandidate {
  message: string;
  targets: { cartLine: { id: string; quantity?: number } }[];
  value: { fixedAmount: { amount: Decimal; appliesToEachItem?: boolean } };
}

export interface CartLinesDiscountsGenerateRunResult {
  operations: {
    productDiscountsAdd: {
      candidates: ProductDiscountCandidate[];
      selectionStrategy: "ALL" | "FIRST" | "MAXIMUM";
    };
  }[];
}

export const DISCOUNT_CLASS_PRODUCT = "PRODUCT";
