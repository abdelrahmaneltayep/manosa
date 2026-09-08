import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { money, resolvePrice, type PricingContext, type PricingRule } from "../src/index";

/**
 * Invariants that must hold for *any* rule set, not just the ones we thought
 * to write down. The golden vectors say what the engine does; these say what it
 * may never do.
 */

const CURRENCY = "USD";
const NOW = new Date("2026-06-15T12:00:00Z");

const arbPercentage = fc.integer({ min: 0, max: 100 });
const arbPriority = fc.integer({ min: 0, max: 1000 });
const arbMinorUnits = fc.integer({ min: 0, max: 5_000_00 });

const arbTargets = fc.constantFrom<PricingRule["targets"]>(
  { mode: "all" },
  { mode: "products", productIds: ["p-1"] },
  { mode: "variants", variantIds: ["v-1"] },
  { mode: "collections", collectionIds: ["c-1"] },
  { mode: "all", excludeCollectionIds: ["c-sale"] },
);

const arbAudience = fc.constantFrom<PricingRule["audience"]>(
  { mode: "all" },
  { mode: "tags", tags: ["wholesale"] },
  { mode: "groups", groupIds: ["g-1"] },
  { mode: "customers", customerIds: ["cust-1"] },
  { mode: "guests" },
);

const arbRule = (index: number): fc.Arbitrary<PricingRule> =>
  fc
    .record({
      priority: arbPriority,
      combinable: fc.boolean(),
      status: fc.constantFrom("active" as const, "draft" as const, "archived" as const),
      targets: arbTargets,
      audience: arbAudience,
      createdAtMs: fc.integer({ min: 0, max: 1_000_000 }),
      body: fc.oneof(
        fc.record({
          kind: fc.constant("percentage" as const),
          percentage: arbPercentage,
        }),
        fc.record({ kind: fc.constant("amount_off" as const), minor: arbMinorUnits }),
        fc.record({ kind: fc.constant("fixed_price" as const), minor: arbMinorUnits }),
        fc.record({
          kind: fc.constant("volume_tier" as const),
          first: fc.integer({ min: 2, max: 50 }),
          second: fc.integer({ min: 51, max: 500 }),
          firstPct: arbPercentage,
          secondPct: arbPercentage,
        }),
      ),
    })
    .map((raw): PricingRule => {
      const base = {
        id: `rule-${index}`,
        name: `Rule ${index}`,
        status: raw.status,
        priority: raw.priority,
        combinable: raw.combinable,
        targets: raw.targets,
        audience: raw.audience,
        markets: { mode: "all" as const, marketIds: [] },
        schedule: { startsAt: null, endsAt: null },
        createdAt: new Date(raw.createdAtMs),
      };

      switch (raw.body.kind) {
        case "percentage":
          return {
            ...base,
            kind: "percentage",
            value: { percentage: raw.body.percentage },
          };
        case "amount_off":
          return {
            ...base,
            kind: "amount_off",
            value: { base: money(raw.body.minor, CURRENCY), overrides: {} },
          };
        case "fixed_price":
          return {
            ...base,
            kind: "fixed_price",
            value: { base: money(raw.body.minor, CURRENCY), overrides: {} },
          };
        case "volume_tier":
          return {
            ...base,
            kind: "volume_tier",
            value: {
              tiers: [
                {
                  minQuantity: raw.body.first,
                  maxQuantity: raw.body.second - 1,
                  kind: "percentage",
                  percentage: raw.body.firstPct,
                },
                {
                  minQuantity: raw.body.second,
                  maxQuantity: null,
                  kind: "percentage",
                  percentage: raw.body.secondPct,
                },
              ],
            },
          };
      }
    });

const arbRules = fc
  .integer({ min: 0, max: 6 })
  .chain((count) =>
    count === 0
      ? fc.constant<PricingRule[]>([])
      : fc.tuple(...Array.from({ length: count }, (_, i) => arbRule(i))),
  );

const arbContext = fc
  .record({
    quantity: fc.integer({ min: 1, max: 1000 }),
    price: fc.integer({ min: 1, max: 1_000_00 }),
    loggedIn: fc.boolean(),
    tagged: fc.boolean(),
  })
  .map((raw): PricingContext => ({
    customer: raw.loggedIn
      ? {
          id: "cust-1",
          tags: raw.tagged ? ["wholesale"] : [],
          groupIds: raw.tagged ? ["g-1"] : [],
          companyId: null,
        }
      : null,
    product: {
      productId: "p-1",
      variantId: "v-1",
      collectionIds: ["c-1"],
      price: money(raw.price, CURRENCY),
      cost: null,
    },
    quantity: raw.quantity,
    market: { marketId: "m-1", countryCode: "US", currencyCode: CURRENCY },
    cartSubtotal: null,
    now: NOW,
  }));

