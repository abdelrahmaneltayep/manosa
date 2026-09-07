import { describe, expect, it } from "vitest";

import { planChangeFor } from "~/lib/billing/plan-change";

const noUsage = { pricingRules: 0, forms: 0 };

describe("plan change impact", () => {
  it("reads a move up the ladder as an upgrade and lists what is gained", () => {
    const change = planChangeFor({
      from: "pro",
      to: "growth",
      fromInterval: "monthly",
      toInterval: "monthly",
      usage: noUsage,
    });

    expect(change.direction).toBe("upgrade");
    expect(change.gaining).toContain("merchant_agent");
    expect(change.losing).toEqual([]);
    expect(change.price).toBe(59);
  });

  it("reads a move down as a downgrade and lists exactly what pauses", () => {
    const change = planChangeFor({
      from: "agentic",
      to: "pro",
      fromInterval: "monthly",
      toInterval: "monthly",
      usage: noUsage,
    });

    expect(change.direction).toBe("downgrade");
    expect(change.gaining).toEqual([]);
    expect(change.losing).toEqual(
      expect.arrayContaining(["buyer_agent", "merchant_agent", "net_terms"]),
    );
  });

  it("distinguishes a billing-period change from a plan change", () => {
    expect(
      planChangeFor({
        from: "pro",
        to: "pro",
        fromInterval: "monthly",
        toInterval: "annual",
        usage: noUsage,
      }).direction,
    ).toBe("interval-only");

    expect(
      planChangeFor({
        from: "pro",
        to: "pro",
        fromInterval: "monthly",
        toInterval: "monthly",
        usage: noUsage,
      }).direction,
    ).toBe("same");
  });

  it("reports a tightening quota only when it actually tightens", () => {
    const down = planChangeFor({
      from: "growth",
      to: "free",
      fromInterval: "monthly",
      toInterval: "monthly",
      usage: noUsage,
    });
    expect(down.limitImpacts.map((impact) => impact.key).sort()).toEqual([
      "forms",
      "pricingRules",
    ]);

    const up = planChangeFor({
      from: "free",
      to: "growth",
      fromInterval: null,
      toInterval: "monthly",
      usage: noUsage,
    });
    expect(up.limitImpacts).toEqual([]);
  });

  /**
   * The merchant has to be told, in numbers, what stops applying — "some rules
   * may be affected" is the kind of vagueness Built for Shopify calls a dark
   * pattern.
   */
  it("counts exactly how much is over the new quota", () => {
    const change = planChangeFor({
      from: "growth",
      to: "free",
      fromInterval: "monthly",
      toInterval: "monthly",
      usage: { pricingRules: 14, forms: 1 },
    });

    expect(change.hasOverage).toBe(true);
    const rules = change.limitImpacts.find((impact) => impact.key === "pricingRules")!;
    expect(rules).toMatchObject({ used: 14, becomes: 1, overBy: 13 });

    // Exactly at the limit is not an overage.
    const forms = change.limitImpacts.find((impact) => impact.key === "forms")!;
    expect(forms.overBy).toBe(0);
  });

  it("has no overage when the shop is inside the new quota", () => {
    const change = planChangeFor({
      from: "pro",
      to: "free",
      fromInterval: "monthly",
      toInterval: "monthly",
      usage: { pricingRules: 1, forms: 0 },
    });
    expect(change.hasOverage).toBe(false);
  });

  it("prices the target plan for the chosen interval", () => {
    expect(
      planChangeFor({
        from: "free",
        to: "agentic",
        fromInterval: null,
        toInterval: "annual",
        usage: noUsage,
      }).price,
    ).toBe(990);
  });
});
