import { describe, expect, it } from "vitest";

import {
  checkpointQuantities,
  guardMargins,
  money,
  representativeCustomer,
  representativeMarket,
  type MarginCandidate,
  type PricingRule,
} from "../src/index";

/**
 * The margin guard, which is the only thing standing between a drafted rule
 * and a merchant selling at a loss without knowing it. Every test here is a
 * way that guard could quietly answer "all clear" when it should not.
 */

const NOW = new Date("2026-09-10T12:00:00Z");
const USD = (amount: number) => money(amount, "USD");

const base: PricingRule = {
  id: "rule-1",
  name: "Wholesale tiers",
  status: "active",
  priority: 100,
  combinable: false,
  targets: { mode: "all" },
  audience: { mode: "all" },
  markets: { mode: "all", marketIds: [] },
  schedule: { startsAt: null, endsAt: null },
  createdAt: NOW,
  kind: "percentage",
  value: { percentage: 20 },
};

const candidate = (overrides: Partial<MarginCandidate> = {}): MarginCandidate => ({
  variantId: "gid://shopify/ProductVariant/1",
  productId: "gid://shopify/Product/1",
  sku: "SKU-123",
  title: "Oak table",
  collectionIds: [],
  price: USD(10_000),
  cost: USD(6_000),
  ...overrides,
});

describe("checkpointQuantities", () => {
  it("prices one unit for a rule with no tiers", () => {
    expect(checkpointQuantities(base)).toEqual([1]);
  });

  it("prices every break of a volume rule, sorted and de-duplicated", () => {
    const rule: PricingRule = {
      ...base,
      kind: "volume_tier",
      value: {
        tiers: [
          { minQuantity: 50, maxQuantity: null, kind: "percentage", percentage: 40 },
          { minQuantity: 10, maxQuantity: 49, kind: "percentage", percentage: 20 },
          { minQuantity: 1, maxQuantity: 9, kind: "percentage", percentage: 5 },
        ],
      },
    };

    expect(checkpointQuantities(rule)).toEqual([1, 10, 50]);
  });
});

describe("representative buyer and market", () => {
  it("is nobody for a guests-only rule", () => {
    expect(representativeCustomer({ ...base, audience: { mode: "guests" } })).toBeNull();
  });

  it("carries the tags the rule asks for", () => {
    const customer = representativeCustomer({
      ...base,
      audience: { mode: "tags", tags: ["wholesale"] },
    });
    expect(customer?.tags).toEqual(["wholesale"]);
  });

  it("uses a market the rule includes", () => {
    const market = representativeMarket(
      { ...base, markets: { mode: "include", marketIds: ["gid://shopify/Market/7"] } },
      "USD",
    );
    expect(market.marketId).toBe("gid://shopify/Market/7");
  });

  it("stays outside a market the rule excludes", () => {
    const market = representativeMarket(
      { ...base, markets: { mode: "exclude", marketIds: ["gid://shopify/Market/7"] } },
      "USD",
    );
    expect(market.marketId).not.toBe("gid://shopify/Market/7");
  });
});

