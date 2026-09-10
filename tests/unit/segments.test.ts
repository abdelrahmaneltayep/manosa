import { describe, expect, it } from "vitest";

import {
  MAX_CONDITIONS,
  readCondition,
  readConditions,
  tightestCondition,
  validateSegment,
  type SegmentCondition,
} from "~/lib/customers/segments";
import {
  readNamedSegment,
  resolveSegment,
  segmentUser,
  type SegmentGrounding,
} from "~/lib/ai/prompts/segment.server";

/**
 * Segments: a saved filter that has to mean the same thing everywhere.
 *
 * One reader guards the model's answer, the merchant's form and the stored
 * JSON, so a segment cannot mean one thing when it is counted and another when
 * it prices somebody.
 */

const grounding: SegmentGrounding = {
  currencyCode: "USD",
  groups: [
    { id: "grp_gold", name: "Gold" },
    { id: "grp_silver", name: "Silver" },
  ],
  tags: ["wholesale", "vip"],
};

describe("readCondition", () => {
  it("reads money in minor units", () => {
    const condition = readCondition({
      field: "lifetime_spend",
      op: "gt",
      amount: { amount: 500_000, currencyCode: "USD" },
    });
    expect(condition).toEqual({
      field: "lifetime_spend",
      op: "gt",
      amount: { amount: 500_000, currencyCode: "USD" },
    });
  });

  it("refuses an operator it does not know", () => {
    expect(readCondition({ field: "order_count", op: "between", value: 3 })).toBeNull();
  });

  it("refuses a field it does not know", () => {
    expect(readCondition({ field: "favourite_colour", value: "blue" })).toBeNull();
  });

  it("refuses a negative or fractional count", () => {
    expect(readCondition({ field: "order_count", op: "gt", value: -1 })).toBeNull();
    expect(readCondition({ field: "order_count", op: "gt", value: 1.5 })).toBeNull();
  });

  it("refuses money that is not money", () => {
    expect(readCondition({ field: "lifetime_spend", op: "gt", amount: 5000 })).toBeNull();
    expect(
      readCondition({
        field: "lifetime_spend",
        op: "gt",
        amount: { amount: 5000, currencyCode: "DOLLARS" },
      }),
    ).toBeNull();
  });

  it("uppercases a country code and refuses a country name", () => {
    expect(readCondition({ field: "country", op: "is", value: "sa" })).toEqual({
      field: "country",
      op: "is",
      value: "SA",
    });
    expect(
      readCondition({ field: "country", op: "is", value: "Saudi Arabia" }),
    ).toBeNull();
  });

  it("refuses a status this app does not have", () => {
    expect(readCondition({ field: "status", value: "BLOCKED" })).toBeNull();
    expect(readCondition({ field: "status", value: "APPROVED" })).toEqual({
      field: "status",
      value: "APPROVED",
    });
  });

  it("drops the unreadable rather than the whole list", () => {
    const conditions = readConditions([
      { field: "never_ordered" },
      { field: "nonsense" },
      { field: "tax_exempt", value: true },
    ]);
    expect(conditions).toHaveLength(2);
  });
});

describe("validateSegment", () => {
  const spend: SegmentCondition = {
    field: "lifetime_spend",
    op: "gt",
    amount: { amount: 100, currencyCode: "USD" },
  };

  it("passes a real segment", () => {
    expect(validateSegment("Big quiet buyers", [spend])).toEqual([]);
  });

  it("wants a name and at least one filter", () => {
    expect(validateSegment("  ", [spend]).map((issue) => issue.code)).toEqual([
      "name_required",
    ]);
    expect(validateSegment("Empty", []).map((issue) => issue.code)).toEqual([
      "no_conditions",
    ]);
  });

  it("refuses two conditions on the same field", () => {
    const issues = validateSegment("Twice", [spend, spend]);
    expect(issues.map((issue) => issue.code)).toContain("duplicate_field");
  });

  it("allows two tag conditions, which are a real ask", () => {
    const issues = validateSegment("Tagged", [
      { field: "tag", op: "has", value: "wholesale" },
      { field: "tag", op: "not_has", value: "lapsed" },
    ]);
    expect(issues).toEqual([]);
  });

  it("caps how many filters one segment can carry", () => {
    const many: SegmentCondition[] = Array.from(
      { length: MAX_CONDITIONS + 1 },
      (_one, index) => ({ field: "tag", op: "has", value: `tag-${index}` }),
    );
    expect(validateSegment("Too many", many).map((issue) => issue.code)).toContain(
      "too_many_conditions",
    );
  });
});

