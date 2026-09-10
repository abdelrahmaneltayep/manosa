/**
 * The slice of Shopify's cart validation API this extension uses.
 *
 * Hand-written rather than generated, for the same reason as the discount
 * Function's types: `shopify app function typegen` needs network access, and
 * the generated types for the whole API are thousands of lines of which we use
 * about twenty. These mirror `run.graphql` exactly — if the query changes,
 * change these with it.
 *
 * Checked against `Shopify/function-examples`
 * `checkout/javascript/cart-checkout-validation/default/schema.graphql`.
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

/** Where the buyer is in their purchase. */
export type BuyerJourneyStep =
  "CART_INTERACTION" | "CHECKOUT_INTERACTION" | "CHECKOUT_COMPLETION";

export interface RunInput {
  cart: {
    cost: { subtotalAmount: MoneyV2 };
    lines: { quantity: number }[];
    buyerIdentity?: {
      isAuthenticated: boolean;
      customer?: { metafield?: MetafieldValue | null } | null;
    } | null;
  };
  localization: { country: { isoCode: string } };
  shop: { metafield?: MetafieldValue | null };
}

export interface FunctionError {
  localizedMessage: string;
  /** A JSONPath into the checkout. `$.cart` puts the message on the cart. */
  target: string;
}

export interface FunctionRunResult {
  errors: FunctionError[];
}
