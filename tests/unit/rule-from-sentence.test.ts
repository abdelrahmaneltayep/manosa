import { describe, expect, it } from "vitest";

import {
  readNamedDraft,
  resolveDraft,
  ruleFromSentenceUser,
  type NamedRuleDraft,
  type RuleGrounding,
} from "~/lib/ai/prompts/rule-from-sentence.server";

/**
 * Reading Claude's answer, and refusing to trust it.
 *
 * Two failures matter here and both are silent. An answer that parses but means
 * something else — a percentage read as a price, a tier that overlaps — becomes
 * a live rule. And a collection name resolved by guesswork targets the wrong
 * products at the right discount, which nobody notices until the orders arrive.
 */

const NOW = new Date("2026-09-10T12:00:00Z");

const grounding: RuleGrounding = {
  currencyCode: "USD",
  collections: [
    { id: "gid://shopify/Collection/1", title: "Sale" },
    { id: "gid://shopify/Collection/2", title: "Summer sale" },
    { id: "gid://shopify/Collection/3", title: "Tables" },
  ],
  groups: [
    { id: "grp_gold", name: "Gold" },
    { id: "grp_silver", name: "Silver" },
  ],
  tags: ["wholesale", "vip"],
};

const answer = (overrides: Record<string, unknown> = {}) => ({
  name: "Wholesale tiers",
  kind: "volume_tier",
  percentage: null,
  amount: null,
  tiers: [
    { minQuantity: 10, maxQuantity: 49, kind: "percentage", percentage: 5, amount: null },
    {
      minQuantity: 50,
      maxQuantity: null,
      kind: "percentage",
      percentage: 12,
      amount: null,
    },
  ],
  cartTiers: [],
  targets: { mode: "all", collections: [], excludeCollections: ["Sale"] },
  audience: { mode: "tags", tags: ["wholesale"], groups: [] },
  schedule: { startsAt: null, endsAt: null },
  combinable: false,
  notes: "Assumed the discount is off the wholesale price.",
  ...overrides,
});

const read = (value: unknown) => readNamedDraft(value, grounding, NOW);

const ok = (value: unknown): NamedRuleDraft => {
  const result = read(value);
  if (!result.ok) throw new Error(`expected a draft, got: ${result.error}`);
  return result.value;
};

describe("the prompt", () => {
  it("gives Claude names and never ids", () => {
    const user = ruleFromSentenceUser("10% off for wholesale", grounding);

    expect(user).toContain("Summer sale");
    expect(user).toContain("Gold");
    expect(user).toContain("wholesale");
    expect(user).not.toContain("gid://");
    expect(user).not.toContain("grp_gold");
  });

  it("says a shop with no collections has none, rather than saying nothing", () => {
    const user = ruleFromSentenceUser("10% off", {
      ...grounding,
      collections: [],
      groups: [],
      tags: [],
    });
    expect(user).toContain("(none)");
  });
});

