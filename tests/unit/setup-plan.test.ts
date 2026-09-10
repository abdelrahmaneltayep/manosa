import { describe, expect, it } from "vitest";

import {
  normalizeTag,
  readSetupPlan,
  WIZARD_FIELD_KEYS,
  type SetupGrounding,
} from "~/lib/ai/prompts/setup-plan.server";

/**
 * What the setup wizard will and will not accept from the model.
 *
 * This is the widest write path in the app — one answer becomes customer
 * groups, a live pricing rule and a registration form — so the reader is the
 * security boundary. Everything below is something a model could plausibly
 * return, and what happens to it.
 */

const grounding = (overrides: Partial<SetupGrounding> = {}): SetupGrounding => ({
  currencyCode: "USD",
  groups: [],
  hasForm: false,
  hasRule: false,
  ...overrides,
});

const answer = (overrides: Record<string, unknown> = {}) => ({
  summary: "You sell to cafés at a trade discount.",
  groups: [{ name: "Cafés", tag: "cafes", description: "Independent cafés." }],
  rule: {
    name: "Café trade price",
    kind: "percentage",
    percentage: 25,
    amount: null,
    tiers: [],
    audienceTag: "cafes",
  },
  form: {
    name: "Trade application",
    fields: ["company", "email", "vat_number"],
    autoTag: "cafes",
  },
  notes: null,
  ...overrides,
});

const read = (value: unknown, g = grounding()) => readSetupPlan(value, g);

describe("a plan it accepts", () => {
  it("reads groups, a rule and a form", () => {
    const result = read(answer());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.groups).toEqual([
      { name: "Cafés", tag: "cafes", description: "Independent cafés." },
    ]);
    expect(result.value.rule?.percentage).toBe(25);
    expect(result.value.form?.fields).toEqual(["company", "email", "vat_number"]);
  });

  it("reads quantity breaks that ascend", () => {
    const result = read(
      answer({
        rule: {
          name: "Volume",
          kind: "volume_tier",
          percentage: null,
          amount: null,
          tiers: [
            { minQuantity: 1, maxQuantity: 49, percentage: 10 },
            { minQuantity: 50, maxQuantity: null, percentage: 20 },
          ],
          audienceTag: "cafes",
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rule?.tiers).toHaveLength(2);
  });

  it("adds the two fields no registration form can do without", () => {
    const result = read(
      answer({ form: { name: "Trade", fields: ["phone"], autoTag: "cafes" } }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.form?.fields).toContain("email");
      expect(result.value.form?.fields).toContain("company");
    }
  });

  it("drops a field key it has never heard of, and keeps the rest", () => {
    const result = read(
      answer({
        form: {
          name: "Trade",
          fields: ["email", "company", "social_security_number", "phone"],
          autoTag: "cafes",
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.form?.fields).toEqual(["email", "company", "phone"]);
      for (const key of result.value.form?.fields ?? []) {
        expect(WIZARD_FIELD_KEYS).toContain(key);
      }
    }
  });
});

describe("a plan it refuses", () => {
  it("refuses a rule priced for a tag it did not propose", () => {
    const result = read(
      answer({
        rule: {
          name: "Everyone",
          kind: "percentage",
          percentage: 90,
          amount: null,
          tiers: [],
          // Not one of the groups. A rule aimed at a tag nobody is in is the
          // harmless version; a rule aimed at "" is 90% off for everybody.
          audienceTag: "",
        },
      }),
    );

    expect(result.ok).toBe(false);
  });

  it("refuses a form tagged with something it did not propose", () => {
    const result = read(
      answer({ form: { name: "Trade", fields: ["email"], autoTag: "vip" } }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a discount of 100% or more", () => {
    for (const percentage of [100, 150, 0, -10]) {
      const result = read(
        answer({
          rule: {
            name: "Free",
            kind: "percentage",
            percentage,
            amount: null,
            tiers: [],
            audienceTag: "cafes",
          },
        }),
      );
      expect(result.ok).toBe(false);
    }
  });

  it("refuses quantity breaks that overlap or go backwards", () => {
    const result = read(
      answer({
        rule: {
          name: "Volume",
          kind: "volume_tier",
          percentage: null,
          amount: null,
          tiers: [
            { minQuantity: 1, maxQuantity: 100, percentage: 10 },
            { minQuantity: 50, maxQuantity: null, percentage: 20 },
          ],
          audienceTag: "cafes",
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses an amount with a currency symbol in it", () => {
    const result = read(
      answer({
        rule: {
          name: "Five off",
          kind: "amount_off",
          percentage: null,
          amount: "$5.00",
          tiers: [],
          audienceTag: "cafes",
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a rule kind that is not one of the three", () => {
    const result = read(
      answer({
        rule: {
          name: "Free shipping",
          kind: "free_shipping",
          percentage: null,
          amount: null,
          tiers: [],
          audienceTag: "cafes",
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses an answer with no groups at all", () => {
    expect(read(answer({ groups: [] })).ok).toBe(false);
    expect(read("not an object").ok).toBe(false);
    expect(read(null).ok).toBe(false);
  });
});

describe("a shop that is already set up", () => {
  it("never proposes a group that already exists", () => {
    const result = read(
      answer({
        groups: [
          { name: "Cafés", tag: "cafes", description: "Independent cafés." },
          { name: "Key accounts", tag: "key", description: "The big three." },
        ],
        rule: {
          name: "Key account price",
          kind: "percentage",
          percentage: 30,
          amount: null,
          tiers: [],
          audienceTag: "key",
        },
        form: { name: "Trade", fields: ["email"], autoTag: "key" },
      }),
      grounding({ groups: [{ name: "Cafés", tag: "wholesale-cafe" }] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.groups.map((group) => group.name)).toEqual(["Key accounts"]);
  });

  it("lets a rule price for a group that already exists, at that group's own tag", () => {
    const existing = grounding({ groups: [{ name: "Cafés", tag: "wholesale-cafe" }] });

    // The shop's tag: accepted, and the group is not created a second time.
    const good = read(
      answer({
        rule: {
          name: "Café trade price",
          kind: "percentage",
          percentage: 25,
          amount: null,
          tiers: [],
          audienceTag: "wholesale-cafe",
        },
        form: { name: "Trade", fields: ["email"], autoTag: "wholesale-cafe" },
      }),
      existing,
    );
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value.groups).toEqual([]);

    // The model's guess at that tag: refused, and the error names the real one,
    // so the repair round has something to work with. A rule aimed at a tag no
    // buyer carries prices for nobody, silently.
    const guessed = read(answer(), existing);
    expect(guessed.ok).toBe(false);
    if (!guessed.ok) expect(guessed.error).toContain("wholesale-cafe");
  });

  it("proposes no rule for a shop that has rules, whatever the model said", () => {
    const result = read(answer(), grounding({ hasRule: true }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rule).toBeNull();
  });

  it("proposes no form for a shop that has one", () => {
    const result = read(answer(), grounding({ hasForm: true }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.form).toBeNull();
  });
});

describe("tags", () => {
  it("shapes a tag into one we would have written ourselves", () => {
    expect(normalizeTag("  Key Accounts  ")).toBe("key-accounts");
    expect(normalizeTag("café/bar")).toBe("café-bar");
    expect(normalizeTag("---")).toBe("");
    expect(normalizeTag("a".repeat(80))).toHaveLength(40);
  });
});
