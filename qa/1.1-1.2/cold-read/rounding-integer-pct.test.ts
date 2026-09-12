/**
 * Cold-read probe: whole-number percentages only — the ones merchants actually
 * type — against exact half-up decimal arithmetic.
 * Run: npx vitest run --config qa/1.1-1.2/cold-read/vitest.config.ts
 */
import { describe, expect, it } from "vitest";
import { money, resolvePrice } from "@mannon/pricing-engine";
import type { PricingContext, PricingRule } from "@mannon/pricing-engine";

const base = {
  id: "r", name: "r", status: "active" as const, priority: 10, combinable: false,
  targets: { mode: "all" as const }, audience: { mode: "all" as const },
  markets: { mode: "all" as const, marketIds: [] }, schedule: {},
  createdAt: new Date("2026-01-01"),
};

const ctx = (price: number): PricingContext => ({
  customer: null,
  product: { productId: "p", variantId: "v", collectionIds: [], price: money(price, "USD"), cost: null },
  quantity: 1,
  market: { marketId: "m", countryCode: "US", currencyCode: "USD" },
  cartSubtotal: null,
  now: new Date("2026-06-15T12:00:00Z"),
});

function exactHalfUp(price: bigint, pct: bigint): bigint {
  const num = price * (100n - pct);
  const q = num / 100n;
  const r = num % 100n;
  return r * 2n >= 100n ? q + 1n : q;
}

describe("whole-number percentages", () => {
  it("match exact half-up for every price up to $2,000.00", () => {
    const mismatches: string[] = [];
    for (let pct = 1; pct <= 99; pct += 1) {
      const rule = { ...base, kind: "percentage" as const, value: { percentage: pct } } as PricingRule;
      for (let price = 1; price <= 200000; price += 1) {
        const got = resolvePrice({ rules: [rule], context: ctx(price) }).unitPrice.amount;
        const want = Number(exactHalfUp(BigInt(price), BigInt(pct)));
        if (got !== want) mismatches.push(`price=${price} pct=${pct} engine=${got} exact=${want}`);
      }
    }
    console.log(`integer-pct mismatches: ${mismatches.length}`, mismatches.slice(0, 15));
    expect(mismatches).toEqual([]);
  });
});
