import { describe, expect, it } from "vitest";

import { parseCsv } from "~/lib/pricing/csv/parse";
import { planImport, skusIn, type PlanContext } from "~/lib/pricing/csv/plan";
import { detectTemplate } from "~/lib/pricing/csv/templates";

const context = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  currencyCode: "USD",
  skuToVariantId: new Map([["ABC-1", "gid://shopify/ProductVariant/1"]]),
  existingNames: new Set(),
  now: new Date("2026-06-15T12:00:00Z"),
  ...overrides,
});

const RULES_HEADER =
  "rule_name,type,value,applies_to,skus,customer_tags,status,priority,combinable,starts_at,ends_at";
const BREAKS_HEADER =
  "rule_name,applies_to,skus,customer_tags,min_quantity,max_quantity,discount_type,discount_value,status,priority";

const plan = (csv: string, ctx = context()) => {
  const doc = parseCsv(csv);
  return planImport(doc, detectTemplate(doc.headers)!, ctx);
};

describe("recognising a file", () => {
  it("tells the two templates apart from their columns", () => {
    expect(detectTemplate(parseCsv(`${RULES_HEADER}\n`).headers)).toBe("rules");
    expect(detectTemplate(parseCsv(`${BREAKS_HEADER}\n`).headers)).toBe(
      "quantity_breaks",
    );
  });

  it("recognises neither when the columns are something else", () => {
    expect(detectTemplate(["product", "cost"])).toBeNull();
  });
});

describe("planning a rules file", () => {
  it("plans a valid row", () => {
    const result = plan(
      `${RULES_HEADER}\nWholesale 35%,percentage,35,all,,wholesale,active,100,no,,\n`,
    );

    expect(result.errors).toEqual([]);
    expect(result.planned).toHaveLength(1);
    expect(result.planned[0]!.rule).toMatchObject({
      name: "Wholesale 35%",
      kind: "percentage",
      status: "active",
      value: { percentage: 35 },
      audience: { mode: "tags", tags: ["wholesale"] },
    });
  });

  it("accepts the spellings merchants actually type", () => {
    const result = plan(
      `${RULES_HEADER}\nA,Percent,10,all,,wholesale,ACTIVE,100,YES,,\n` +
        `B,custom price,8.00,all,,wholesale,draft,100,y,,\n`,
    );
    expect(result.errors).toEqual([]);
    expect(result.planned[0]!.rule.combinable).toBe(true);
    expect(result.planned[1]!.rule.kind).toBe("fixed_price");
  });

  it("defaults to draft, so an import never silently changes prices", () => {
    const result = plan(`${RULES_HEADER}\nA,percentage,10,all,,wholesale,,,,,\n`);
    expect(result.planned[0]!.rule.status).toBe("draft");
  });

  it("resolves SKUs to variants", () => {
    const result = plan(
      `${RULES_HEADER}\nContract,fixed_price,8.00,skus,ABC-1,wholesale,draft,50,no,,\n`,
    );
    expect(result.planned[0]!.rule.targets).toEqual({
      mode: "variants",
      variantIds: ["gid://shopify/ProductVariant/1"],
    });
  });

  /** A dropped SKU is a price that quietly does not apply. */
  it("lists an unknown SKU rather than skipping it", () => {
    const result = plan(
      `${RULES_HEADER}\nContract,fixed_price,8.00,skus,NOPE-9,wholesale,draft,50,no,,\n`,
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        line: 2,
        code: "unknown_sku",
        params: { sku: "NOPE-9" },
      }),
    );
  });

  it("reports a bad type, number, money and date with the line", () => {
    const result = plan(
      `${RULES_HEADER}\n` +
        `A,mystery,10,all,,wholesale,draft,100,no,,\n` +
        `B,percentage,10,all,,wholesale,draft,abc,no,,\n` +
        `C,fixed_price,eight,all,,wholesale,draft,100,no,,\n` +
        `D,percentage,10,all,,wholesale,draft,100,no,not-a-date,\n`,
    );

    const codes = result.errors.map((issue) => `${issue.line}:${issue.code}`);
    expect(codes).toContain("2:unknown_type");
    expect(codes).toContain("3:bad_number");
    expect(codes).toContain("4:bad_money");
    expect(codes).toContain("5:bad_date");
  });

  it("requires a name", () => {
    const result = plan(
      `${RULES_HEADER}\n,percentage,10,all,,wholesale,draft,100,no,,\n`,
    );
    expect(result.errors[0]).toMatchObject({
      line: 2,
      column: "rule_name",
      code: "missing_required",
    });
    expect(result.planned).toEqual([]);
  });

  it("refuses a rule the engine would reject, naming the reason", () => {
    const result = plan(
      `${RULES_HEADER}\nA,percentage,150,all,,wholesale,draft,100,no,,\n`,
    );
    expect(result.errors[0]).toMatchObject({
      code: "invalid_rule",
      params: expect.objectContaining({ issue: "percentage_out_of_range" }),
    });
  });

  /** Free samples and placeholders are real; a zero is not automatically wrong. */
  it("treats a value of zero as a warning, not an error", () => {
    const result = plan(
      `${RULES_HEADER}\nA,percentage,0,all,,wholesale,draft,100,no,,\n`,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "zero_value" }),
    );
    expect(result.planned).toHaveLength(1);
  });

  it("warns when a name repeats in the file, and imports both", () => {
    const result = plan(
      `${RULES_HEADER}\nSame,percentage,10,all,,wholesale,draft,100,no,,\n` +
        `Same,percentage,20,all,,wholesale,draft,100,no,,\n`,
    );
    expect(result.planned).toHaveLength(2);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "duplicate_name", params: { name: "Same" } }),
    );
  });

  it("warns when a name is already in use", () => {
    const result = plan(
      `${RULES_HEADER}\nGold,percentage,10,all,,wholesale,draft,100,no,,\n`,
      context({ existingNames: new Set(["gold"]) }),
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "existing_name", params: { name: "Gold" } }),
    );
  });

  it("keeps the good rows when one is broken", () => {
    const result = plan(
      `${RULES_HEADER}\nGood,percentage,10,all,,wholesale,draft,100,no,,\n` +
        `Bad,mystery,10,all,,wholesale,draft,100,no,,\n` +
        `Also good,percentage,20,all,,wholesale,draft,100,no,,\n`,
    );
    expect(result.planned.map((item) => item.rule.name)).toEqual(["Good", "Also good"]);
    expect(result.errors).toHaveLength(1);
  });

  it("warns about a ragged row rather than silently shifting columns", () => {
    const result = plan(`${RULES_HEADER}\nShort,percentage,10\n`);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ line: 2, code: "ragged_row" }),
    );
  });
});

