/**
 * Cold read of 0.3 — what the merchant reads, against what they get.
 *
 * Run: npx vitest run --config qa/0.3/cold-read/vitest.config.ts
 */
import { describe, expect, it } from "vitest";
import en from "~/i18n/locales/en.json";
import {
  PLANS,
  planHasFeature,
  type FeatureKey,
  type PlanKey,
} from "~/lib/billing/plans";

type Catalog = { planTagline: Record<PlanKey, string> };
const strings = en as unknown as Catalog;

/** Phrases a merchant would reasonably read as "this plan includes X". */
const CLAIMS: Array<{ phrase: string; feature: FeatureKey }> = [
  { phrase: "net terms", feature: "net_terms" },
  { phrase: "shipping rules", feature: "shipping_rules" },
  { phrase: "draft orders", feature: "draft_orders" },
  { phrase: "pos", feature: "pos" },
  { phrase: "markets", feature: "markets" },
  { phrase: "merchant agent", feature: "merchant_agent" },
  { phrase: "csv import", feature: "csv_import" },
  { phrase: "auto-tagging", feature: "auto_tagging" },
  { phrase: "order limits", feature: "order_limits" },
  { phrase: "buyer agent", feature: "buyer_agent" },
  { phrase: "po-to-order", feature: "po_to_order" },
];

describe("F7 — a plan card only promises what the plan includes", () => {
  for (const plan of Object.keys(PLANS) as PlanKey[]) {
    it(`${plan} ($${PLANS[plan].monthlyPrice}/mo)`, () => {
      const tagline = strings.planTagline[plan].toLowerCase();
      const promisedButAbsent = CLAIMS.filter(
        ({ phrase, feature }) =>
          tagline.includes(phrase) && !planHasFeature(plan, feature),
      ).map(({ feature }) => feature);

      expect(
        promisedButAbsent,
        `planTagline.${plan} sells capabilities the ${plan} plan does not grant: ${strings.planTagline[plan]}`,
      ).toEqual([]);
    });
  }
});

describe("F8 — the trial banner quotes the price that will be charged", () => {
  it("does not hard-code a monthly price for an annual subscriber", () => {
    // PlansPage.tsx:99 passes `plan.monthlyPrice` into this string regardless
    // of the interval the merchant is actually on.
    const body = (en as unknown as { plans: { trial: { endingBody: string } } }).plans
      .trial.endingBody;
    expect(
      body.includes("a month"),
      `"${body}" is shown to annual subscribers too, with the monthly figure`,
    ).toBe(false);
  });
});

describe("F9 — every advertised capability exists in the product", () => {
  it("names no feature that no code path implements", async () => {
    const { execSync } = await import("node:child_process");
    const unimplemented = (
      [
        "shipping_rules",
        "quote_assistant",
        "api_sync",
        "priority_support",
      ] as FeatureKey[]
    ).filter((feature) => {
      const hits = execSync(
        `grep -rn "\\"${feature}\\"" app extensions packages --include=*.ts --include=*.tsx | grep -v "lib/billing/plans.ts" | wc -l`,
        { encoding: "utf8" },
      ).trim();
      return hits === "0";
    });

    expect(
      unimplemented,
      "these are sold in the comparison table on /app/plans and appear nowhere else in the codebase",
    ).toEqual([]);
  });
});
