/**
 * Cold-read probe: what a merchant means by "until 1 July", and what the
 * builder's date fields actually store.
 * Run: npx vitest run --config qa/1.1-1.2/cold-read/vitest.config.ts
 */
import { describe, expect, it } from "vitest";
import { eligibilityReason, money } from "@mannon/pricing-engine";
import type { PricingContext } from "@mannon/pricing-engine";

import { parseRuleForm } from "~/lib/pricing/rule-form.server";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const ctx = (now: Date): PricingContext => ({
  customer: { id: "c", tags: ["wholesale"], groupIds: [], companyId: null },
  product: {
    productId: "p",
    variantId: "v",
    collectionIds: [],
    price: money(1000, "USD"),
    cost: null,
  },
  quantity: 1,
  market: { marketId: "m", countryCode: "US", currencyCode: "USD" },
  cartSubtotal: null,
  now,
});

const base = {
  name: "Summer trade price",
  kind: "percentage",
  percentage: "20",
  status: "active",
  audienceMode: "all",
  targetMode: "all",
};

describe("a rule the merchant ended on 1 July", () => {
  it("is still live during 1 July", () => {
    const { rule } = parseRuleForm(form({ ...base, endsAt: "2026-07-01" }), {
      currencyCode: "USD",
    });
    // Mid-morning on the day the merchant named as the last day.
    expect(eligibilityReason(rule, ctx(new Date("2026-07-01T10:00:00Z")))).toBeNull();
  });
});

describe("a rule the merchant starts on 1 July, in a store on US Pacific time", () => {
  it("is not live at 18:00 on 30 June, store time", () => {
    const { rule } = parseRuleForm(form({ ...base, startsAt: "2026-07-01" }), {
      currencyCode: "USD",
    });
    // 2026-07-01T01:00Z is 2026-06-30 18:00 in America/Los_Angeles.
    expect(eligibilityReason(rule, ctx(new Date("2026-07-01T01:00:00Z")))).toBe(
      "not_started",
    );
  });
});

describe("dates the builder cannot read", () => {
  it("reports an issue rather than silently dropping the schedule", () => {
    const parsed = parseRuleForm(form({ ...base, endsAt: "31/12/2026" }), {
      currencyCode: "USD",
    });
    expect({
      endsAt: parsed.rule.schedule.endsAt,
      issues: parsed.issues.length,
    }).toEqual({ endsAt: null, issues: 1 });
  });
});