describe("guardMargins", () => {
  it("finds a price under cost and says how far under", () => {
    const report = guardMargins({ ...base, value: { percentage: 50 } }, [candidate()], {
      currencyCode: "USD",
      now: NOW,
    });

    expect(report.checked).toBe(1);
    expect(report.belowCost).toHaveLength(1);
    expect(report.belowCost[0]).toMatchObject({
      sku: "SKU-123",
      quantity: 1,
      unitPrice: USD(5_000),
      unitCost: USD(6_000),
      shortfall: USD(1_000),
    });
  });

  it("passes a rule that leaves a margin", () => {
    const report = guardMargins(base, [candidate()], { currencyCode: "USD", now: NOW });
    expect(report.belowCost).toEqual([]);
    expect(report.checked).toBe(1);
  });

  it("checks a draft, which is the only kind it is ever given", () => {
    const report = guardMargins(
      { ...base, status: "draft", value: { percentage: 50 } },
      [candidate()],
      { currencyCode: "USD", now: NOW },
    );

    // A draft evaluated as-is comes back "not_active" for every variant, which
    // reads as a clean bill of health. That is the bug this asserts against.
    expect(report.belowCost).toHaveLength(1);
  });

  it("checks a rule that has not started yet", () => {
    const report = guardMargins(
      {
        ...base,
        value: { percentage: 50 },
        schedule: { startsAt: new Date("2027-01-01T00:00:00Z"), endsAt: null },
      },
      [candidate()],
      { currencyCode: "USD", now: NOW },
    );

    expect(report.belowCost).toHaveLength(1);
  });

  it("checks a rule whose audience nobody in the sample matches", () => {
    const report = guardMargins(
      {
        ...base,
        value: { percentage: 50 },
        audience: { mode: "tags", tags: ["wholesale"] },
      },
      [candidate()],
      { currencyCode: "USD", now: NOW },
    );

    expect(report.belowCost).toHaveLength(1);
  });

  it("names the tier that goes under, not the first quantity", () => {
    const rule: PricingRule = {
      ...base,
      kind: "volume_tier",
      value: {
        tiers: [
          { minQuantity: 1, maxQuantity: 49, kind: "percentage", percentage: 10 },
          { minQuantity: 50, maxQuantity: null, kind: "percentage", percentage: 60 },
        ],
      },
    };

    const report = guardMargins(rule, [candidate()], { currencyCode: "USD", now: NOW });

    expect(report.belowCost).toHaveLength(1);
    expect(report.belowCost[0]?.quantity).toBe(50);
    expect(report.belowCost[0]?.unitPrice).toEqual(USD(4_000));
  });

  it("reports one row per variant, at its worst quantity", () => {
    const rule: PricingRule = {
      ...base,
      kind: "volume_tier",
      value: {
        tiers: [
          { minQuantity: 10, maxQuantity: 49, kind: "percentage", percentage: 50 },
          { minQuantity: 50, maxQuantity: null, kind: "percentage", percentage: 80 },
        ],
      },
    };

    const report = guardMargins(rule, [candidate()], { currencyCode: "USD", now: NOW });

    expect(report.belowCost).toHaveLength(1);
    expect(report.belowCost[0]?.quantity).toBe(50);
    expect(report.belowCost[0]?.shortfall).toEqual(USD(4_000));
  });

  it("sorts the worst loss first", () => {
    const report = guardMargins(
      { ...base, value: { percentage: 50 } },
      [
        candidate({ variantId: "v1", sku: "SMALL", cost: USD(5_100) }),
        candidate({ variantId: "v2", sku: "BIG", cost: USD(9_000) }),
      ],
      { currencyCode: "USD", now: NOW },
    );

    expect(report.belowCost.map((one) => one.sku)).toEqual(["BIG", "SMALL"]);
  });

  it("counts a variant with no recorded cost rather than passing it", () => {
    const report = guardMargins(
      { ...base, value: { percentage: 90 } },
      [candidate({ cost: null })],
      { currencyCode: "USD", now: NOW },
    );

    expect(report.checked).toBe(1);
    expect(report.costUnknown).toBe(1);
    expect(report.belowCost).toEqual([]);
  });

  it("does not check a variant the rule excludes", () => {
    const rule: PricingRule = {
      ...base,
      value: { percentage: 90 },
      targets: { mode: "all", excludeCollectionIds: ["gid://shopify/Collection/sale"] },
    };

    const report = guardMargins(
      rule,
      [candidate({ collectionIds: ["gid://shopify/Collection/sale"] })],
      { currencyCode: "USD", now: NOW },
    );

    expect(report.checked).toBe(0);
    expect(report.notApplicable).toBe(1);
    expect(report.belowCost).toEqual([]);
  });

  it("refuses a variant priced in another currency instead of comparing it", () => {
    const report = guardMargins(
      { ...base, value: { percentage: 90 } },
      [candidate({ price: money(10_000, "EUR"), cost: money(6_000, "EUR") })],
      { currencyCode: "USD", now: NOW },
    );

    expect(report.checked).toBe(0);
    expect(report.notApplicable).toBe(1);
  });

  it("says nothing about an empty catalogue rather than passing it", () => {
    const report = guardMargins(base, [], { currencyCode: "USD", now: NOW });
    expect(report).toEqual({
      checked: 0,
      costUnknown: 0,
      notApplicable: 0,
      belowCost: [],
    });
  });

  it("leaves the rule it was given untouched", () => {
    const rule: PricingRule = { ...base, status: "draft" };
    guardMargins(rule, [candidate()], { currencyCode: "USD", now: NOW });
    expect(rule.status).toBe("draft");
  });
});
