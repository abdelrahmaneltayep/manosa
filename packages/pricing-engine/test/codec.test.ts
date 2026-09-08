import { describe, expect, it } from "vitest";

import {
  deserializeRuleset,
  money,
  parseMoney,
  resolvePrice,
  RULESET_FORMAT_VERSION,
  serializeRuleset,
  type PricingContext,
  type PricingRule,
} from "../src/index";

const rules: PricingRule[] = [
  {
    id: "pct",
    name: "Wholesale 35%",
    status: "active",
    priority: 100,
    combinable: false,
    kind: "percentage",
    value: { percentage: 35 },
    targets: { mode: "all", excludeCollectionIds: ["c-sale"] },
    audience: { mode: "tags", tags: ["wholesale"] },
    markets: { mode: "all", marketIds: [] },
    schedule: { startsAt: new Date("2026-06-01T00:00:00Z"), endsAt: null },
    createdAt: new Date("2026-01-01T00:00:00Z"),
  },
  {
    id: "fixed",
    name: "Contract price",
    status: "active",
    priority: 10,
    combinable: false,
    kind: "fixed_price",
    value: {
      base: parseMoney("8.00", "USD"),
      overrides: { EUR: parseMoney("7.20", "EUR") },
    },
    targets: { mode: "variants", variantIds: ["v-1"] },
    audience: { mode: "customers", customerIds: ["c-1"] },
    markets: { mode: "include", marketIds: ["m-1"] },
    schedule: { startsAt: null, endsAt: new Date("2026-12-31T00:00:00Z") },
    createdAt: new Date("2026-02-01T00:00:00Z"),
  },
  {
    id: "tiers",
    name: "Volume breaks",
    status: "active",
    priority: 50,
    combinable: true,
    kind: "volume_tier",
    value: {
      tiers: [
        { minQuantity: 5, maxQuantity: 19, kind: "percentage", percentage: 5 },
        {
          minQuantity: 20,
          maxQuantity: null,
          kind: "fixed_price",
          amount: parseMoney("8.80", "USD"),
        },
      ],
    },
    targets: { mode: "collections", collectionIds: ["c-new"] },
    audience: { mode: "groups", groupIds: ["g-1"] },
    markets: { mode: "all", marketIds: [] },
    schedule: { startsAt: null, endsAt: null },
    createdAt: new Date("2026-03-01T00:00:00Z"),
  },
  {
    id: "cart",
    name: "Big cart",
    status: "draft",
    priority: 70,
    combinable: false,
    kind: "cart_value_tier",
    value: {
      tiers: [
        {
          minSubtotal: parseMoney("1000.00", "USD"),
          maxSubtotal: null,
          kind: "percentage",
          percentage: 8,
        },
      ],
    },
    targets: { mode: "all" },
    audience: { mode: "all" },
    markets: { mode: "exclude", marketIds: ["m-eu"] },
    schedule: { startsAt: null, endsAt: null },
    createdAt: new Date("2026-04-01T00:00:00Z"),
  },
];

/** Through JSON, the way a metafield actually stores it. */
function roundTrip(input: PricingRule[]) {
  return deserializeRuleset(JSON.parse(JSON.stringify(serializeRuleset(input))));
}

describe("ruleset codec", () => {
  it("survives a JSON round trip unchanged", () => {
    const result = roundTrip(rules);
    expect(result.errors).toEqual([]);
    expect(result.rules).toEqual(rules);
  });

  it("carries a format version", () => {
    expect(serializeRuleset([]).v).toBe(RULESET_FORMAT_VERSION);
  });

  it("accepts a JSON string as well as an object", () => {
    const asString = JSON.stringify(serializeRuleset(rules));
    expect(deserializeRuleset(asString).rules).toHaveLength(rules.length);
  });

  it("prices identically before and after the round trip", () => {
    const context: PricingContext = {
      customer: { id: "c-1", tags: ["wholesale"], groupIds: ["g-1"], companyId: null },
      product: {
        productId: "p-1",
        variantId: "v-1",
        collectionIds: ["c-new"],
        price: parseMoney("10.00", "USD"),
        cost: null,
      },
      quantity: 25,
      market: { marketId: "m-1", countryCode: "US", currencyCode: "USD" },
      cartSubtotal: null,
      now: new Date("2026-06-15T12:00:00Z"),
    };

    const direct = resolvePrice({ rules, context });
    const viaWire = resolvePrice({ rules: roundTrip(rules).rules, context });

    expect(viaWire.unitPrice).toEqual(direct.unitPrice);
    expect(viaWire.appliedRuleIds).toEqual(direct.appliedRuleIds);
  });
});

