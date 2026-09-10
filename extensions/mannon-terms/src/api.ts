/**
 * The slice of Shopify's payment customization API this extension uses.
 *
 * Hand-written rather than generated, for the same reason as the other two
 * Functions: `shopify app function typegen` needs network access, and the
 * generated types for the whole API are thousands of lines of which we use
 * about fifteen. These mirror `run.graphql` exactly — if the query changes,
 * change these with it.
 *
 * Checked against `Shopify/function-examples`
 * `checkout/javascript/payment-customization/default/schema.graphql`.
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

export interface PaymentMethod {
  id: string;
  name: string;
}

export interface RunInput {
  cart: {
    cost: { totalAmount: MoneyV2 };
    buyerIdentity?: {
      isAuthenticated: boolean;
      customer?: { metafield?: MetafieldValue | null } | null;
    } | null;
  };
  paymentMethods: PaymentMethod[];
  shop: { metafield?: MetafieldValue | null };
}

export interface HideOperation {
  hide: { paymentMethodId: string };
}

export interface RenameOperation {
  rename: { paymentMethodId: string; name: string };
}

export type Operation = HideOperation | RenameOperation;

export interface FunctionRunResult {
  operations: Operation[];
}
