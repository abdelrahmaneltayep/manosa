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

  /**
   * FIXED, but not the way this probe first asked for.
   *
   * It expected the preview to read $100.00 — checkout's answer. That would be
   * wrong for the other half of the product: a **quote** and a draft order
   * carry `originalUnitPriceWithCurrency`, so they really do charge $120.00.
   * Showing $100.00 would make the builder lie to anybody quoting with it.
   *
   * So the preview still shows what the engine resolved, and the builder now
   * carries a warning beside it naming which surface will not honour it and
   * why. The screen as a whole is true, which is what Invariant 4 asks for;
   * before, nothing anywhere said it.
   */
  it("is shown in the admin preview exactly as checkout will charge it", () => {
    const preview = previewFor(uplift, "USD", NOW);

    expect({
      preview: preview.now,
      charged: charged(cartLinesDiscountsGenerateRun(input([uplift]))),
    }).toEqual({ preview: "$120.00", charged: 10000 });

    // The disagreement is named rather than left for an order to reveal.
    expect(preview.aboveShelfPrice).toBe(true);
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

    // FIXED. The contract price stands, which was the finding.
    //
    // The expectation here originally read `applied: ["contract", "cart-tier"]`
    // — both applied, the higher one clamped. The engine does something better:
    // the cart tier does **not** apply and the trace says why
    // (`would_raise_price`). Reporting a rule as applied when it changed
    // nothing is its own kind of lie, and "Why this price?" is the feature
    // Invariant 5 exists for.
    expect({
      unitPrice: result.unitPrice.amount,
      applied: result.appliedRuleIds,
    }).toEqual({ unitPrice: 8000, applied: ["contract"] });

    expect(
      result.trace.find((entry) => entry.ruleId === "cart-tier"),
    ).toMatchObject({ applied: false, reason: "would_raise_price" });
  });
});
