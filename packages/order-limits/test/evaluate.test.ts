import { parseMoney } from "@mannon/pricing-engine";
import { describe, expect, it } from "vitest";

import { evaluateLimits, limitFor } from "../src/evaluate";
import type { CartFacts, OrderLimit } from "../src/types";

const usd = (value: string) => parseMoney(value, "USD");

const limit = (overrides: Partial<OrderLimit> = {}): OrderLimit => ({
  id: "l1",
  enabled: true,
  groupId: null,
  minSubtotal: null,
  maxSubtotal: null,
  minQuantity: null,
  maxQuantity: null,
  quantityIncrement: null,
  countries: [],
  ...overrides,
});

const cart = (overrides: Partial<CartFacts> = {}): CartFacts => ({
  subtotal: usd("250.00"),
  totalQuantity: 10,
  groupIds: [],
  tags: ["wholesale"],
  countryCode: "SA",
  isPos: false,
  isAuthenticated: true,
  ...overrides,
});

describe("who a limit applies to", () => {
  it("never applies to a guest", () => {
    // A guest has no tier and no terms. Telling them they are $38 short of a
    // minimum they were never subject to is nonsense.
    const verdict = evaluateLimits(
      [limit({ minSubtotal: usd("200.00") })],
      cart({ isAuthenticated: false, subtotal: usd("10.00") }),
    );
    expect(verdict).toEqual({ violations: [], applied: null, skipped: "guest" });
  });

  it("is bypassed at the till by default", () => {
    // A minimum written for a website is not a rule about a shop counter.
    const verdict = evaluateLimits(
      [limit({ minSubtotal: usd("200.00") })],
      cart({ isPos: true, subtotal: usd("10.00") }),
    );
    expect(verdict.skipped).toBe("pos_bypass");
  });

  it("applies at the till when the merchant turns the bypass off", () => {
    const verdict = evaluateLimits(
      [limit({ minSubtotal: usd("200.00") })],
      cart({ isPos: true, subtotal: usd("10.00") }),
      { posBypasses: false },
    );
    expect(verdict.violations).toHaveLength(1);
  });

  it("prefers the buyer's own tier over the store-wide limit", () => {
    // A cart that had to satisfy several limits at once would ask the merchant
    // to reason about "add $38" and "remove 4 items" together.
    const store = limit({ id: "store", minSubtotal: usd("500.00") });
    const gold = limit({ id: "gold", groupId: "g1", minSubtotal: usd("100.00") });

    const verdict = evaluateLimits([store, gold], cart({ groupIds: ["g1"] }));
    expect(verdict.applied?.id).toBe("gold");
    expect(verdict.violations).toEqual([]);
  });

  it("falls back to the store-wide limit for a buyer in no covered tier", () => {
    const store = limit({ id: "store", minSubtotal: usd("500.00") });
    const gold = limit({ id: "gold", groupId: "g1", minSubtotal: usd("100.00") });

    expect(limitFor([store, gold], cart({ groupIds: ["g9"] }))?.id).toBe("store");
  });

  it("ignores a limit that is switched off", () => {
    const verdict = evaluateLimits(
      [limit({ enabled: false, minSubtotal: usd("500.00") })],
      cart(),
    );
    expect(verdict.applied).toBeNull();
    expect(verdict.skipped).toBe("disabled");
  });

  it("applies a country-scoped limit only in that country", () => {
    const ksa = limit({ countries: ["SA"], minSubtotal: usd("500.00") });

    expect(evaluateLimits([ksa], cart({ countryCode: "SA" })).violations).toHaveLength(1);
    expect(evaluateLimits([ksa], cart({ countryCode: "AE" })).skipped).toBe(
      "wrong_country",
    );
  });

  it("does not apply a country-scoped limit when the country is unknown", () => {
    // A limit is a restriction. Applying one we are not sure about blocks a
    // real order, so the unknown case fails open.
    const ksa = limit({ countries: ["SA"], minSubtotal: usd("500.00") });
    expect(evaluateLimits([ksa], cart({ countryCode: null })).skipped).toBe(
      "wrong_country",
    );
  });

  it("says so when there is no limit at all", () => {
    expect(evaluateLimits([], cart()).skipped).toBe("no_limit_for_this_buyer");
  });
});

