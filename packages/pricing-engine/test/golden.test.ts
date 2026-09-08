import { describe, expect, it } from "vitest";

import {
  formatMoney,
  parseMoney,
  resolvePrice,
  type CustomerContext,
  type Money,
  type PricingContext,
  type PricingRule,
  type ProductContext,
} from "../src/index";
import vectors from "./golden/vectors.json";

/**
 * Runs every golden vector. The vectors were written from the product spec
 * before the resolver existed; if one fails, the question is which of the two
 * is wrong, and the answer belongs in the pull request.
 */

type RawRule = Record<string, unknown>;
type RawCase = {
  name: string;
  spec: string;
  why: string;
  rules: string[];
  context: {
    customer: string | null;
    product: string;
    quantity: number;
    now?: string;
    cartSubtotal?: string;
    market?: { marketId: string; countryCode: string; currencyCode: string };
  };
  expect: {
    finalPrice: string;
    appliedRules?: string[];
    skipped?: Record<string, string>;
    nextTier?: { quantity: number; unitPrice: string } | null;
    clampedAtZero?: boolean;
  };
};

const DEFAULT_MARKET = { marketId: "m-default", countryCode: "US", currencyCode: "USD" };
const DEFAULT_NOW = "2026-06-15T12:00:00Z";

const raw = vectors as unknown as {
  rules: Record<string, RawRule>;
  products: Record<string, Record<string, unknown>>;
  customers: Record<string, Record<string, unknown>>;
  cases: RawCase[];
};

/** Vectors carry money as decimal strings so a human can review the file. */
function money(value: string, currencyCode: string): Money {
  return parseMoney(value, currencyCode);
}

function buildRule(rule: RawRule, currencyCode: string): PricingRule {
  // The vector format is the rule format, with money as strings. Convert only
  // the money-bearing leaves.
  const value = rule.value as Record<string, unknown>;
  const kind = rule.kind as string;

  let converted: unknown = value;

  if (kind === "fixed_price" || kind === "amount_off") {
    converted = {
      base: money(value.amount as string, value.currencyCode as string),
      overrides: Object.fromEntries(
        Object.entries((value.currencyOverrides ?? {}) as Record<string, string>).map(
          ([code, amount]) => [code, money(amount, code)],
        ),
      ),
    };
  } else if (kind === "volume_tier") {
    const tierCurrency = (value.currencyCode as string) ?? currencyCode;
    converted = {
      tiers: (value.tiers as Record<string, unknown>[]).map((tier) => ({
        minQuantity: tier.minQuantity as number,
        maxQuantity: (tier.maxQuantity as number | null) ?? null,
        ...(tier.kind === "fixed_price"
          ? {
              kind: "fixed_price" as const,
              amount: money(tier.amount as string, tierCurrency),
            }
          : tier.kind === "amount_off"
            ? {
                kind: "amount_off" as const,
                amount: money(tier.amount as string, tierCurrency),
              }
            : { kind: "percentage" as const, percentage: tier.percentage as number }),
      })),
    };
  } else if (kind === "cart_value_tier") {
    const tierCurrency = (value.currencyCode as string) ?? currencyCode;
    converted = {
      tiers: (value.tiers as Record<string, unknown>[]).map((tier) => ({
        minSubtotal: money(tier.minSubtotal as string, tierCurrency),
        maxSubtotal: tier.maxSubtotal
          ? money(tier.maxSubtotal as string, tierCurrency)
          : null,
        ...(tier.kind === "fixed_price"
          ? {
              kind: "fixed_price" as const,
              amount: money(tier.amount as string, tierCurrency),
            }
          : { kind: "percentage" as const, percentage: tier.percentage as number }),
      })),
    };
  }

  return {
    id: rule.id as string,
    name: rule.name as string,
    status: rule.status as PricingRule["status"],
    priority: rule.priority as number,
    combinable: rule.combinable as boolean,
    kind: kind as PricingRule["kind"],
    value: converted,
    targets: rule.targets as PricingRule["targets"],
    audience: rule.audience as PricingRule["audience"],
    markets: (rule.markets as PricingRule["markets"]) ?? { mode: "all", marketIds: [] },
    schedule: {
      startsAt: (rule.schedule as { startsAt?: string })?.startsAt
        ? new Date((rule.schedule as { startsAt: string }).startsAt)
        : null,
      endsAt: (rule.schedule as { endsAt?: string })?.endsAt
        ? new Date((rule.schedule as { endsAt: string }).endsAt)
        : null,
    },
    createdAt: new Date(rule.createdAt as string),
  } as PricingRule;
}