describe("readNamedDraft", () => {
  it("reads a volume-tier answer", () => {
    const draft = ok(answer());

    expect(draft.rule.kind).toBe("volume_tier");
    expect(draft.rule.name).toBe("Wholesale tiers");
    expect(draft.notes).toContain("Assumed");
    if (draft.rule.kind !== "volume_tier") throw new Error("wrong kind");
    expect(draft.rule.value.tiers).toHaveLength(2);
  });

  it("keeps the collection names it was given, unresolved", () => {
    const draft = ok(answer());
    expect(draft.rule.targets.excludeCollectionIds).toEqual(["Sale"]);
  });

  it("lands as a draft, never as an active rule", () => {
    expect(ok(answer()).rule.status).toBe("draft");
  });

  it("reads an amount in minor units, not by multiplying by a hundred", () => {
    const draft = ok(
      answer({ kind: "amount_off", tiers: [], amount: "12.50", percentage: null }),
    );
    if (draft.rule.kind !== "amount_off") throw new Error("wrong kind");
    expect(draft.rule.value.base).toEqual({ amount: 1_250, currencyCode: "USD" });
  });

  it("reads a three-decimal currency by its own exponent", () => {
    const draft = readNamedDraft(
      answer({ kind: "fixed_price", tiers: [], amount: "12.500" }),
      { ...grounding, currencyCode: "KWD" },
      NOW,
    );
    if (!draft.ok) throw new Error(draft.error);
    if (draft.value.rule.kind !== "fixed_price") throw new Error("wrong kind");
    expect(draft.value.rule.value.base).toEqual({ amount: 12_500, currencyCode: "KWD" });
  });

  it("reads a cart-value rule", () => {
    const draft = ok(
      answer({
        kind: "cart_value_tier",
        tiers: [],
        cartTiers: [
          {
            minSubtotal: "2000.00",
            maxSubtotal: null,
            kind: "percentage",
            percentage: 10,
            amount: null,
          },
        ],
      }),
    );
    if (draft.rule.kind !== "cart_value_tier") throw new Error("wrong kind");
    expect(draft.rule.value.tiers[0]?.minSubtotal).toEqual({
      amount: 200_000,
      currencyCode: "USD",
    });
  });

  it("refuses an answer that is not an object", () => {
    expect(read("a rule").ok).toBe(false);
    expect(read([1, 2]).ok).toBe(false);
    expect(read(null).ok).toBe(false);
  });

  it("refuses a kind it does not know", () => {
    const result = read(answer({ kind: "buy_one_get_one" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("buy_one_get_one");
  });

  it("refuses product targeting, which needs ids it cannot have", () => {
    const result = read(
      answer({ targets: { mode: "products", collections: [], excludeCollections: [] } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("targets.mode");
  });

  it("refuses an audience mode that needs ids", () => {
    const result = read(
      answer({ audience: { mode: "customers", tags: [], groups: [] } }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses an amount with a currency symbol", () => {
    const result = read(answer({ kind: "amount_off", tiers: [], amount: "$12.50" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("decimal");
  });

  it("refuses an amount sent as a number rather than a string", () => {
    expect(read(answer({ kind: "amount_off", tiers: [], amount: 12.5 })).ok).toBe(false);
  });

  it("refuses tiers that overlap, quoting the ranges back", () => {
    const result = read(
      answer({
        tiers: [
          { minQuantity: 10, maxQuantity: 60, kind: "percentage", percentage: 5 },
          { minQuantity: 40, maxQuantity: null, kind: "percentage", percentage: 12 },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("tier_overlap");
  });

  it("refuses a percentage over a hundred", () => {
    const result = read(answer({ kind: "percentage", tiers: [], percentage: 140 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("percentage_out_of_range");
  });

  it("refuses a rule with no name", () => {
    const result = read(answer({ name: "  " }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("name_required");
  });

  it("refuses an end date before its start", () => {
    const result = read(
      answer({ schedule: { startsAt: "2026-12-01", endsAt: "2026-11-01" } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("end_before_start");
  });

  it("refuses a date that is not a date", () => {
    const result = read(answer({ schedule: { startsAt: "next Tuesday", endsAt: null } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not a date");
  });

  it("ignores fields it was not asked for rather than storing them", () => {
    const draft = ok(answer({ sqlToRun: "DROP TABLE PricingRule", priority: 1 }));
    expect(draft.rule.priority).toBe(100);
    expect(JSON.stringify(draft.rule)).not.toContain("DROP TABLE");
  });
});

/* -------------------------------------------------------------------------- */

describe("resolveDraft", () => {
  /** The model's own JSON shape, which is names — not the engine's Targeting. */
  const draftWith = (
    targets: Record<string, unknown>,
    audience: Record<string, unknown> = {},
  ) =>
    ok(
      answer({
        targets: {
          mode: "collections",
          collections: [],
          excludeCollections: [],
          ...targets,
        },
        audience: { mode: "tags", tags: ["wholesale"], groups: [], ...audience },
      }),
    );

  it("turns an exact name into an id, whatever the case", () => {
    const draft = draftWith({ collections: ["tABLes"] });
    const resolved = resolveDraft(draft, grounding);

    expect(resolved.rule.targets.collectionIds).toEqual(["gid://shopify/Collection/3"]);
    expect(resolved.clarifications).toEqual([]);
  });

  it("prefers an exact match over one that merely contains it", () => {
    const draft = draftWith({ collections: ["sale"] });
    const resolved = resolveDraft(draft, grounding);

    // "Sale" matches exactly; "Summer sale" contains it. That is a question,
    // not a coin toss — a wrong guess prices the wrong products.
    expect(resolved.rule.targets.collectionIds).toEqual(["gid://shopify/Collection/1"]);
    expect(resolved.clarifications).toEqual([]);
  });

  it("asks when nothing matches, and offers what is close", () => {
    const draft = draftWith({ collections: ["summer"] });
    const resolved = resolveDraft(draft, grounding);

    expect(resolved.rule.targets.collectionIds).toEqual([]);
    expect(resolved.clarifications).toHaveLength(1);
    expect(resolved.clarifications[0]).toMatchObject({
      field: "targets.collectionIds",
      term: "summer",
    });
    expect(resolved.clarifications[0]?.options.map((one) => one.label)).toEqual([
      "Summer sale",
    ]);
  });

  it("asks with no options when nothing in the shop is close", () => {
    const resolved = resolveDraft(draftWith({ collections: ["Sofas"] }), grounding);

    expect(resolved.clarifications).toHaveLength(1);
    expect(resolved.clarifications[0]?.options).toEqual([]);
  });

  it("applies the merchant's answer, and stops asking", () => {
    const draft = draftWith({ collections: ["summer"] });
    const resolved = resolveDraft(draft, grounding, {
      summer: "gid://shopify/Collection/2",
    });

    expect(resolved.rule.targets.collectionIds).toEqual(["gid://shopify/Collection/2"]);
    expect(resolved.clarifications).toEqual([]);
  });

  it("is idempotent: resolving an already-resolved draft changes nothing", () => {
    const draft = draftWith({ collections: ["Tables"] });
    const once = resolveDraft(draft, grounding);
    const twice = resolveDraft({ ...draft, rule: once.rule }, grounding);

    expect(twice.rule.targets.collectionIds).toEqual(once.rule.targets.collectionIds);
    expect(twice.clarifications).toEqual([]);
  });

  it("resolves exclusions and groups too", () => {
    const draft = ok(
      answer({
        targets: { mode: "all", collections: [], excludeCollections: ["Sale"] },
        audience: { mode: "groups", tags: [], groups: ["gold"] },
      }),
    );
    const resolved = resolveDraft(draft, grounding);

    expect(resolved.rule.targets.excludeCollectionIds).toEqual([
      "gid://shopify/Collection/1",
    ]);
    expect(resolved.rule.audience.groupIds).toEqual(["grp_gold"]);
  });

  it("never invents an id for a name it cannot place", () => {
    const resolved = resolveDraft(draftWith({ collections: ["Sofas"] }), grounding);
    expect(JSON.stringify(resolved.rule)).not.toContain("Sofas");
  });

  it("ignores an answer that names something this shop does not have", () => {
    const resolved = resolveDraft(draftWith({ collections: ["summer"] }), grounding, {
      summer: "gid://shopify/Collection/999",
    });

    expect(resolved.rule.targets.collectionIds).toEqual([]);
    expect(resolved.clarifications).toHaveLength(1);
  });
});
