/**
 * Cold read of 0.3 — what the merchant reads, against what they get.
 *
 * Run: npx vitest run --config qa/0.3/cold-read/vitest.config.ts
 */
import { describe, expect, it } from "vitest";
import en from "~/i18n/locales/en.json";
import {
  featuresAddedBy,
  FEATURE_KEYS,
  isPlanned,
  PLANNED_FEATURES,
  PLANS,
  planHasFeature,
  type FeatureKey,
  type PlanKey,
} from "~/lib/billing/plans";

type Catalog = {
  planTagline: { free: string };
  feature: Record<FeatureKey, string>;
};
const strings = en as unknown as Catalog;

/**
 * The line the card shows now.
 *
 * FIXED: `planTagline.pro` / `.growth` were hand-written from
 * `docs/spec/pages-features.md`, where the tier names are the other way round
 * from `plans.ts` — so the $29 card sold the $59 plan's features while the
 * table below it marked them Not included. The three paid strings are gone;
 * the card composes its line from the ladder, so this reads what a merchant
 * reads.
 */
const taglineFor = (plan: PlanKey): string =>
  plan === "free"
    ? strings.planTagline.free
    : featuresAddedBy(plan)
        .map((feature) => strings.feature[feature])
        .join(", ");

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
      const tagline = taglineFor(plan).toLowerCase();
      const promisedButAbsent = CLAIMS.filter(
        ({ phrase, feature }) =>
          tagline.includes(phrase) && !planHasFeature(plan, feature),
      ).map(({ feature }) => feature);

      expect(
        promisedButAbsent,
        `the ${plan} card sells capabilities the ${plan} plan does not grant: ${taglineFor(plan)}`,
      ).toEqual([]);
    });
  }
});

describe("F8 — the trial banner quotes the price that will be charged", () => {
  it("does not hard-code a monthly price for an annual subscriber", () => {
    // FIXED. `plans.trial.endingBody` is gone; there are two strings now and
    // the banner picks by `view.interval`, with the price read from the same
    // interval rather than always from `monthlyPrice`.
    const trial = (
      en as unknown as {
        plans: { trial: Record<string, string | undefined> };
      }
    ).plans.trial;

    expect(trial.endingBody, "the one-size string should be gone").toBeUndefined();
    expect(trial.endingBodyMonthly).toContain("a month");
    expect(trial.endingBodyAnnual).toContain("for the year");
    expect(trial.endingBodyAnnual).not.toContain("a month");
  });
});

describe("F9 — every advertised capability exists in the product", () => {
  /**
   * FIXED, though not by building four features.
   *
   * The finding was that the comparison table rendered "Included" against
   * capabilities that appear nowhere in `app/`, `extensions/` or `packages/` —
   * so Growth was sold on wholesale shipping rules and Agentic on an API.
   *
   * Deleting them would hide a roadmap a merchant may reasonably want to see;
   * leaving them indistinguishable from what ships today is selling them. So
   * they are marked `PLANNED_FEATURES`, the table says **Planned** in its own
   * column with a note saying what that means, and the plan cards leave them
   * out of what a tier "adds" — because a card is a promise about now.
   *
   * This now checks the property that matters: nothing with no code behind it
   * is presented as included.
   */
  it("presents no capability as included when nothing implements it", async () => {
    const { execSync } = await import("node:child_process");

    const unimplemented = FEATURE_KEYS.filter((feature) => {
      const hits = execSync(
        `grep -rn "\\"${feature}\\"" app extensions packages --include=*.ts --include=*.tsx | grep -v "lib/billing/plans.ts" | wc -l`,
        { encoding: "utf8" },
      ).trim();
      return hits === "0";
    });

    const sold = unimplemented.filter((feature) => !isPlanned(feature));

    expect(
      sold,
      "these are rendered Included in the comparison table and appear nowhere else in the codebase",
    ).toEqual([]);
  });

  it("does not mark a capability planned once it exists", async () => {
    // The other direction, so the marker cannot become a place to hide a
    // shipped feature from the cards.
    const { execSync } = await import("node:child_process");

    const built = PLANNED_FEATURES.filter((feature) => {
      const hits = execSync(
        `grep -rn "\\"${feature}\\"" app extensions packages --include=*.ts --include=*.tsx | grep -v "lib/billing/plans.ts" | wc -l`,
        { encoding: "utf8" },
      ).trim();
      return hits !== "0";
    });

    // `pos` and `markets` each occur once — an order-source label and a rule
    // targeting dimension — and neither is a thing a merchant gets by paying
    // more, so both stay planned. Anything else appearing here has shipped and
    // should come off the list.
    expect(built.filter((feature) => feature !== "pos" && feature !== "markets")).toEqual(
      [],
    );
  });
});