describe("subtotal bounds", () => {
  it("reports the gap to the minimum", () => {
    const verdict = evaluateLimits(
      [limit({ minSubtotal: usd("200.00") })],
      cart({ subtotal: usd("162.00") }),
    );

    expect(verdict.violations).toHaveLength(1);
    // The checklist's example: "Add $38 to reach your $200 minimum."
    expect(verdict.violations[0]).toMatchObject({
      code: "below_minimum_subtotal",
      gap: usd("38.00"),
      required: usd("200.00"),
      actual: usd("162.00"),
    });
  });

  it("lets a cart exactly on the minimum through", () => {
    expect(
      evaluateLimits(
        [limit({ minSubtotal: usd("200.00") })],
        cart({ subtotal: usd("200.00") }),
      ).violations,
    ).toEqual([]);
  });

  it("reports the overshoot on a maximum", () => {
    const verdict = evaluateLimits(
      [limit({ maxSubtotal: usd("500.00") })],
      cart({ subtotal: usd("540.50") }),
    );
    expect(verdict.violations[0]).toMatchObject({
      code: "above_maximum_subtotal",
      gap: usd("40.50"),
    });
  });

  it("never compares across currencies", () => {
    // A limit written in USD says nothing about a cart priced in EUR, and
    // guessing would block a real order on a rate we invented.
    const verdict = evaluateLimits(
      [limit({ minSubtotal: usd("200.00") })],
      cart({ subtotal: parseMoney("10.00", "EUR") }),
    );
    expect(verdict.violations).toEqual([]);
  });
});

describe("quantity bounds", () => {
  it("reports how many more are needed", () => {
    const verdict = evaluateLimits(
      [limit({ minQuantity: 24 })],
      cart({ totalQuantity: 18 }),
    );
    expect(verdict.violations[0]).toMatchObject({
      code: "below_minimum_quantity",
      gap: 6,
      required: 24,
    });
  });

  it("reports how many to remove", () => {
    const verdict = evaluateLimits(
      [limit({ maxQuantity: 100 })],
      cart({ totalQuantity: 104 }),
    );
    expect(verdict.violations[0]).toMatchObject({
      code: "above_maximum_quantity",
      gap: 4,
    });
  });

  it("reports both bounds at once when both are broken", () => {
    const verdict = evaluateLimits(
      [limit({ minSubtotal: usd("200.00"), minQuantity: 24 })],
      cart({ subtotal: usd("100.00"), totalQuantity: 4 }),
    );
    expect(verdict.violations.map((violation) => violation.code)).toEqual([
      "below_minimum_subtotal",
      "below_minimum_quantity",
    ]);
  });
});

describe("case packs", () => {
  it("accepts a multiple", () => {
    expect(
      evaluateLimits([limit({ quantityIncrement: 6 })], cart({ totalQuantity: 24 }))
        .violations,
    ).toEqual([]);
  });

  it("asks the buyer to add up to the next case, never to remove", () => {
    // Telling somebody to buy less to satisfy a case pack is not what a case
    // pack is for.
    const verdict = evaluateLimits(
      [limit({ quantityIncrement: 6 })],
      cart({ totalQuantity: 20 }),
    );
    expect(verdict.violations[0]).toMatchObject({
      code: "not_a_multiple",
      required: 6,
      actual: 20,
      gap: 4,
    });
  });

  it("does not complain about an empty cart", () => {
    expect(
      evaluateLimits([limit({ quantityIncrement: 6 })], cart({ totalQuantity: 0 }))
        .violations,
    ).toEqual([]);
  });

  it("treats an increment of one as no increment at all", () => {
    expect(
      evaluateLimits([limit({ quantityIncrement: 1 })], cart({ totalQuantity: 7 }))
        .violations,
    ).toEqual([]);
  });
});

describe("determinism", () => {
  it("gives the same verdict twice, and mutates nothing", () => {
    const limits = [limit({ minSubtotal: usd("200.00"), quantityIncrement: 6 })];
    const facts = cart({ subtotal: usd("100.00"), totalQuantity: 20 });
    const snapshot = JSON.stringify({ limits, facts });

    const first = evaluateLimits(limits, facts);
    const second = evaluateLimits(limits, facts);

    expect(first).toEqual(second);
    expect(JSON.stringify({ limits, facts })).toBe(snapshot);
  });
});