describe("tightestCondition", () => {
  it("names the one whose removal helps most", () => {
    expect(
      tightestCondition([
        { index: 0, countWithout: 2 },
        { index: 1, countWithout: 40 },
        { index: 2, countWithout: 0 },
      ]),
    ).toBe(1);
  });

  it("says nothing when no single removal helps", () => {
    expect(
      tightestCondition([
        { index: 0, countWithout: 0 },
        { index: 1, countWithout: 0 },
      ]),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("reading Claude's answer", () => {
  const answer = (overrides: Record<string, unknown> = {}) => ({
    name: "Big quiet buyers",
    conditions: [
      { field: "lifetime_spend", op: "gt", amount: "5000.00" },
      { field: "last_order_days", op: "gt", value: 45 },
    ],
    notes: null,
    ...overrides,
  });

  const read = (value: unknown) => readNamedSegment(value, grounding);

  it("turns a decimal amount into minor units", () => {
    const result = read(answer());
    if (!result.ok) throw new Error(result.error);
    expect(result.value.conditions[0]).toEqual({
      field: "lifetime_spend",
      op: "gt",
      amount: { amount: 500_000, currencyCode: "USD" },
    });
  });

  it("reads a three-decimal currency by its own exponent", () => {
    const result = readNamedSegment(answer(), { ...grounding, currencyCode: "KWD" });
    if (!result.ok) throw new Error(result.error);
    const condition = result.value.conditions[0];
    if (condition?.field !== "lifetime_spend") throw new Error("wrong field");
    expect(condition.amount).toEqual({ amount: 5_000_000, currencyCode: "KWD" });
  });

  it("refuses an amount with a symbol", () => {
    const result = read(
      answer({ conditions: [{ field: "lifetime_spend", op: "gt", amount: "$5,000" }] }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses an amount sent as a number", () => {
    const result = read(
      answer({ conditions: [{ field: "lifetime_spend", op: "gt", amount: 5000 }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("decimal");
  });

  it("keeps a group name where the id belongs, unresolved", () => {
    const result = read(
      answer({ conditions: [{ field: "group", op: "is", group: "Gold" }] }),
    );
    if (!result.ok) throw new Error(result.error);
    const condition = result.value.conditions[0];
    if (condition?.field !== "group") throw new Error("wrong field");
    expect(condition.groupId).toBe("Gold");
  });

  it("refuses a condition shape this app has never heard of", () => {
    const result = read(
      answer({ conditions: [{ field: "spent_at_competitors", op: "gt", value: 1 }] }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses an answer that fails the same validation a hand-built one does", () => {
    const result = read(answer({ name: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("name_required");
  });

  it("gives Claude names and never ids", () => {
    const prompt = segmentUser("big quiet buyers", grounding);
    expect(prompt).toContain("Gold");
    expect(prompt).not.toContain("grp_gold");
  });
});

describe("resolveSegment", () => {
  const named = (groupTerm: string) => ({
    name: "Gold, quiet",
    conditions: [{ field: "group" as const, op: "is" as const, groupId: groupTerm }],
    notes: null,
  });

  it("turns a name into an id, whatever the case", () => {
    const resolved = resolveSegment(named("gOLd"), grounding);
    const condition = resolved.conditions[0];
    if (condition?.field !== "group") throw new Error("wrong field");
    expect(condition.groupId).toBe("grp_gold");
    expect(resolved.clarifications).toEqual([]);
  });

  it("asks rather than guessing when nothing matches", () => {
    const resolved = resolveSegment(named("Platinum"), grounding);
    expect(resolved.conditions).toEqual([]);
    expect(resolved.clarifications).toHaveLength(1);
    expect(resolved.clarifications[0]?.term).toBe("Platinum");
  });

  it("never leaves an unresolved name in the conditions", () => {
    const resolved = resolveSegment(named("Platinum"), grounding);
    expect(JSON.stringify(resolved.conditions)).not.toContain("Platinum");
  });

  it("applies the merchant's answer and stops asking", () => {
    const resolved = resolveSegment(named("Platinum"), grounding, {
      Platinum: "grp_silver",
    });
    const condition = resolved.conditions[0];
    if (condition?.field !== "group") throw new Error("wrong field");
    expect(condition.groupId).toBe("grp_silver");
    expect(resolved.clarifications).toEqual([]);
  });

  it("ignores an answer naming a group this shop does not have", () => {
    const resolved = resolveSegment(named("Platinum"), grounding, {
      Platinum: "grp_from_another_shop",
    });
    expect(resolved.conditions).toEqual([]);
    expect(resolved.clarifications).toHaveLength(1);
  });

  it("is idempotent once resolved", () => {
    const once = resolveSegment(named("Gold"), grounding);
    const twice = resolveSegment(
      { ...named("Gold"), conditions: once.conditions },
      grounding,
    );
    expect(twice.conditions).toEqual(once.conditions);
    expect(twice.clarifications).toEqual([]);
  });

  it("leaves every other kind of condition alone", () => {
    const resolved = resolveSegment(
      {
        name: "Quiet",
        conditions: [{ field: "last_order_days", op: "gt", value: 45 }],
        notes: null,
      },
      grounding,
    );
    expect(resolved.conditions).toHaveLength(1);
    expect(resolved.clarifications).toEqual([]);
  });
});