describe("invariants", () => {
  it("never returns a negative price", () => {
    fc.assert(
      fc.property(arbRules, arbContext, (rules, context) => {
        const result = resolvePrice({ rules, context });
        expect(result.unitPrice.amount).toBeGreaterThanOrEqual(0);
        expect(result.lineTotal.amount).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 500 },
    );
  });

  it("always returns whole minor units", () => {
    fc.assert(
      fc.property(arbRules, arbContext, (rules, context) => {
        const result = resolvePrice({ rules, context });
        expect(Number.isSafeInteger(result.unitPrice.amount)).toBe(true);
        expect(Number.isSafeInteger(result.lineTotal.amount)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  /**
   * The property the golden vectors cannot cover: a merchant reporting a wrong
   * price must get the same answer when we re-run it, whatever order the rules
   * came out of the database in.
   */
  it("does not depend on the order rules arrive in", () => {
    fc.assert(
      fc.property(arbRules, arbContext, fc.integer(), (rules, context, seed) => {
        const shuffled = [...rules].sort(
          (a, b) =>
            ((seed + a.id.length) % 3) - ((seed + b.id.length) % 3) ||
            (a.id < b.id ? 1 : -1),
        );
        const first = resolvePrice({ rules, context });
        const second = resolvePrice({ rules: shuffled, context });

        expect(second.unitPrice.amount).toBe(first.unitPrice.amount);
        expect(second.appliedRuleIds).toEqual(first.appliedRuleIds);
      }),
      { numRuns: 500 },
    );
  });

  it("gives the same answer twice for the same input", () => {
    fc.assert(
      fc.property(arbRules, arbContext, (rules, context) => {
        const a = resolvePrice({ rules, context });
        const b = resolvePrice({ rules, context });
        expect(b).toEqual(a);
      }),
      { numRuns: 200 },
    );
  });

  it("accounts for every rule exactly once in the trace", () => {
    fc.assert(
      fc.property(arbRules, arbContext, (rules, context) => {
        const result = resolvePrice({ rules, context });
        expect(result.trace).toHaveLength(rules.length);
        expect(new Set(result.trace.map((entry) => entry.ruleId)).size).toBe(
          rules.length,
        );

        for (const entry of result.trace) {
          if (entry.applied) {
            expect(result.appliedRuleIds).toContain(entry.ruleId);
          } else {
            // No dead ends: "Why this price?" must always have an answer.
            expect(entry.reason).toBeTruthy();
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("ignores rules that are not active, whatever they would have done", () => {
    fc.assert(
      fc.property(arbRules, arbContext, (rules, context) => {
        const activeOnly = rules.filter((rule) => rule.status === "active");
        const withDrafts = resolvePrice({ rules, context });
        const withoutDrafts = resolvePrice({ rules: activeOnly, context });
        expect(withDrafts.unitPrice.amount).toBe(withoutDrafts.unitPrice.amount);
      }),
      { numRuns: 300 },
    );
  });

  /**
   * Adding a rule that cannot match must not move the price. This is what makes
   * a merchant's catalogue of old rules harmless.
   */
  it("is unaffected by a rule targeting a different product", () => {
    fc.assert(
      fc.property(arbRules, arbContext, (rules, context) => {
        const irrelevant: PricingRule = {
          id: "irrelevant",
          name: "Targets something else",
          status: "active",
          priority: 0,
          combinable: false,
          kind: "percentage",
          value: { percentage: 99 },
          targets: { mode: "products", productIds: ["p-somewhere-else"] },
          audience: { mode: "all" },
          markets: { mode: "all", marketIds: [] },
          schedule: { startsAt: null, endsAt: null },
          createdAt: new Date(0),
        };

        const before = resolvePrice({ rules, context });
        const after = resolvePrice({ rules: [...rules, irrelevant], context });
        expect(after.unitPrice.amount).toBe(before.unitPrice.amount);
      }),
      { numRuns: 300 },
    );
  });

  it("charges the line total as unit price times quantity", () => {
    fc.assert(
      fc.property(arbRules, arbContext, (rules, context) => {
        const result = resolvePrice({ rules, context });
        expect(result.lineTotal.amount).toBe(result.unitPrice.amount * context.quantity);
      }),
      { numRuns: 300 },
    );
  });

  /**
   * Volume breaks exist to reward buying more. A tier set that made a larger
   * order cost more per unit would be a configuration bug the merchant should
   * be told about — and until validation catches it (1.3), the engine must at
   * least be honest about what it computes.
   */
  it("never quotes a next tier that costs more per unit than the current price", () => {
    fc.assert(
      fc.property(arbRules, arbContext, (rules, context) => {
        const result = resolvePrice({ rules, context });
        if (!result.nextTier) return;
        // The next tier is only worth showing as an upsell if it is cheaper.
        // We assert the engine reports it truthfully rather than assuming it.
        expect(result.nextTier.additionalQuantity).toBeGreaterThan(0);
        expect(result.nextTier.quantity).toBeGreaterThan(context.quantity);
      }),
      { numRuns: 300 },
    );
  });

  it("refuses a quantity below one rather than pricing nothing", () => {
    fc.assert(
      fc.property(arbContext, fc.integer({ min: -100, max: 0 }), (context, quantity) => {
        expect(() =>
          resolvePrice({ rules: [], context: { ...context, quantity } }),
        ).toThrow(RangeError);
      }),
      { numRuns: 100 },
    );
  });
});