/**
 * A discount Function that throws applies no discounts at all — every wholesale
 * buyer in the store silently pays retail until someone notices. So parsing
 * never throws, and one bad rule costs that rule alone.
 */
describe("reading a damaged ruleset", () => {
  it("returns nothing for null or undefined rather than failing", () => {
    expect(deserializeRuleset(null)).toEqual({ rules: [], errors: [] });
    expect(deserializeRuleset(undefined)).toEqual({ rules: [], errors: [] });
  });

  it("reports invalid JSON instead of throwing", () => {
    const result = deserializeRuleset("{not json");
    expect(result.rules).toEqual([]);
    expect(result.errors[0]?.message).toMatch(/not valid JSON/);
  });

  it("refuses a format version it does not understand", () => {
    const result = deserializeRuleset({ v: 99, rules: [] });
    expect(result.rules).toEqual([]);
    expect(result.errors[0]?.message).toMatch(/not v1/);
  });

  it("drops one malformed rule and keeps the rest", () => {
    const wire = serializeRuleset(rules) as unknown as { rules: unknown[] };
    // Well-formed apart from the money, so the failure is the one this case is
    // about rather than a missing field earlier in the checks.
    wire.rules[1] = {
      id: "broken",
      name: "Broken",
      status: "active",
      priority: 1,
      combinable: false,
      kind: "fixed_price",
      value: { base: "eight dollars", overrides: {} },
      targets: { mode: "all" },
      audience: { mode: "all" },
      markets: { mode: "all", marketIds: [] },
      createdAt: "2026-01-01T00:00:00Z",
    };

    const result = deserializeRuleset(wire);
    expect(result.rules.map((rule) => rule.id)).toEqual(["pct", "tiers", "cart"]);
    expect(result.errors).toEqual([
      { ruleId: "broken", message: expect.stringContaining("money value") },
    ]);
  });

  it.each([
    ["no id", { name: "x", kind: "percentage", value: { percentage: 10 } }],
    ["unknown kind", { id: "x", name: "x", kind: "mystery", targets: {}, audience: {} }],
    [
      "bad date",
      {
        id: "x",
        name: "x",
        kind: "percentage",
        value: { percentage: 1 },
        targets: {},
        audience: {},
        createdAt: "not-a-date",
      },
    ],
    [
      "missing tiers",
      {
        id: "x",
        name: "x",
        kind: "volume_tier",
        value: {},
        targets: {},
        audience: {},
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  ])("survives a rule with %s", (_label, broken) => {
    const result = deserializeRuleset({ v: 1, rules: [broken] });
    expect(result.rules).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toBeTruthy();
  });

  it("survives a rules field that is not an array", () => {
    expect(deserializeRuleset({ v: 1, rules: "nope" }).errors[0]?.message).toMatch(
      /no rules array/,
    );
  });

  it("rejects a money value that is not a whole minor unit", () => {
    const result = deserializeRuleset({
      v: 1,
      rules: [
        {
          id: "x",
          name: "x",
          kind: "amount_off",
          priority: 1,
          combinable: false,
          status: "active",
          targets: { mode: "all" },
          audience: { mode: "all" },
          markets: { mode: "all", marketIds: [] },
          createdAt: "2026-01-01T00:00:00Z",
          value: { base: { amount: 2.5, currencyCode: "USD" }, overrides: {} },
        },
      ],
    });
    expect(result.rules).toEqual([]);
    expect(result.errors[0]!.message).toMatch(/money value/);
  });

  it("defaults a missing market scope to every market", () => {
    const result = deserializeRuleset({
      v: 1,
      rules: [
        {
          id: "x",
          name: "x",
          kind: "percentage",
          priority: 1,
          combinable: false,
          status: "active",
          targets: { mode: "all" },
          audience: { mode: "all" },
          createdAt: "2026-01-01T00:00:00Z",
          value: { percentage: 10 },
        },
      ],
    });
    expect(result.rules[0]!.markets).toEqual({ mode: "all", marketIds: [] });
  });

  it("keeps money exact through the wire", () => {
    // A single minor unit: the value most likely to be lost to a float.
    const oneCent: PricingRule = {
      id: "one-cent",
      name: "One cent off",
      status: "active",
      priority: 1,
      combinable: false,
      kind: "amount_off",
      value: { base: money(1, "USD"), overrides: {} },
      targets: { mode: "all" },
      audience: { mode: "all" },
      markets: { mode: "all", marketIds: [] },
      schedule: { startsAt: null, endsAt: null },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };

    const result = roundTrip([oneCent]);
    expect(result.rules[0]).toEqual(oneCent);
  });
});
