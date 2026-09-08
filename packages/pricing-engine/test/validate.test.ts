import { describe, expect, it } from "vitest";

import { marginFor, money, parseMoney, resolvePrice, validateRule } from "../src/index";
import type { PricingContext, PricingRule } from "../src/index";

const baseRule: PricingRule = {
  id: "r1",
  name: "Wholesale 20%",
  status: "active",
  priority: 100,
  combinable: false,
  kind: "percentage",
  value: { percentage: 20 },
  targets: { mode: "all" },
  audience: { mode: "tags", tags: ["wholesale"] },
  markets: { mode: "all", marketIds: [] },
  schedule: { startsAt: null, endsAt: null },
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

const codes = (rule: PricingRule) => validateRule(rule).map((issue) => issue.code);

describe("rule validation", () => {
  it("passes a well-formed rule", () => {
    expect(validateRule(baseRule)).toEqual([]);
  });

  it("requires a name — the exact pattern the builder shows", () => {
    expect(codes({ ...baseRule, name: "   " })).toContain("name_required");
  });

  it("keeps a discount inside 0–100%", () => {
    expect(codes({ ...baseRule, value: { percentage: 120 } })).toContain(
      "percentage_out_of_range",
    );
    expect(codes({ ...baseRule, value: { percentage: -5 } })).toContain(
      "percentage_out_of_range",
    );
    expect(codes({ ...baseRule, value: { percentage: 0 } })).toEqual([]);
    expect(codes({ ...baseRule, value: { percentage: 100 } })).toEqual([]);
  });

  it("requires an end date after the start", () => {
    const start = new Date("2026-06-05T00:00:00Z");
    expect(
      codes({
        ...baseRule,
        schedule: { startsAt: start, endsAt: new Date("2026-06-01T00:00:00Z") },
      }),
    ).toContain("end_before_start");

    expect(
      codes({ ...baseRule, schedule: { startsAt: start, endsAt: start } }),
    ).toContain("end_before_start");
  });

  it("requires at least one target and one audience", () => {
    expect(
      codes({ ...baseRule, targets: { mode: "products", productIds: [] } }),
    ).toContain("no_targets");
    expect(codes({ ...baseRule, audience: { mode: "tags", tags: [] } })).toContain(
      "no_audience",
    );
  });

  /** The example the checklist gives by name: "10–49 overlaps 40–60". */
  it("catches overlapping tiers and names both ranges", () => {
    const issues = validateRule({
      ...baseRule,
      kind: "volume_tier",
      value: {
        tiers: [
          { minQuantity: 10, maxQuantity: 49, kind: "percentage", percentage: 5 },
          { minQuantity: 40, maxQuantity: 60, kind: "percentage", percentage: 12 },
        ],
      },
    });

    const overlap = issues.find((issue) => issue.code === "tier_overlap");
    expect(overlap).toBeDefined();
    expect(overlap!.params).toEqual({ first: "10–49", second: "40–60" });
  });

  it("treats an open-ended tier as overlapping anything above it", () => {
    expect(
      codes({
        ...baseRule,
        kind: "volume_tier",
        value: {
          tiers: [
            { minQuantity: 10, maxQuantity: null, kind: "percentage", percentage: 5 },
            { minQuantity: 50, maxQuantity: null, kind: "percentage", percentage: 12 },
          ],
        },
      }),
    ).toContain("tier_overlap");
  });

  it("accepts tiers that meet without overlapping", () => {
    expect(
      validateRule({
        ...baseRule,
        kind: "volume_tier",
        value: {
          tiers: [
            { minQuantity: 5, maxQuantity: 19, kind: "percentage", percentage: 5 },
            { minQuantity: 20, maxQuantity: null, kind: "percentage", percentage: 12 },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("rejects a tier whose minimum is above its maximum", () => {
    expect(
      codes({
        ...baseRule,
        kind: "volume_tier",
        value: {
          tiers: [
            { minQuantity: 50, maxQuantity: 10, kind: "percentage", percentage: 5 },
          ],
        },
      }),
    ).toContain("tier_min_above_max");
  });

  it("rejects a tier set with no tiers and a nonsense quantity", () => {
    expect(codes({ ...baseRule, kind: "volume_tier", value: { tiers: [] } })).toContain(
      "no_tiers",
    );
    expect(
      codes({
        ...baseRule,
        kind: "volume_tier",
        value: {
          tiers: [{ minQuantity: 0, maxQuantity: 10, kind: "percentage", percentage: 5 }],
        },
      }),
    ).toContain("tier_quantity_invalid");
  });

  it("rejects a negative absolute amount", () => {
    expect(
      codes({
        ...baseRule,
        kind: "amount_off",
        value: { base: money(-500, "USD"), overrides: {} },
      }),
    ).toContain("amount_negative");
  });

  it("points at the field so the builder can focus it", () => {
    const issues = validateRule({ ...baseRule, name: "", value: { percentage: 150 } });
    expect(issues.map((issue) => issue.field).sort()).toEqual([
      "name",
      "value.percentage",
    ]);
  });
});

describe("margin", () => {
  const context: PricingContext = {
    customer: { id: "c1", tags: ["wholesale"], groupIds: [], companyId: null },
    product: {
      productId: "p1",
      variantId: "v1",
      collectionIds: [],
      price: parseMoney("10.00", "USD"),
      cost: parseMoney("4.00", "USD"),
    },
    quantity: 1,
    market: { marketId: "m1", countryCode: "US", currencyCode: "USD" },
    cartSubtotal: null,
    now: new Date("2026-06-15T12:00:00Z"),
  };

  it("reports what a resolved price leaves after cost", () => {
    const result = resolvePrice({ rules: [baseRule], context });
    const margin = marginFor(result, context.product.cost!);

    expect(margin.margin.amount).toBe(400); // 8.00 − 4.00
    expect(margin.marginRatio).toBeCloseTo(0.5, 5);
    expect(margin.belowCost).toBe(false);
  });

  /** What the margin guard warns on before a rule is saved. */
  it("flags a rule that sells below cost", () => {
    const steep: PricingRule = { ...baseRule, id: "r2", value: { percentage: 80 } };
    const result = resolvePrice({ rules: [steep], context });
    const margin = marginFor(result, context.product.cost!);

    expect(margin.unitPrice.amount).toBe(200);
    expect(margin.belowCost).toBe(true);
    expect(margin.margin.amount).toBe(-200);
  });

  it("does not divide by zero on a free item", () => {
    const free: PricingRule = { ...baseRule, id: "r3", value: { percentage: 100 } };
    const result = resolvePrice({ rules: [free], context });
    expect(marginFor(result, context.product.cost!).marginRatio).toBeNull();
  });
});
