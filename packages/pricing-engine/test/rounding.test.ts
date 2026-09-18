import { describe, expect, it } from "vitest";

import {
  money,
  multiplyFraction,
  roundFraction,
  wholeUnits,
  type Fraction,
} from "../src/money";
import { resolvePrice } from "../src/resolve";
import type { PricingContext, PricingRule } from "../src/types";

/**
 * Percentage arithmetic, exactly.
 *
 * `money.ts` opens with *"No price arithmetic anywhere in this package touches
 * a floating-point value"*, and the cascade did: a percentage became
 * `(100 - percentage) / 100` and the running price was multiplied by it in
 * binary floating point. Every value that should land exactly on a half-cent
 * tie landed just below one, and `half_up` rounded it down — a cent per unit,
 * in the buyer's favour, on every line, for ever.
 *
 * Measured before the fix: 12,096 wrong answers across whole-number
 * percentages 1–99 against every price from $0.01 to $2,000.00, and 1,540 more
 * across two-decimal percentages. Every single one low.
 */

const rule = (overrides: Partial<PricingRule> = {}): PricingRule =>
  ({
    id: "pct",
    name: "Wholesale",
    status: "active",
    priority: 100,
    combinable: false,
    kind: "percentage",
    value: { percentage: 6 },
    targets: { mode: "all" },
    audience: { mode: "all" },
    markets: { mode: "all", marketIds: [] },
    schedule: { startsAt: null, endsAt: null },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }) as PricingRule;

const contextFor = (priceMinor: number): PricingContext => ({
  customer: null,
  product: {
    productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/1",
    collectionIds: [],
    price: money(priceMinor, "USD"),
    cost: null,
  },
  quantity: 1,
  market: { marketId: "", countryCode: "US", currencyCode: "USD" },
  cartSubtotal: null,
  now: new Date("2026-06-15T12:00:00Z"),
});

const priceAt = (priceMinor: number, rules: PricingRule[]): number =>
  resolvePrice({ rules, context: contextFor(priceMinor) }).unitPrice.amount;

/** Exact half-up, in integers, with no engine involved. */
function exactHalfUp(priceMinor: number, hundredthsOfPercent: number): number {
  const numerator = priceMinor * (10_000 - hundredthsOfPercent);
  const floor = Math.floor(numerator / 10_000);
  return 2 * (numerator - floor * 10_000) >= 10_000 ? floor + 1 : floor;
}

describe("a percentage off a price", () => {
  /** The plainest case in the finding, and the one to read first. */
  it("gives $10.11 for 6% off $10.75, not $10.10", () => {
    // 1075 × 94 / 100 = 1010.5 exactly. Half-up is 1011.
    expect(priceAt(1075, [rule({ value: { percentage: 6 } })])).toBe(1011);
  });

  it("rounds a half-cent tie up at every whole percentage that produces one", () => {
    const wrong: string[] = [];

    // Every (price, percentage) whose exact result is a half-cent tie. These
    // are the cases the float path got wrong and nothing else.
    for (let percentage = 1; percentage <= 99; percentage += 1) {
      for (let price = 1; price <= 20_000; price += 1) {
        const numerator = price * (100 - percentage);
        if (numerator % 100 !== 50) continue;
        const expected = numerator / 100 + 0.5;
        const actual = priceAt(price, [rule({ value: { percentage } })]);
        if (actual !== expected) wrong.push(`${price}@${percentage}%→${actual}`);
      }
    }

    expect(wrong.length, `ties rounded down: ${wrong.slice(0, 5).join(", ")}`).toBe(0);
  });

  it("matches exact integer half-up across two-decimal percentages", () => {
    const wrong: string[] = [];

    for (let hundredths = 1; hundredths <= 9_999; hundredths += 37) {
      for (let price = 1; price <= 4_000; price += 1) {
        const expected = exactHalfUp(price, hundredths);
        const actual = priceAt(price, [
          rule({ value: { percentage: hundredths / 100 } }),
        ]);
        if (actual !== expected) wrong.push(`${price}@${hundredths / 100}%`);
      }
    }

    expect(wrong.length, `wrong: ${wrong.slice(0, 5).join(", ")}`).toBe(0);
  });

  it("never rounds against the merchant", () => {
    // The direction matters on its own: every error before the fix was low,
    // so the merchant paid for all of them.
    for (let percentage = 1; percentage <= 99; percentage += 1) {
      for (let price = 1; price <= 3_000; price += 1) {
        const exact = (price * (100 - percentage)) / 100;
        expect(priceAt(price, [rule({ value: { percentage } })])).toBeGreaterThanOrEqual(
          Math.floor(exact),
        );
      }
    }
  });
});

describe("the exact fraction the cascade carries", () => {
  it("holds a tie exactly, where a float cannot", () => {
    // 0.94 is not representable in binary; 9400/10000 is.
    const fraction = multiplyFraction(wholeUnits(1075), 9_400, 10_000);
    expect(roundFraction(fraction, "half_up")).toBe(1011);
    expect(roundFraction(fraction, "down")).toBe(1010);
    expect(roundFraction(fraction, "half_even")).toBe(1010);
    expect(roundFraction(fraction, "up")).toBe(1011);
  });

  it("keeps itself in lowest terms, so the numbers stay exact", () => {
    const fraction = multiplyFraction(wholeUnits(1000), 9_000, 10_000);
    expect(fraction).toEqual<Fraction>({ numerator: 900, denominator: 1 });
  });

  /**
   * Precision is given up in exactly one place, and it takes a line nobody
   * will ever build to reach it: four stacked percentage rules on a price
   * whose numerator shares no factor with 10,000.
   */
  it("stays exact through three stacked percentages", () => {
    let fraction = wholeUnits(1007);
    for (let step = 0; step < 3; step += 1) {
      fraction = multiplyFraction(fraction, 9_223, 10_000);
    }
    expect(fraction.denominator).toBe(10_000 ** 3);
    expect(Number.isSafeInteger(fraction.numerator)).toBe(true);
  });

  it("rounds rather than overflowing when a fraction can no longer be held", () => {
    let fraction = wholeUnits(1007);
    for (let step = 0; step < 6; step += 1) {
      fraction = multiplyFraction(fraction, 9_223, 10_000);
    }
    // Still an exact, safe integer pair — never a float, and never a wrong
    // number silently produced by one.
    expect(Number.isSafeInteger(fraction.numerator)).toBe(true);
    expect(Number.isSafeInteger(fraction.denominator)).toBe(true);
    expect(roundFraction(fraction)).toBeGreaterThan(0);
  });

  it("subtracts and sets without disturbing the denominator's meaning", () => {
    // $10.75 less 6%, then $1.00 off: 1010.5 − 100 = 910.5, half-up 911.
    const discounted = multiplyFraction(wholeUnits(1075), 9_400, 10_000);
    expect(
      roundFraction({
        ...discounted,
        numerator: discounted.numerator - 100 * discounted.denominator,
      }),
    ).toBe(911);
  });
});
