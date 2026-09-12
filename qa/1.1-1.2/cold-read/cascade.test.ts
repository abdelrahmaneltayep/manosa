/**
 * Cold-read probes on the cascade: what the admin says a rule does versus what
 * checkout does with it.
 * Run: npx vitest run --config qa/1.1-1.2/cold-read/vitest.config.ts
 */
import { describe, expect, it } from "vitest";
import {
  money,
  parseMoney,
  resolvePrice,
  serializeRuleset,
  type PricingContext,
  type PricingRule,
} from "@mannon/pricing-engine";

import { previewFor } from "~/lib/pricing/view-model.server";
import { cartLinesDiscountsGenerateRun } from "../../../extensions/mannon-discount/src/cart_lines_discounts_generate_run";
import type { CartLine, FunctionInput } from "../../../extensions/mannon-discount/src/api";

const NOW = new Date("2026-06-15T12:00:00Z");

const baseRule = {
  id: "r",
  name: "Rule",
  status: "active" as const,
  priority: 100,
  combinable: false,
  targets: { mode: "all" as const },
  audience: { mode: "all" as const },
  markets: { mode: "all" as const, marketIds: [] },
  schedule: { startsAt: null, endsAt: null },
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

const input = (rules: PricingRule[], amount = "100.00"): FunctionInput => ({
  cart: {
    cost: { subtotalAmount: { amount, currencyCode: "USD" } },
    buyerIdentity: {
      customer: {
        id: "gid://shopify/Customer/1",
        buyer: { jsonValue: { tags: [], groupIds: [] } },
      },
    },
    lines: [
      {
        id: "gid://shopify/CartLine/1",
        quantity: 1,
        cost: { amountPerQuantity: { amount, currencyCode: "USD" } },
        merchandise: {
          __typename: "ProductVariant",
          id: "gid://shopify/ProductVariant/1",
          product: { id: "gid://shopify/Product/1", collections: null },
        },
      } as CartLine,
    ],
  },
  discount: {
    discountClasses: ["PRODUCT"],
    ruleset: { jsonValue: serializeRuleset(rules) },
  },
  localization: { country: { isoCode: "US" } },
});

const charged = (result: ReturnType<typeof cartLinesDiscountsGenerateRun>) => {
  const off = Number(
    result.operations[0]?.productDiscountsAdd.candidates[0]?.value.fixedAmount.amount ??
      "0",
  );
  return 10000 - Math.round(off * 100);
};

describe("a contract price above the shelf price", () => {
  const uplift = {
    ...baseRule,
    id: "uplift",
    name: "Special order price",
    kind: "fixed_price" as const,
    value: { base: parseMoney("120.00", "USD"), overrides: {} },
  } as PricingRule;

  it("is shown in the admin preview exactly as checkout will charge it", () => {
    const preview = previewFor(uplift, "USD", NOW);
    // The preview prices a $100.00 sample.
    expect({ preview: preview.now, charged: charged(cartLinesDiscountsGenerateRun(input([uplift]))) })
      .toEqual({ preview: "$100.00", charged: 10000 });
  });
});

describe("a negotiated contract price and a later combinable rule", () => {
  const contract = {
    ...baseRule,
    id: "contract",
    name: "Contract price",
    combinable: true,
    priority: 1,
    kind: "fixed_price" as const,
    value: { base: parseMoney("80.00", "USD"), overrides: {} },
  } as PricingRule;

  const cartTier = {
    ...baseRule,
    id: "cart-tier",
    name: "Spend $50, pay $90",
    combinable: true,
    priority: 99,
    kind: "cart_value_tier" as const,
    value: {
      tiers: [
        {
          minSubtotal: parseMoney("50.00", "USD"),
          maxSubtotal: null,
          kind: "fixed_price" as const,
          amount: parseMoney("90.00", "USD"),
        },
      ],
    },
  } as PricingRule;

  it("never charges more than the contract price", () => {
    const context: PricingContext = {
      customer: { id: "c", tags: [], groupIds: [], companyId: null },
      product: {
        productId: "p",
        variantId: "v",
        collectionIds: [],
        price: money(10000, "USD"),
        cost: null,
      },
      quantity: 1,
      market: { marketId: "m", countryCode: "US", currencyCode: "USD" },
      cartSubtotal: money(10000, "USD"),
      now: NOW,
    };
    const result = resolvePrice({ rules: [contract, cartTier], context });
    expect({
      unitPrice: result.unitPrice.amount,
      applied: result.appliedRuleIds,
    }).toEqual({ unitPrice: 8000, applied: ["contract", "cart-tier"] });
  });
});
