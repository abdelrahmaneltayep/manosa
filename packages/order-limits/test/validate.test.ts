import { parseMoney } from "@mannon/pricing-engine";
import { describe, expect, it } from "vitest";

import type { OrderLimit } from "../src/types";
import { validateLimit } from "../src/validate";

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

const codes = (overrides: Partial<OrderLimit>) =>
  validateLimit(limit(overrides)).map((issue) => issue.code);

describe("validating a limit before it is saved", () => {
  it("accepts a limit with a single bound", () => {
    expect(codes({ minSubtotal: usd("200.00") })).toEqual([]);
    expect(codes({ quantityIncrement: 6 })).toEqual([]);
  });

  it("refuses a limit that constrains nothing", () => {
    // A row on a screen headed "Order limits" that limits nothing is a
    // merchant believing they set something they did not.
    expect(codes({})).toEqual(["no_bounds"]);
  });

  it("blocks a minimum above its maximum", () => {
    // Such a limit blocks every order, and the merchant finds out from a buyer
    // who cannot check out.
    expect(codes({ minSubtotal: usd("500.00"), maxSubtotal: usd("100.00") })).toContain(
      "min_above_max_subtotal",
    );
    expect(codes({ minQuantity: 50, maxQuantity: 10 })).toContain(
      "min_above_max_quantity",
    );
  });

  it("allows a minimum equal to its maximum", () => {
    expect(codes({ minQuantity: 10, maxQuantity: 10 })).toEqual([]);
  });

  it("refuses negative bounds", () => {
    expect(codes({ minQuantity: -1 })).toContain("negative");
    expect(codes({ minSubtotal: { amount: -100, currencyCode: "USD" } })).toContain(
      "negative",
    );
  });

  it("refuses an increment of one, which constrains nothing", () => {
    expect(codes({ quantityIncrement: 1 })).toContain("increment_too_small");
  });

  it("flags a minimum that is not a whole number of cases", () => {
    // A minimum of 10 with cases of 4 means the smallest allowed order is 12,
    // which is not what the merchant typed.
    const issues = validateLimit(limit({ minQuantity: 10, quantityIncrement: 4 }));
    const conflict = issues.find(
      (issue) => issue.code === "increment_conflicts_with_minimum",
    );
    expect(conflict?.detail).toBe("12");
  });

  it("is happy when the minimum is a whole number of cases", () => {
    expect(codes({ minQuantity: 12, quantityIncrement: 4 })).toEqual([]);
  });

  it("flags a maximum smaller than one case", () => {
    // Every order would be impossible.
    expect(codes({ maxQuantity: 3, quantityIncrement: 6 })).toContain(
      "increment_conflicts_with_maximum",
    );
  });

  it("does not compare money across currencies", () => {
    expect(
      codes({
        minSubtotal: usd("500.00"),
        maxSubtotal: parseMoney("100.00", "EUR"),
      }),
    ).not.toContain("min_above_max_subtotal");
  });
});
