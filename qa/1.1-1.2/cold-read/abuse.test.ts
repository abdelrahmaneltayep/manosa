/**
 * Cold-read abuse cases.
 *
 *  1. malformed / future-format ruleset at checkout
 *  2. a hand-edited metafield carrying a negative percentage
 *  3. one shop's pricing rule fetched by raw id from another shop
 *
 * Run: TEST_DATABASE_URL=... npx vitest run --config qa/1.1-1.2/cold-read/vitest.config.ts
 */
import { describe, expect, it } from "vitest";
import { deserializeRuleset, serializeRuleset, type PricingRule } from "@mannon/pricing-engine";

import { cartLinesDiscountsGenerateRun } from "../../../extensions/mannon-discount/src/cart_lines_discounts_generate_run";
import type { CartLine, FunctionInput } from "../../../extensions/mannon-discount/src/api";

const rule = (overrides: Partial<PricingRule> = {}): PricingRule =>
  ({
    id: "wholesale-35",
    name: "Wholesale 35% off",
    status: "active",
    priority: 100,
    combinable: false,
    kind: "percentage",
    value: { percentage: 35 },
    targets: { mode: "all" },
    audience: { mode: "all" },
    markets: { mode: "all", marketIds: [] },
    schedule: { startsAt: null, endsAt: null },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }) as PricingRule;

const input = (ruleset: unknown): FunctionInput => ({
  cart: {
    cost: { subtotalAmount: { amount: "10.00", currencyCode: "USD" } },
    buyerIdentity: {
      customer: {
        id: "gid://shopify/Customer/1",
        buyer: { jsonValue: { tags: ["wholesale"], groupIds: [] } },
      },
    },
    lines: [
      {
        id: "gid://shopify/CartLine/1",
        quantity: 1,
        cost: { amountPerQuantity: { amount: "10.00", currencyCode: "USD" } },
        merchandise: {
          __typename: "ProductVariant",
          id: "gid://shopify/ProductVariant/1",
          product: { id: "gid://shopify/Product/1", collections: null },
        },
      } as CartLine,
    ],
  },
  discount: { discountClasses: ["PRODUCT"], ruleset: { jsonValue: ruleset } },
  localization: { country: { isoCode: "US" } },
});

const candidates = (result: ReturnType<typeof cartLinesDiscountsGenerateRun>) =>
  result.operations[0]?.productDiscountsAdd.candidates ?? [];

describe("a ruleset written by a newer version of the app", () => {
  it("is refused loudly rather than silently charging every buyer retail", () => {
    const future = { ...serializeRuleset([rule()]), v: 2 };
    const read = deserializeRuleset(future);
    expect(read.errors).toHaveLength(1);
    // Nothing anywhere turns that error into something a merchant can see.
    expect(candidates(cartLinesDiscountsGenerateRun(input(future)))).toHaveLength(1);
  });
});

describe("a hand-edited metafield with a negative percentage", () => {
  it("cannot raise the price", () => {
    const evil = serializeRuleset([rule({ value: { percentage: -50 } } as Partial<PricingRule>)]);
    expect(candidates(cartLinesDiscountsGenerateRun(input(evil)))).toEqual([]);
  });
});
