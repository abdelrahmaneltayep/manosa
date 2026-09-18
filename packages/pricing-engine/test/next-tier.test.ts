import { describe, expect, it } from "vitest";

import { money, resolvePrice, type PricingContext, type PricingRule } from "../src/index";

/**
 * "Add 8 more units and you unlock the 12% tier" is a promise, and the Buyer
 * Agent repeats it verbatim. These tests are about the cart that promise is
 * made in: the units being added land in it, so the cart the next tier is
 * priced against is not the cart the buyer has now.
 */

const NOW = new Date("2026-09-10T12:00:00Z");
const USD = (amount: number) => money(amount, "USD");

const base: PricingRule = {
  id: "volume",
  name: "Volume breaks",
  status: "active",
  priority: 100,
  combinable: true,
  targets: { mode: "all" },
  audience: { mode: "all" },
  markets: { mode: "all", marketIds: [] },
  schedule: { startsAt: null, endsAt: null },
  createdAt: NOW,
  kind: "volume_tier",
  value: {
    tiers: [
      { minQuantity: 1, maxQuantity: 9, kind: "percentage", percentage: 5 },
      { minQuantity: 10, maxQuantity: null, kind: "percentage", percentage: 10 },
    ],
  },
};

/** Half off, but only once the cart is worth $500. */
const cartRule: PricingRule = {
  ...base,
  id: "cart",
  name: "Big baskets",
  kind: "cart_value_tier",
  value: {
    tiers: [
      { minSubtotal: USD(50_000), maxSubtotal: null, kind: "percentage", percentage: 50 },
    ],
  },
};

/** One $100 unit, and it is the only thing in the cart. */
const context: PricingContext = {
  customer: {
    id: "c1",
    tags: [],
    groupIds: [],
    companyId: null,
    companyLocationId: null,
  },
  product: {
    productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/1",
    collectionIds: [],
    price: USD(10_000),
    cost: null,
  },
  quantity: 1,
  market: { marketId: "m", countryCode: "US", currencyCode: "USD" },
  cartSubtotal: USD(10_000),
  now: NOW,
};

describe("the next volume break", () => {
  it("prices it in the cart the added units would make, not the cart today", () => {
    const result = resolvePrice({ rules: [base, cartRule], context });

    // Today: one unit, 5% off, and a $100 cart that reaches no cart tier.
    expect(result.unitPrice).toEqual(USD(9_500));

    // Ten units at $100 is a $1,000 cart, which does reach it: 10% off the
    // volume break, then half off the basket. Carrying the $100 subtotal
    // across would quote $90 — a price the buyer would never be charged.
    expect(result.nextTier).toEqual({
      quantity: 10,
      unitPrice: USD(4_500),
      additionalQuantity: 9,
    });
  });

  it("leaves a cart it was never given alone", () => {
    const result = resolvePrice({
      rules: [base, cartRule],
      context: { ...context, cartSubtotal: null },
    });

    // No cart means no cart tier, at this quantity or the next one. Inventing
    // one here would be the product page promising a checkout price.
    expect(result.nextTier?.unitPrice).toEqual(USD(9_000));
  });

  it("does not add units priced in one currency to a cart counted in another", () => {
    const result = resolvePrice({
      rules: [base, cartRule],
      context: { ...context, cartSubtotal: money(10_000, "EUR") },
    });

    // The engine will not convert, so the cart is passed through untouched and
    // the cart-value rule finds nothing it can read.
    expect(result.nextTier?.unitPrice).toEqual(USD(9_000));
  });
});