describe("planning a quantity-breaks file", () => {
  it("merges rows sharing a name into one rule with several breaks", () => {
    const result = plan(
      `${BREAKS_HEADER}\n` +
        `Gold tiers,all,,wholesale,5,19,percentage,5,active,100\n` +
        `Gold tiers,all,,wholesale,20,,percentage,12,active,100\n`,
    );

    expect(result.errors).toEqual([]);
    expect(result.planned).toHaveLength(1);
    const rule = result.planned[0]!.rule;
    expect(rule.kind).toBe("volume_tier");
    expect(rule.value).toEqual({
      tiers: [
        { minQuantity: 5, maxQuantity: 19, kind: "percentage", percentage: 5 },
        { minQuantity: 20, maxQuantity: null, kind: "percentage", percentage: 12 },
      ],
    });
    // Both lines are cited, so the report can point back at the file.
    expect(result.planned[0]!.lines).toEqual([2, 3]);
  });

  it("sorts breaks by quantity however they were typed", () => {
    const result = plan(
      `${BREAKS_HEADER}\n` +
        `Gold,all,,wholesale,20,,percentage,12,draft,100\n` +
        `Gold,all,,wholesale,5,19,percentage,5,draft,100\n`,
    );
    expect(result.planned[0]!.rule.value).toMatchObject({
      tiers: [
        expect.objectContaining({ minQuantity: 5 }),
        expect.objectContaining({ minQuantity: 20 }),
      ],
    });
  });

  /** A spreadsheet edit that repeats a quantity usually means the later one. */
  it("takes the last row when a quantity repeats, and says so", () => {
    const result = plan(
      `${BREAKS_HEADER}\n` +
        `Gold,all,,wholesale,5,19,percentage,5,draft,100\n` +
        `Gold,all,,wholesale,5,19,percentage,8,draft,100\n`,
    );

    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "last_wins",
        params: expect.objectContaining({ quantity: 5 }),
      }),
    );
    expect(result.planned[0]!.rule.value).toEqual({
      tiers: [{ minQuantity: 5, maxQuantity: 19, kind: "percentage", percentage: 8 }],
    });
  });

  it("refuses overlapping breaks, with the ranges named", () => {
    const result = plan(
      `${BREAKS_HEADER}\n` +
        `Gold,all,,wholesale,10,49,percentage,5,draft,100\n` +
        `Gold,all,,wholesale,40,60,percentage,12,draft,100\n`,
    );

    expect(result.planned).toEqual([]);
    expect(result.errors[0]).toMatchObject({
      code: "invalid_rule",
      params: expect.objectContaining({
        issue: "tier_overlap",
        first: "10–49",
        second: "40–60",
      }),
    });
  });

  it("supports a flat case price as a break", () => {
    const result = plan(
      `${BREAKS_HEADER}\nCase,all,,wholesale,24,,fixed_price,6.50,draft,100\n`,
    );
    expect(result.planned[0]!.rule.value).toEqual({
      tiers: [
        {
          minQuantity: 24,
          maxQuantity: null,
          kind: "fixed_price",
          amount: { amount: 650, currencyCode: "USD" },
        },
      ],
    });
  });
});

describe("collecting SKUs", () => {
  it("gathers every SKU once, so lookup is one round trip", () => {
    const doc = parseCsv(
      `${RULES_HEADER}\n` +
        `A,fixed_price,8.00,skus,ABC-1;ABC-2,wholesale,draft,100,no,,\n` +
        `B,fixed_price,9.00,skus,ABC-1,wholesale,draft,100,no,,\n`,
    );
    expect(skusIn(doc).sort()).toEqual(["ABC-1", "ABC-2"]);
  });
});
