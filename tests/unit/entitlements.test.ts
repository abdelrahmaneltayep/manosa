import { describe, expect, it } from "vitest";

import { entitlementsFor, GRACE_PERIOD_DAYS } from "~/lib/billing/entitlements.server";

const NOW = new Date("2026-06-15T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

type BillingShape = Parameters<typeof entitlementsFor>[0];

const shop = (overrides: Partial<BillingShape> = {}): BillingShape =>
  ({
    planKey: "free",
    billingStatus: "NONE",
    billingInterval: null,
    trialEndsAt: null,
    graceEndsAt: null,
    currentPeriodEnd: null,
    isTestSubscription: false,
    ...overrides,
  }) as BillingShape;

describe("entitlements", () => {
  it("gives an unsubscribed shop the Free plan", () => {
    const result = entitlementsFor(shop(), NOW);
    expect(result.effectivePlan).toBe("free");
    expect(result.features).toEqual([]);
    expect(result.limits).toEqual({ pricingRules: 1, forms: 1 });
  });

  it("grants the paid plan while a subscription is active", () => {
    const result = entitlementsFor(
      shop({ planKey: "growth", billingStatus: "ACTIVE", billingInterval: "monthly" }),
      NOW,
    );
    expect(result.effectivePlan).toBe("growth");
    expect(result.features).toContain("merchant_agent");
    expect(result.limits.pricingRules).toBeNull();
  });

  it("grants the plan during the trial and counts the days left", () => {
    const result = entitlementsFor(
      shop({ planKey: "pro", billingStatus: "TRIAL", trialEndsAt: days(3.4) }),
      NOW,
    );
    expect(result.effectivePlan).toBe("pro");
    expect(result.trialDaysRemaining).toBe(4);
  });

  it("reports zero rather than a negative when a trial has just lapsed", () => {
    const result = entitlementsFor(
      shop({ planKey: "pro", billingStatus: "TRIAL", trialEndsAt: days(-2) }),
      NOW,
    );
    expect(result.trialDaysRemaining).toBe(0);
  });

  /**
   * A card expiring must not take the merchant's pricing rules offline the same
   * night. They keep the plan for a week while they fix the payment method.
   */
  it("keeps the paid plan working inside the grace period", () => {
    const result = entitlementsFor(
      shop({
        planKey: "agentic",
        billingStatus: "PAST_DUE",
        graceEndsAt: days(GRACE_PERIOD_DAYS - 2),
      }),
      NOW,
    );
    expect(result.effectivePlan).toBe("agentic");
    expect(result.graceDaysRemaining).toBe(5);
  });

  it("falls back to Free once the grace period has run out", () => {
    const result = entitlementsFor(
      shop({ planKey: "agentic", billingStatus: "PAST_DUE", graceEndsAt: days(-1) }),
      NOW,
    );
    expect(result.effectivePlan).toBe("free");
    // The plan they bought is still remembered, so resuming restores it.
    expect(result.plan).toBe("agentic");
  });

  it("pauses paid features when a subscription is cancelled, remembering the plan", () => {
    const result = entitlementsFor(
      shop({ planKey: "growth", billingStatus: "CANCELLED" }),
      NOW,
    );
    expect(result.effectivePlan).toBe("free");
    expect(result.plan).toBe("growth");
    expect(result.features).toEqual([]);
  });

  it("falls back to Free for a plan key it does not recognise", () => {
    // A renamed plan must not hand out capabilities by accident.
    const result = entitlementsFor(
      shop({ planKey: "enterprise", billingStatus: "ACTIVE" }),
      NOW,
    );
    expect(result.effectivePlan).toBe("free");
  });

  it("only reports trial and grace countdowns in the matching status", () => {
    const active = entitlementsFor(
      shop({ planKey: "pro", billingStatus: "ACTIVE", trialEndsAt: days(5) }),
      NOW,
    );
    expect(active.trialDaysRemaining).toBeNull();
    expect(active.graceDaysRemaining).toBeNull();
  });

  it("passes the test-subscription flag through", () => {
    const result = entitlementsFor(
      shop({ planKey: "pro", billingStatus: "ACTIVE", isTestSubscription: true }),
      NOW,
    );
    expect(result.isTest).toBe(true);
  });
});
