import { money, zero } from "@mannon/pricing-engine";
import { describe, expect, it } from "vitest";

import {
  checkEligibility,
  dueDateFor,
  effectiveTerms,
  isOverridden,
  termsWithLimit,
} from "../src/terms";
import type { Terms } from "../src/types";

const usd = (amount: number) => money(amount, "USD");

describe("effectiveTerms", () => {
  it("takes the buyer's own terms over their group's", () => {
    const terms = effectiveTerms(
      { days: 60, creditLimit: null },
      { days: 30, creditLimit: null },
    );
    expect(terms).toEqual({ days: 60, creditLimit: null, source: "customer" });
  });

  it("falls back to the group", () => {
    const terms = effectiveTerms(
      { days: null, creditLimit: 50000 },
      { days: 30, creditLimit: null },
    );
    expect(terms).toEqual({ days: 30, creditLimit: null, source: "group" });
  });

  it("does not merge the two levels field by field", () => {
    // Net 60 from the buyer with the tier's $500 limit is a third arrangement
    // nobody agreed to.
    const terms = termsWithLimit(
      { days: 60, creditLimit: null },
      { days: 30, creditLimit: 50000 },
      "USD",
    );
    expect(terms).toEqual({ days: 60, creditLimit: null, source: "customer" });
  });

  it("has no terms when neither level sets days", () => {
    expect(effectiveTerms({ days: null, creditLimit: 50000 }, null)).toBeNull();
    expect(effectiveTerms(null, null)).toBeNull();
    expect(effectiveTerms(null, { days: null, creditLimit: null })).toBeNull();
  });

  it("refuses days that are not a whole positive number", () => {
    expect(effectiveTerms({ days: 0, creditLimit: null }, null)).toBeNull();
    expect(effectiveTerms({ days: -30, creditLimit: null }, null)).toBeNull();
    expect(effectiveTerms({ days: 30.5, creditLimit: null }, null)).toBeNull();
  });

  it("resolves a credit limit in the shop's currency", () => {
    const terms = termsWithLimit(null, { days: 30, creditLimit: 500000 }, "SAR");
    expect(terms?.creditLimit).toEqual(money(500000, "SAR"));
  });

  it("treats a negative credit limit as no limit rather than a locked account", () => {
    const terms = termsWithLimit(null, { days: 30, creditLimit: -1 }, "USD");
    expect(terms?.creditLimit).toBeNull();
  });
});

describe("isOverridden", () => {
  it("is true only when both levels set days", () => {
    expect(
      isOverridden({ days: 60, creditLimit: null }, { days: 30, creditLimit: null }),
    ).toBe(true);
    expect(
      isOverridden({ days: null, creditLimit: null }, { days: 30, creditLimit: null }),
    ).toBe(false);
    expect(isOverridden({ days: 60, creditLimit: null }, null)).toBe(false);
    expect(isOverridden(null, null)).toBe(false);
  });
});

describe("checkEligibility", () => {
  const terms: Terms = { days: 30, creditLimit: null, source: "group" };
  const facts = (overrides: Partial<Parameters<typeof checkEligibility>[0]> = {}) => ({
    isAuthenticated: true,
    terms,
    outstanding: zero("USD"),
    overdueCount: 0,
    cartTotal: usd(50000),
    ...overrides,
  });

  it("lets an eligible buyer pay later", () => {
    expect(checkEligibility(facts())).toEqual({
      eligible: true,
      reason: null,
      terms,
      headroom: null,
    });
  });

  it("refuses a guest, with a reason the admin can read", () => {
    const verdict = checkEligibility(facts({ isAuthenticated: false }));
    expect(verdict).toMatchObject({ eligible: false, reason: "not_authenticated" });
  });

  it("refuses a buyer with no terms", () => {
    expect(checkEligibility(facts({ terms: null }))).toMatchObject({
      eligible: false,
      reason: "no_terms",
    });
  });

  it("puts an overdue invoice ahead of a credit limit", () => {
    // A buyer who has not paid the last one is what a credit limit is a proxy
    // for; saying "over your limit" when they are not would be wrong.
    const verdict = checkEligibility(
      facts({
        overdueCount: 1,
        terms: { days: 30, creditLimit: usd(1_000_000), source: "group" },
      }),
    );
    expect(verdict.reason).toBe("has_overdue");
  });

  it("allows a cart that exactly reaches the limit", () => {
    const verdict = checkEligibility(
      facts({
        terms: { days: 30, creditLimit: usd(100000), source: "group" },
        outstanding: usd(50000),
        cartTotal: usd(50000),
      }),
    );
    expect(verdict.eligible).toBe(true);
    expect(verdict.headroom).toEqual(usd(50000));
  });

  it("refuses a cart one cent over, and says how much is left", () => {
    const verdict = checkEligibility(
      facts({
        terms: { days: 30, creditLimit: usd(100000), source: "group" },
        outstanding: usd(50000),
        cartTotal: usd(50001),
      }),
    );
    expect(verdict).toMatchObject({ eligible: false, reason: "over_credit_limit" });
    // The number the checklist requires the agent and the checkout to agree on.
    expect(verdict.headroom).toEqual(usd(50000));
  });

  it("never reports negative headroom", () => {
    const verdict = checkEligibility(
      facts({
        terms: { days: 30, creditLimit: usd(100000), source: "group" },
        outstanding: usd(130000),
        cartTotal: usd(1000),
      }),
    );
    expect(verdict.headroom).toEqual(zero("USD"));
  });

  it("refuses rather than comparing two currencies", () => {
    const verdict = checkEligibility(
      facts({
        terms: { days: 30, creditLimit: usd(100000), source: "group" },
        cartTotal: money(50000, "SAR"),
      }),
    );
    expect(verdict).toMatchObject({ eligible: false, reason: "over_credit_limit" });
    expect(verdict.headroom).toBeNull();
  });
});

describe("dueDateFor", () => {
  it("adds whole days", () => {
    expect(dueDateFor(new Date("2026-09-10T12:00:00Z"), 30).toISOString()).toBe(
      "2026-10-10T12:00:00.000Z",
    );
  });

  it("crosses a month and a year boundary", () => {
    expect(dueDateFor(new Date("2026-12-20T00:00:00Z"), 30).toISOString()).toBe(
      "2027-01-19T00:00:00.000Z",
    );
  });

  it("does not mutate the date it was given", () => {
    const placed = new Date("2026-09-10T12:00:00Z");
    dueDateFor(placed, 30);
    expect(placed.toISOString()).toBe("2026-09-10T12:00:00.000Z");
  });
});
