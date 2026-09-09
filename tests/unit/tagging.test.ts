import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { money, parseMoney } from "@mannon/pricing-engine";
import { describe, expect, it } from "vitest";

import {
  deserializeConditions,
  evaluateTagRules,
  matchesCondition,
  matchesRule,
  normalizeTags,
  validateTagRule,
  type BuyerFacts,
  type TagCondition,
  type TagRule,
} from "~/lib/customers/tagging";

const NOW = new Date("2026-06-01T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

const facts = (overrides: Partial<BuyerFacts> = {}): BuyerFacts => ({
  lifetimeSpend: parseMoney("1000.00", "USD"),
  orderCount: 4,
  countryCode: "SA",
  lastOrderAt: daysAgo(10),
  tags: [],
  answers: {},
  ...overrides,
});

const rule = (overrides: Partial<TagRule> = {}): TagRule => ({
  id: "rule-1",
  name: "Gold",
  enabled: true,
  priority: 100,
  matchMode: "all",
  conditions: [{ field: "order_count", op: "gte", value: 3 }],
  addTags: ["gold"],
  removeTags: [],
  ...overrides,
});

describe("tagging conditions", () => {
  it("compares lifetime spend in the same currency", () => {
    const condition: TagCondition = {
      field: "lifetime_spend",
      op: "gte",
      amount: parseMoney("500.00", "USD"),
    };
    expect(matchesCondition(condition, facts(), NOW)).toBe(true);
    expect(
      matchesCondition(
        condition,
        facts({ lifetimeSpend: parseMoney("4.99", "USD") }),
        NOW,
      ),
    ).toBe(false);
  });

  it("never compares across currencies", () => {
    // Deciding that €1,000 clears a $500 threshold means inventing an exchange
    // rate, and the tag it would apply changes what the buyer pays.
    const condition: TagCondition = {
      field: "lifetime_spend",
      op: "gte",
      amount: parseMoney("500.00", "USD"),
    };
    expect(
      matchesCondition(
        condition,
        facts({ lifetimeSpend: parseMoney("9000.00", "EUR") }),
        NOW,
      ),
    ).toBe(false);
  });

  it("treats a buyer who has never ordered as having no days since", () => {
    // Infinity would sweep every new signup into a win-back segment.
    const condition: TagCondition = {
      field: "days_since_last_order",
      op: "gte",
      value: 30,
    };
    expect(matchesCondition(condition, facts({ lastOrderAt: null }), NOW)).toBe(false);
    expect(matchesCondition(condition, facts({ lastOrderAt: daysAgo(45) }), NOW)).toBe(
      true,
    );
  });

  it("counts days from the clock it is handed, not the wall clock", () => {
    const condition: TagCondition = {
      field: "days_since_last_order",
      op: "gte",
      value: 30,
    };
    const buyer = facts({ lastOrderAt: new Date("2026-01-01T00:00:00Z") });
    expect(matchesCondition(condition, buyer, new Date("2026-01-15T00:00:00Z"))).toBe(
      false,
    );
    expect(matchesCondition(condition, buyer, new Date("2026-03-15T00:00:00Z"))).toBe(
      true,
    );
  });

  it("matches countries case- and space-insensitively", () => {
    const condition: TagCondition = {
      field: "country",
      op: "in",
      values: [" sa ", "ae"],
    };
    expect(matchesCondition(condition, facts(), NOW)).toBe(true);
    expect(matchesCondition(condition, facts({ countryCode: "EG" }), NOW)).toBe(false);
  });

  it("counts an unknown country as not in a list, and not out of one", () => {
    const inList: TagCondition = { field: "country", op: "in", values: ["SA"] };
    const notIn: TagCondition = { field: "country", op: "not_in", values: ["SA"] };
    expect(matchesCondition(inList, facts({ countryCode: null }), NOW)).toBe(false);
    expect(matchesCondition(notIn, facts({ countryCode: null }), NOW)).toBe(true);
  });

  it("compares tags without caring about case or spacing", () => {
    const condition: TagCondition = { field: "has_tag", tag: "WHOLESALE" };
    expect(matchesCondition(condition, facts({ tags: [" wholesale "] }), NOW)).toBe(true);
  });

  it("does not match a form answer that does not exist yet", () => {
    const condition: TagCondition = {
      field: "form_answer",
      op: "equals",
      key: "vat_valid",
      value: "yes",
    };
    expect(matchesCondition(condition, facts(), NOW)).toBe(false);
    expect(
      matchesCondition(condition, facts({ answers: { vat_valid: "Yes" } }), NOW),
    ).toBe(true);
  });
});

describe("tagging rules", () => {
  it("requires every condition in all mode and one in any mode", () => {
    const conditions: TagCondition[] = [
      { field: "order_count", op: "gte", value: 3 },
      { field: "country", op: "in", values: ["EG"] },
    ];
    expect(matchesRule(rule({ conditions }), facts(), NOW)).toBe(false);
    expect(matchesRule(rule({ conditions, matchMode: "any" }), facts(), NOW)).toBe(true);
  });

  it("matches nobody when it has no conditions", () => {
    // The alternative — matching everybody — tags an entire customer base on a
    // half-finished rule.
    expect(matchesRule(rule({ conditions: [] }), facts(), NOW)).toBe(false);
    expect(evaluateTagRules([rule({ conditions: [] })], facts(), NOW).add).toEqual([]);
  });

  it("skips disabled rules", () => {
    expect(evaluateTagRules([rule({ enabled: false })], facts(), NOW).unchanged).toBe(
      true,
    );
  });
});

describe("evaluateTagRules", () => {
  it("adds a tag the buyer does not have", () => {
    const decision = evaluateTagRules([rule()], facts(), NOW);
    expect(decision.add).toEqual(["gold"]);
    expect(decision.tags).toEqual(["gold"]);
    expect(decision.matched).toEqual(["rule-1"]);
    expect(decision.unchanged).toBe(false);
  });

  it("reports no change when the tag is already there", () => {
    const decision = evaluateTagRules([rule()], facts({ tags: ["gold"] }), NOW);
    expect(decision.unchanged).toBe(true);
    expect(decision.add).toEqual([]);
  });

  it("ignores case when deciding a tag is already there", () => {
    const decision = evaluateTagRules(
      [rule({ addTags: ["Gold"] })],
      facts({ tags: ["gold"] }),
      NOW,
    );
    expect(decision.unchanged).toBe(true);
  });

  it("removes only tags the buyer actually has", () => {
    const decision = evaluateTagRules(
      [rule({ addTags: [], removeTags: ["silver", "bronze"] })],
      facts({ tags: ["silver", "wholesale"] }),
      NOW,
    );
    expect(decision.remove).toEqual(["silver"]);
    expect(decision.tags).toEqual(["wholesale"]);
  });

  it("lets a later rule overrule an earlier one about the same tag", () => {
    // Two rules disagreeing is not an error, it is a merchant refining a
    // ladder. The last rule to speak decides, which is the only ordering that
    // can be explained on a page.
    const promote = rule({ id: "a", priority: 10, addTags: ["vip"] });
    const demote = rule({
      id: "b",
      priority: 20,
      addTags: [],
      removeTags: ["vip"],
    });
    const decision = evaluateTagRules([promote, demote], facts({ tags: ["vip"] }), NOW);
    expect(decision.remove).toEqual(["vip"]);
    expect(decision.add).toEqual([]);
  });

  it("orders by priority regardless of the order it is handed", () => {
    const first = rule({ id: "a", priority: 10, addTags: ["vip"] });
    const second = rule({ id: "b", priority: 20, addTags: [], removeTags: ["vip"] });
    const forwards = evaluateTagRules([first, second], facts({ tags: ["vip"] }), NOW);
    const backwards = evaluateTagRules([second, first], facts({ tags: ["vip"] }), NOW);
    expect(forwards).toEqual(backwards);
  });

  it("breaks a priority tie on id, so two runs agree", () => {
    const a = rule({ id: "a", priority: 10, addTags: [], removeTags: ["vip"] });
    const b = rule({ id: "b", priority: 10, addTags: ["vip"] });
    const decision = evaluateTagRules([b, a], facts({ tags: [] }), NOW);
    // b runs last, so vip is added.
    expect(decision.add).toEqual(["vip"]);
  });

  it("does not mutate the rules or the facts it is given", () => {
    const rules = [rule({ id: "b", priority: 20 }), rule({ id: "a", priority: 10 })];
    const buyer = facts({ tags: ["wholesale"] });
    const snapshot = JSON.stringify({ rules, buyer });
    evaluateTagRules(rules, buyer, NOW);
    expect(JSON.stringify({ rules, buyer })).toBe(snapshot);
  });

  it("keeps the casing the merchant typed", () => {
    const decision = evaluateTagRules([rule({ addTags: ["VIP Buyer"] })], facts(), NOW);
    expect(decision.add).toEqual(["VIP Buyer"]);
  });

  it("gives the same answer twice for the same inputs", () => {
    const rules = [rule(), rule({ id: "rule-2", addTags: ["repeat"] })];
    const first = evaluateTagRules(rules, facts(), NOW);
    const second = evaluateTagRules(rules, facts(), NOW);
    expect(first).toEqual(second);
  });
});

describe("normalizeTags", () => {
  it("trims, drops blanks, de-duplicates and sorts", () => {
    expect(normalizeTags([" b ", "a", "", "a", "  "])).toEqual(["a", "b"]);
  });
});

describe("deserializeConditions", () => {
  it("reads every condition kind back", () => {
    const stored = [
      {
        field: "lifetime_spend",
        op: "gte",
        amount: { amount: 50000, currencyCode: "USD" },
      },
      { field: "order_count", op: "lte", value: 2 },
      { field: "days_since_last_order", op: "gte", value: 45 },
      { field: "country", op: "in", values: ["SA", "AE"] },
      { field: "has_tag", tag: "wholesale" },
      { field: "lacks_tag", tag: "blocked" },
      { field: "form_answer", op: "contains", key: "company", value: "ltd" },
    ];
    const { conditions, errors } = deserializeConditions(stored);
    expect(errors).toEqual([]);
    expect(conditions).toHaveLength(7);
    expect(conditions[0]).toEqual({
      field: "lifetime_spend",
      op: "gte",
      amount: money(50000, "USD"),
    });
  });

  it("drops a condition it cannot read rather than throwing", () => {
    const { conditions, errors } = deserializeConditions([
      { field: "order_count", op: "gte", value: 3 },
      { field: "order_count", op: "sideways", value: 3 },
      { field: "made_up" },
      "not an object",
    ]);
    expect(conditions).toHaveLength(1);
    expect(errors).toHaveLength(3);
  });

  it("refuses a country condition with no countries", () => {
    // An empty list read as "in nothing" would be harmless, but read as "not in
    // nothing" it matches everybody. Dropping it is the only safe answer.
    const { conditions, errors } = deserializeConditions([
      { field: "country", op: "not_in", values: [] },
    ]);
    expect(conditions).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("survives being handed nonsense", () => {
    expect(deserializeConditions(null).conditions).toEqual([]);
    expect(deserializeConditions("nope").errors).toHaveLength(1);
    expect(deserializeConditions(42).conditions).toEqual([]);
  });
});

describe("validateTagRule", () => {
  const base = {
    name: "Gold",
    conditions: [{ field: "order_count", op: "gte", value: 3 }] as TagCondition[],
    addTags: ["gold"],
    removeTags: [] as string[],
  };

  it("accepts a complete rule", () => {
    expect(validateTagRule(base)).toEqual([]);
  });

  it("rejects a rule with no name, no conditions or no tags", () => {
    expect(validateTagRule({ ...base, name: "  " })[0]?.code).toBe("name_missing");
    expect(validateTagRule({ ...base, conditions: [] })[0]?.code).toBe("no_conditions");
    expect(validateTagRule({ ...base, addTags: [] })[0]?.code).toBe("no_tags");
  });

  it("catches a tag that is both added and removed", () => {
    const issues = validateTagRule({ ...base, removeTags: ["GOLD"] });
    expect(issues.map((issue) => issue.code)).toContain("tag_added_and_removed");
  });
});

describe("purity", () => {
  /**
   * The engine's answer has to be reproducible from its arguments alone: the
   * preview a merchant approves and the sweep that runs later must agree, and
   * they run at different times.
   */
  it("reads no clock and no randomness of its own", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/lib/customers/tagging.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/Date\.now\(\)/);
    expect(source).not.toMatch(/new Date\(\)/);
    expect(source).not.toMatch(/Math\.random\(/);
    expect(source).not.toMatch(/process\./);
  });

  it("imports nothing but the pricing engine's money helpers", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/lib/customers/tagging.ts"),
      "utf8",
    );
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual(["@mannon/pricing-engine"]);
  });
});
