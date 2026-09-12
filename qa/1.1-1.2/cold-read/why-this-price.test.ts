/**
 * Cold-read probe: "Why this price?" claims to be "the checkout answer"
 * (app/routes/app.pricing.settings.tsx:81). Is it?
 * Run: npx vitest run --config qa/1.1-1.2/cold-read/vitest.config.ts
 */
import { describe, expect, it } from "vitest";
import { parseMoney, type PricingRule } from "@mannon/pricing-engine";

import { explainFor } from "~/lib/pricing/view-model.server";

const NOW = new Date("2026-06-15T12:00:00Z");

const base = {
  id: "r",
  name: "Rule",
  status: "active" as const,
  priority: 100,
  combinable: false,
  targets: { mode: "all" as const },
  audience: { mode: "all" as const },
  markets: { mode: "all" as const, marketIds: [] },
  schedule: { startsAt: null, endsAt: null },
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("a cart-value rule, explained", () => {
  const rule = {
    ...base,
    id: "cart-1000",
    name: "8% over $1,000",
    kind: "cart_value_tier" as const,
    value: {
      tiers: [
        {
          minSubtotal: parseMoney("1000.00", "USD"),
          maxSubtotal: null,
          kind: "percentage" as const,
          percentage: 8,
        },
      ],
    },
  } as PricingRule;

  it("applies for 50 units at $30.00 — a $1,500 line, as it does at checkout", () => {
    const view = explainFor(
      [rule],
      { variantId: "gid://shopify/ProductVariant/1", tags: [], quantity: 50, price: "30.00" },
      "USD",
      NOW,
    );
    expect(view.trace[0]).toMatchObject({ ruleId: "cart-1000", applied: true });
  });
});

describe("a group-targeted rule, explained", () => {
  const rule = {
    ...base,
    id: "gold",
    name: "Gold group",
    kind: "percentage" as const,
    value: { percentage: 20 },
    audience: { mode: "groups" as const, groupIds: ["group-gold"] },
  } as PricingRule;

  it("can be explained for a buyer in that group", () => {
    const view = explainFor(
      [rule],
      { variantId: "v", tags: [], quantity: 1, price: "30.00" },
      "USD",
      NOW,
    );
    // There is no way to say "this buyer is in Gold", so the answer is always
    // audience_mismatch — the opposite of what checkout does.
    expect(view.trace[0]!.reason).not.toBe("audience_mismatch");
  });
});
