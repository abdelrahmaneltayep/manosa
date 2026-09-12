/**
 * Cold-read probes against the checkout Function's money handling.
 * Run: npx vitest run --config qa/1.1-1.2/cold-read/vitest.config.ts
 */
import { describe, expect, it } from "vitest";
import { parseMoney, serializeRuleset, type PricingRule } from "@mannon/pricing-engine";

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
    audience: { mode: "tags", tags: ["wholesale"] },
    markets: { mode: "all", marketIds: [] },
    schedule: { startsAt: null, endsAt: null },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }) as PricingRule;

const line = (id: string, amount: string, currencyCode = "USD", quantity = 1): CartLine =>
  ({
    id: `gid://shopify/CartLine/${id}`,
    quantity,
    cost: { amountPerQuantity: { amount, currencyCode } },
    merchandise: {
      __typename: "ProductVariant",
      id: `gid://shopify/ProductVariant/${id}`,
      product: { id: `gid://shopify/Product/${id}`, collections: null },
    },
  }) as CartLine;

const input = (lines: CartLine[], subtotal: string, currency = "USD"): FunctionInput => ({
  cart: {
    cost: { subtotalAmount: { amount: subtotal, currencyCode: currency } },
    buyerIdentity: {
      customer: {
        id: "gid://shopify/Customer/1",
        buyer: { jsonValue: { tags: ["wholesale"], groupIds: [] } },
      },
    },
    lines,
  },
  discount: { discountClasses: ["PRODUCT"], ruleset: { jsonValue: serializeRuleset([rule()]) } },
  localization: { country: { isoCode: "US" } },
});

const candidates = (result: ReturnType<typeof cartLinesDiscountsGenerateRun>) =>
  result.operations[0]?.productDiscountsAdd.candidates ?? [];

describe("zero-decimal currencies", () => {
  it("parseMoney rejects the trailing-zero form Shopify serialises MoneyV2 in", () => {
    expect(() => parseMoney("1000.0", "JPY")).toThrow();
  });

  it("a JPY cart keeps its wholesale discount", () => {
    const result = cartLinesDiscountsGenerateRun(
      input([line("1", "1000.0", "JPY")], "1000.0", "JPY"),
    );
    // 35% off 1000 JPY is 350 JPY.
    expect(candidates(result)).toHaveLength(1);
  });
});

describe("one bad line costs one line, not the cart", () => {
  it("a line with sub-cent precision does not remove the other line's discount", () => {
    const result = cartLinesDiscountsGenerateRun(
      input([line("1", "10.00"), line("2", "10.001")], "20.00"),
    );
    expect(candidates(result).map((c) => c.targets[0]!.cartLine.id)).toContain(
      "gid://shopify/CartLine/1",
    );
  });
});