function buildContext(testCase: RawCase): PricingContext {
  const market = testCase.context.market ?? DEFAULT_MARKET;
  const currency = market.currencyCode;

  const productFixture = raw.products[testCase.context.product]!;
  const product: ProductContext = {
    productId: productFixture.productId as string,
    variantId: productFixture.variantId as string,
    collectionIds: productFixture.collectionIds as string[],
    price: money(productFixture.price as string, currency),
    cost: productFixture.cost ? money(productFixture.cost as string, currency) : null,
  };

  const customerFixture = testCase.context.customer
    ? raw.customers[testCase.context.customer]!
    : null;
  const customer: CustomerContext | null = customerFixture
    ? {
        id: customerFixture.id as string,
        tags: (customerFixture.tags as string[]) ?? [],
        groupIds: (customerFixture.groupIds as string[]) ?? [],
        companyId: (customerFixture.companyId as string) ?? null,
      }
    : null;

  return {
    customer,
    product,
    quantity: testCase.context.quantity,
    market,
    cartSubtotal: testCase.context.cartSubtotal
      ? money(testCase.context.cartSubtotal, currency)
      : null,
    now: new Date(testCase.context.now ?? DEFAULT_NOW),
  };
}

describe("golden vectors", () => {
  it("has cases, and every case cites where in the spec it comes from", () => {
    expect(raw.cases.length).toBeGreaterThan(30);
    for (const testCase of raw.cases) {
      expect(testCase.spec, testCase.name).toBeTruthy();
      expect(testCase.why, testCase.name).toBeTruthy();
    }
  });

  it.each(raw.cases.map((c) => [c.name, c] as const))("%s", (_name, testCase) => {
    const context = buildContext(testCase);
    const currency = context.market.currencyCode;
    const rules = testCase.rules.map((id) => buildRule(raw.rules[id]!, currency));

    const result = resolvePrice({ rules, context });

    expect(formatMoney(result.unitPrice), "unit price").toBe(testCase.expect.finalPrice);

    if (testCase.expect.appliedRules) {
      expect(result.appliedRuleIds, "applied rules").toEqual(
        testCase.expect.appliedRules,
      );
    }

    if (testCase.expect.clampedAtZero !== undefined) {
      expect(result.clampedAtZero, "clamped at zero").toBe(testCase.expect.clampedAtZero);
    }

    if (testCase.expect.nextTier !== undefined) {
      if (testCase.expect.nextTier === null) {
        expect(result.nextTier, "next tier").toBeNull();
      } else {
        expect(result.nextTier?.quantity, "next tier quantity").toBe(
          testCase.expect.nextTier.quantity,
        );
        expect(
          result.nextTier ? formatMoney(result.nextTier.unitPrice) : null,
          "next tier price",
        ).toBe(testCase.expect.nextTier.unitPrice);
      }
    }

    for (const [ruleId, reason] of Object.entries(testCase.expect.skipped ?? {})) {
      const entry = result.trace.find((item) => item.ruleId === ruleId);
      expect(entry, `no trace entry for ${ruleId}`).toBeDefined();
      expect(entry!.applied, `${ruleId} should not have applied`).toBe(false);
      expect(entry!.reason, `${ruleId} skip reason`).toBe(reason);
    }

    // Every rule that did not apply must say why — the "Why this price?" panel
    // and the Buyer Agent both read this, and a blank reason is a dead end.
    for (const entry of result.trace) {
      if (!entry.applied)
        expect(entry.reason, `${entry.ruleId} has no reason`).toBeTruthy();
    }

    // The line total is what a cart charges; it must agree with the unit price.
    expect(result.lineTotal.amount).toBe(result.unitPrice.amount * context.quantity);
  });
});
