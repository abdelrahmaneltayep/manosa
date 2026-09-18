import { describe, expect, it } from "vitest";

import { parseRuleForm } from "~/lib/pricing/rule-form.server";

/**
 * Market scoping is modelled, tested by three golden vectors, and **not a
 * feature of this product**.
 *
 * `MarketScope` has been in the engine since 1.1 and `pages-features.md:53`
 * promises "apply/exclude Shopify Markets". Nothing can create a rule that
 * uses it: there are no market fields in the builder, and CSV import, the AI
 * draft path and the setup wizard all write `{ mode: "all", marketIds: [] }`.
 *
 * That is deliberate, and the blocker is downstream of the UI: the checkout
 * Function knows the buyer's **country**, not which Shopify Market that maps
 * to — `Localization.market` is deprecated and the mapping is per-shop. So a
 * market-scoped rule would be dropped at checkout (`isSupportedAtCheckout`)
 * while the admin showed it applying. Building the form first would ship a
 * field that quietly does nothing, which is the shape this repo keeps finding.
 *
 * These tests exist so the gap stays a decision rather than becoming a
 * surprise: they fail the moment a writer starts emitting a scope, which is
 * the moment the country-to-market map has to be published first. See
 * `DECISIONS.md`, 2026-09-18.
 */
describe("market scoping", () => {
  const form = (extra: Record<string, string> = {}) => {
    const data = new FormData();
    data.set("name", "Wholesale 20%");
    data.set("kind", "percentage");
    data.set("percentage", "20");
    data.set("status", "active");
    data.set("audienceMode", "tags");
    data.set("audienceTags", "wholesale");
    data.set("targetMode", "all");
    for (const [key, value] of Object.entries(extra)) data.set(key, value);
    return data;
  };

  it("is every rule the builder can make, because the builder has no market fields", () => {
    const { rule } = parseRuleForm(form(), { currencyCode: "USD" });
    expect(rule.markets).toEqual({ mode: "all", marketIds: [] });
  });

  it("stays 'all' even when a market scope is posted by hand", () => {
    // Until the Function can evaluate one, accepting a scope from a
    // hand-crafted request would create a rule the admin shows applying and
    // checkout silently drops.
    const { rule } = parseRuleForm(
      form({ marketMode: "include", marketIds: "gid://shopify/Market/1" }),
      { currencyCode: "USD" },
    );
    expect(rule.markets.mode).toBe("all");
  });
});
