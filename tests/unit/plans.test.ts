import { describe, expect, it } from "vitest";

import en from "~/i18n/locales/en.json";
import {
  annualSaving,
  billingPlanId,
  FEATURE_KEYS,
  lowestPlanWithFeature,
  PAID_BILLING_PLAN_IDS,
  parseBillingPlanId,
  PLAN_KEYS,
  PLAN_LIST,
  PLANS,
  priceFor,
} from "~/lib/billing/plans";

describe("the plan ladder", () => {
  it("is Free → Pro → Growth → Agentic", () => {
    expect([...PLAN_KEYS]).toEqual(["free", "pro", "growth", "agentic"]);
    expect(PLAN_LIST.map((plan) => plan.rank)).toEqual([0, 1, 2, 3]);
  });

  it("prices the tiers as agreed", () => {
    expect(PLANS.free.monthlyPrice).toBe(0);
    expect(PLANS.pro.monthlyPrice).toBe(29);
    expect(PLANS.growth.monthlyPrice).toBe(59);
    expect(PLANS.agentic.monthlyPrice).toBe(99);
  });

  it("gives two months free on an annual subscription", () => {
    for (const plan of PLAN_LIST) {
      expect(plan.annualPrice).toBe(plan.monthlyPrice * 10);
      expect(annualSaving(plan)).toBe(plan.monthlyPrice * 2);
    }
  });

  it("makes each tier a superset of the one below", () => {
    for (let i = 1; i < PLAN_LIST.length; i += 1) {
      const lower = PLAN_LIST[i - 1]!;
      const higher = PLAN_LIST[i]!;
      const missing = lower.features.filter(
        (feature) => !higher.features.includes(feature),
      );
      expect(missing, `${higher.key} drops ${missing.join(", ")}`).toEqual([]);
    }
  });

  it("only limits quotas on Free", () => {
    expect(PLANS.free.limits).toEqual({ pricingRules: 1, forms: 1 });
    for (const plan of PLAN_LIST.filter((p) => p.rank > 0)) {
      expect(plan.limits).toEqual({ pricingRules: null, forms: null });
    }
  });

  it("gives every paid plan a 14-day trial and Free none", () => {
    expect(PLANS.free.trialDays).toBe(0);
    for (const plan of PLAN_LIST.filter((p) => p.monthlyPrice > 0)) {
      expect(plan.trialDays).toBe(14);
    }
  });

  it("prices by interval", () => {
    expect(priceFor(PLANS.pro, "monthly")).toBe(29);
    expect(priceFor(PLANS.pro, "annual")).toBe(290);
  });
});

describe("feature placement", () => {
  it("puts every declared feature on at least one plan", () => {
    const placed = new Set(PLAN_LIST.flatMap((plan) => [...plan.features]));
    expect(FEATURE_KEYS.filter((feature) => !placed.has(feature))).toEqual([]);
  });

  it("keeps the agents on the tiers the spec puts them on", () => {
    expect(lowestPlanWithFeature("merchant_agent")).toBe("growth");
    expect(lowestPlanWithFeature("buyer_agent")).toBe("agentic");
    expect(lowestPlanWithFeature("csv_import")).toBe("pro");
  });

  it("has a label for every feature and plan in the catalog", () => {
    for (const feature of FEATURE_KEYS) {
      expect(en.feature[feature as keyof typeof en.feature], feature).toBeTypeOf(
        "string",
      );
    }
    for (const key of PLAN_KEYS) {
      expect(en.planName[key], key).toBeTypeOf("string");
      expect(en.planTagline[key], key).toBeTypeOf("string");
    }
  });
});

describe("billing plan ids", () => {
  it("round-trips", () => {
    expect(parseBillingPlanId(billingPlanId("growth", "annual"))).toEqual({
      plan: "growth",
      interval: "annual",
    });
  });

  it("rejects anything it does not recognise", () => {
    expect(parseBillingPlanId("enterprise-monthly")).toBeUndefined();
    expect(parseBillingPlanId("growth-weekly")).toBeUndefined();
    expect(parseBillingPlanId("garbage")).toBeUndefined();
  });

  it("lists exactly the paid plans, both intervals", () => {
    expect([...PAID_BILLING_PLAN_IDS].sort()).toEqual(
      [
        "agentic-annual",
        "agentic-monthly",
        "growth-annual",
        "growth-monthly",
        "pro-annual",
        "pro-monthly",
      ].sort(),
    );
  });

  /**
   * These strings become the subscription `name` in Shopify and are how a live
   * subscription maps back to a plan. Changing one silently drops paying
   * merchants to Free, so it needs a migration, not an edit.
   */
  it("is stable — changing one of these is a breaking change", () => {
    expect(billingPlanId("pro", "monthly")).toBe("pro-monthly");
    expect(billingPlanId("growth", "monthly")).toBe("growth-monthly");
    expect(billingPlanId("agentic", "annual")).toBe("agentic-annual");
  });
});
