import { describe, expect, it } from "vitest";

import en from "~/i18n/locales/en.json";
import {
  annualSaving,
  billingPlanId,
  featuresAddedBy,
  FEATURE_KEYS,
  isPlanned,
  PLANNED_FEATURES,
  lowestPlanWithFeature,
  PAID_BILLING_PLAN_IDS,
  parseBillingPlanId,
  PLAN_KEYS,
  PLAN_LIST,
  planHasFeature,
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
    }
    // Only Free has a written tagline — it is about its limits, not its
    // capabilities. Every paid card composes its line from `featuresAddedBy`,
    // so there is no second list of capabilities to keep in step with this one.
    expect(en.planTagline.free).toBeTypeOf("string");
  });

  /**
   * The Pro card sold the Growth plan's features.
   *
   * `planTagline.pro` read "Net terms, shipping rules, draft orders, POS,
   * Markets — and the Merchant Agent" while the comparison table immediately
   * below it marked all six Not included for Pro, because the strings were
   * written from `docs/spec/pages-features.md`, where the tier names are the
   * other way round from this catalogue. A merchant who read the card and
   * subscribed had bought something they were not going to get.
   *
   * The card composes from the ladder now. This pins the two properties that
   * makes true, so a plan card can never again advertise a capability the
   * plan does not carry.
   */
  it("summarises each plan with capabilities that plan actually has", () => {
    for (const key of PLAN_KEYS) {
      for (const feature of featuresAddedBy(key)) {
        expect(planHasFeature(key, feature), `${key} → ${feature}`).toBe(true);
      }
    }
  });

  it("names every shipped capability exactly once across the ladder", () => {
    // Planned ones are deliberately off the cards — see the test below, which
    // checks they are still in the comparison table.
    const named = PLAN_KEYS.flatMap((key) => [...featuresAddedBy(key)]);
    expect([...named].sort()).toEqual(
      [...FEATURE_KEYS].filter((feature) => !isPlanned(feature)).sort(),
    );
  });

  it("adds nothing on Free, which is described by its limits", () => {
    expect(featuresAddedBy("free")).toEqual([]);
  });

  /**
   * Four capabilities were sold on the comparison table and appear nowhere in
   * `app/`, `extensions/` or `packages/` — so Growth was rendered "Included"
   * against wholesale shipping rules and Agentic against an API and priority
   * support. Invariant 4, on the page that takes the money.
   */
  it("never puts a planned capability on a plan's card", () => {
    // A card is a promise about now. The comparison table shows the roadmap in
    // its own column instead, with a note saying what Planned means.
    for (const key of PLAN_KEYS) {
      for (const feature of featuresAddedBy(key)) {
        expect(isPlanned(feature), `${key} → ${feature}`).toBe(false);
      }
    }
  });

  it("keeps every planned capability inside the ladder it describes", () => {
    for (const feature of PLANNED_FEATURES) {
      expect(FEATURE_KEYS).toContain(feature);
    }
  });

  it("still names every capability somewhere across the ladder", () => {
    // The earlier "exactly once" property, restated: marking something planned
    // must not make it vanish from the comparison table.
    const named = PLAN_KEYS.flatMap((key) => [
      ...featuresAddedBy(key),
      ...PLANS[key].features.filter(isPlanned),
    ]);
    expect(new Set(named)).toEqual(new Set(FEATURE_KEYS));
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
