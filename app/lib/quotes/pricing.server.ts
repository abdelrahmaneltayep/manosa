import {
  formatMoney,
  money,
  resolvePrice,
  type Money,
  type PricingRule,
} from "@mannon/pricing-engine";

import { activeEngineRules } from "~/lib/pricing/rules.server";

/**
 * Pricing a quote, once, and writing the answer down.
 *
 * This is the whole reason quotes exist as their own table rather than as a
 * draft order with a note on it. A quote is a promise: the buyer was told a
 * number, and that number has to survive whatever the merchant changes in the
 * fortnight before they accept.
 *
 * So the engine is asked **once**, at draft time, and what it said is stored on
 * the line. Nothing re-prices a quote afterwards — not the accept path, not the
 * buyer's page, not the draft order. Re-running the engine on accept would be
 * the bug this table exists to prevent.
 */

export interface QuoteLineRequest {
  variantId: string;
  productId?: string | null;
  title: string;
  sku?: string | null;
  quantity: number;
  /** The variant's own price, as a decimal string, in the shop's currency. */
  listPrice: Money;
  /**
   * Which collections this product is in, as published to checkout.
   *
   * Required, and deliberately so. This was `collectionIds: []`, hardcoded one
   * line below, in the one function that prices quick order, quotes, the Buyer
   * Agent and PO-to-order — so a rule excluding a collection excluded nothing
   * here and everything at checkout, and the buyer was shown a price they
   * would not be charged. A caller that does not know has to say `[]` out
   * loud; the type no longer says it for them.
   *
   * Read it with `productCollectionIds` from
   * `~/lib/pricing/product-collections.server`, which reads the same metafield
   * the checkout Function reads.
   */
  collectionIds: string[];
}

export interface PricedLine extends QuoteLineRequest {
  unitPrice: Money;
  appliedRuleIds: string[];
  /** Already-composed, e.g. "Gold tier, 100+ units". Null when nothing applied. */
  ruleSummary: string | null;
}

export interface BuyerForPricing {
  /** Shopify's customer GID, or null for a request with no account behind it. */
  customerId: string | null;
  tags: string[];
  groupIds: string[];
}

/**
 * Price one line the way the storefront would have.
 *
 * A quote is priced as if the buyer were standing at the product page with that
 * quantity in hand: same rules, same audience, same engine. A merchant who then
 * discounts further does it by editing the line, which is visible, rather than
 * by the app quietly using a different cascade.
 */
export function priceLine(
  line: QuoteLineRequest,
  buyer: BuyerForPricing,
  rules: PricingRule[],
  { now, currencyCode }: { now: Date; currencyCode: string },
): PricedLine {
  const result = resolvePrice({
    rules,
    context: {
      customer: buyer.customerId
        ? {
            id: buyer.customerId,
            tags: buyer.tags,
            groupIds: buyer.groupIds,
            companyId: null,
          }
        : null,
      product: {
        productId: line.productId ?? line.variantId,
        variantId: line.variantId,
        collectionIds: line.collectionIds,
        price: line.listPrice,
        cost: null,
      },
      quantity: Math.max(1, Math.trunc(line.quantity)),
      market: { marketId: "", countryCode: "", currencyCode },
      // A quote is the whole order as far as cart-value rules are concerned.
      cartSubtotal: money(
        line.listPrice.amount * Math.max(1, line.quantity),
        currencyCode,
      ),
      now,
    },
  });

  const applied = result.trace.filter((entry) => entry.applied);

  return {
    ...line,
    unitPrice: result.unitPrice,
    appliedRuleIds: result.appliedRuleIds,
    // The engine's own account of what happened, not a second explanation
    // composed from the result — "deciding shows its working".
    ruleSummary:
      applied.length === 0 ? null : applied.map((entry) => entry.ruleName).join(" · "),
  };
}

/** Price every line, and total them. */
export async function priceQuote(
  lines: QuoteLineRequest[],
  buyer: BuyerForPricing,
  { now, currencyCode }: { now: Date; currencyCode: string },
): Promise<{ lines: PricedLine[]; subtotal: Money; unreadableRules: number }> {
  const { rules, unreadable } = await activeEngineRules();

  const priced = lines.map((line) =>
    priceLine(line, buyer, rules, { now, currencyCode }),
  );
  const subtotal = priced.reduce(
    (total, line) => total + line.unitPrice.amount * Math.max(1, line.quantity),
    0,
  );

  return {
    lines: priced,
    subtotal: money(subtotal, currencyCode),
    unreadableRules: unreadable.length,
  };
}

/**
 * Would this line be priced differently today?
 *
 * Not to change it — a locked price never moves — but so the merchant can see
 * that it is now below or above what the store would charge, which is exactly
 * what they want to know before honouring a fortnight-old quote.
 */
export function priceDriftFor(
  line: {
    variantId: string;
    productId: string | null;
    quantity: number;
    unitPrice: Money;
    listPrice: Money;
    collectionIds: string[];
  },
  buyer: BuyerForPricing,
  rules: PricingRule[],
  { now, currencyCode }: { now: Date; currencyCode: string },
): { current: Money; drifted: boolean } {
  const current = priceLine(
    {
      variantId: line.variantId,
      productId: line.productId,
      title: "",
      quantity: line.quantity,
      listPrice: line.listPrice,
      collectionIds: line.collectionIds,
    },
    buyer,
    rules,
    { now, currencyCode },
  ).unitPrice;

  return { current, drifted: current.amount !== line.unitPrice.amount };
}

/** A decimal string for a form field. */
export const asDecimal = (value: Money): string => formatMoney(value);
