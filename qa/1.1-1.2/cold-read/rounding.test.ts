/**
 * Cold-read probe: does the engine's percentage arithmetic agree with exact
 * decimal arithmetic, half-up, at every percentage with two decimals?
 *
 * Run: npx vitest run --config qa/1.1-1.2/cold-read/vitest.config.ts
 */
import { describe, expect, it } from "vitest";
import { money, resolvePrice } from "@mannon/pricing-engine";
import type { PricingContext, PricingRule } from "@mannon/pricing-engine";

const base = {
  id: "r",
  name: "r",
  status: "active" as const,
  priority: 10,
  combinable: false,
  targets: { mode: "all" as const },
  audience: { mode: "all" as const },
  markets: { mode: "all" as const, marketIds: [] },
  schedule: {},
  createdAt: new Date("2026-01-01"),
};

function ctx(price: number, qty = 1): PricingContext {
  return {
    customer: null,
    product: {
      productId: "p",
      variantId: "v",
      collectionIds: [],
      price: money(price, "USD"),
      cost: null,
    },
    quantity: qty,
    market: { marketId: "m", countryCode: "US", currencyCode: "USD" },
    cartSubtotal: null,
    now: new Date("2026-06-15T12:00:00Z"),
  };
}

/** Exact half-up of price × (100 − pct) / 100, in integers. */
function exact(price: bigint, pctHundredths: bigint): bigint {
  const num = price * (10000n - pctHundredths);
  const q = num / 10000n;
  const r = num % 10000n;
  return r * 2n >= 10000n ? q + 1n : q;
}

describe("percentage arithmetic vs exact decimal", () => {
  it("never differs by a cent", () => {
    const mismatches: string[] = [];
    for (let pct100 = 1; pct100 <= 9999; pct100 += 1) {
      const rule = {
        ...base,
        kind: "percentage" as const,
        value: { percentage: pct100 / 100 },
      } as PricingRule;
      for (let price = 1; price <= 2000; price += 1) {
        const got = resolvePrice({ rules: [rule], context: ctx(price) }).unitPrice.amount;
        const want = Number(exact(BigInt(price), BigInt(pct100)));
        if (got !== want) {
          mismatches.push(
            `price=${price} pct=${pct100 / 100} engine=${got} exact=${want}`,
          );
        }
      }
    }
    console.log(`mismatches: ${mismatches.length}`, mismatches.slice(0, 20));
    expect(mismatches).toEqual([]);
  });
});
