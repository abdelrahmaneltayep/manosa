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

/* -------------------------------------------------------------------------- */

describe("the plan survives its own round trip", () => {
  /**
   * The property the wizard rests on, and the one whose absence let three
   * ordinary plans fail at the last step.
   *
   * The preview travels back to the server in a hidden form field. The route
   * re-reads it before applying — deliberately, because the field is editable.
   * So whatever this reader emits has to be something it accepts: `read(x)` ok
   * implies `read(JSON.parse(JSON.stringify(read(x).value)))` ok, and equal.
   */
  const roundTrip = (value: unknown, g = grounding()) => {
    const first = readSetupPlan(value, g);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);

    const wire: unknown = JSON.parse(JSON.stringify(first.value));
    const second = readSetupPlan(wire, g);
    if (!second.ok) throw new Error(`second read failed: ${second.error}`);
    expect(second.value).toEqual(first.value);
    return second.value;
  };

  it("survives a percentage rule", () => {
    roundTrip(answer());
  });

  it("survives an amount-off rule", () => {
    const plan = roundTrip(
      answer({
        rule: {
          name: "Five off",
          kind: "amount_off",
          percentage: null,
          amount: "5.00",
          tiers: [],
          audienceTag: "cafes",
        },
      }),
    );
    // A decimal string on the way out, because that is what it takes in.
    expect(plan.rule?.amount).toBe("5.00");
  });

  it("survives a volume rule", () => {
    roundTrip(
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
  });

  it("survives a plan aimed at a group the shop already has", () => {
    // The case the draft-side fix created and the apply-side re-read undid:
    // the group is filtered out of the plan, so its tag has to come from the
    // grounding rather than from the answer.
    const existing = grounding({ groups: [{ name: "Cafés", tag: "wholesale-cafe" }] });
    const plan = roundTrip(
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

    expect(plan.groups).toEqual([]);
    expect(plan.rule?.audienceTag).toBe("wholesale-cafe");
  });

  it("survives being applied twice", () => {
    // What a double-click does: the first apply creates the group, the second
    // re-grounds against a shop that now has it. "Already done" is not an
    // unreadable answer.
    const before = grounding();
    const first = readSetupPlan(answer(), before);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const after = grounding({ groups: [{ name: "Cafés", tag: "cafes" }] });
    const second = readSetupPlan(JSON.parse(JSON.stringify(first.value)), after);

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.groups).toEqual([]);
      expect(second.value.rule?.audienceTag).toBe("cafes");
    }
  });
});

describe("what a rule may not reach", () => {
  it("refuses a new group tagged like one that already exists", () => {
    // Two groups sharing a tag means the starter rule for one prices for the
    // other. `CustomerGroup` is unique on its handle, not its tag, so nothing
    // downstream would have caught it.
    const result = read(
      answer({
        groups: [{ name: "Coffee shops", tag: "cafes", description: "d" }],
      }),
      grounding({ groups: [{ name: "Cafés", tag: "cafes" }] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cafes");
  });

  it("refuses a negative discount", () => {
    // `parseMoney` accepts a leading minus and `validateRule` would then raise
    // it — as a 500, halfway through applying, on a shop that already has the
    // groups.
    for (const amount of ["-5.00", "0.00"]) {
      const result = read(
        answer({
          rule: {
            name: "Odd",
            kind: "amount_off",
            percentage: null,
            amount,
            tiers: [],
            audienceTag: "cafes",
          },
        }),
      );
      expect(result.ok).toBe(false);
    }
  });
});
