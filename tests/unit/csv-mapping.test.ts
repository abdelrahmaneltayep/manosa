import { describe, expect, it } from "vitest";

import {
  csvMappingUser,
  readMapping,
  toColumnMapping,
  type ColumnGuess,
} from "~/lib/ai/prompts/csv-mapping.server";
import { applyMapping, parseCsv } from "~/lib/pricing/csv/parse";
import { planImport } from "~/lib/pricing/csv/plan";

/**
 * ✦ The CSV whisperer.
 *
 * It maps column *names*. The prices and SKUs in a merchant's file are theirs
 * and are never rewritten — a mapping only renames headers, and the same
 * planner, the same row numbers and the same error report run afterwards.
 */

const MESSY = [
  "Item Code,Discount %,Who gets it,Notes",
  "SKU-1,15,wholesale,spring list",
  "SKU-2,20,wholesale,",
].join("\n");

const doc = () => parseCsv(MESSY);

describe("what the model is shown", () => {
  it("shows the headers and a few values from each", () => {
    const prompt = csvMappingUser(doc(), "rules");

    expect(prompt).toContain("item_code");
    expect(prompt).toContain("SKU-1");
    expect(prompt).toContain("rule_name (required)");
  });

  it("says a column is blank rather than leaving it out", () => {
    const prompt = csvMappingUser(parseCsv("A,B\n1,\n2,"), "rules");
    expect(prompt).toContain("(all blank)");
  });
});

describe("readMapping", () => {
  const answer = (mappings: unknown, notes: unknown = null) => ({ mappings, notes });
  const read = (value: unknown) => readMapping(value, doc(), "rules");

  const good = [
    { header: "item_code", column: "skus", confidence: "high" },
    { header: "discount_%", column: "value", confidence: "high" },
    { header: "who_gets_it", column: "customer_tags", confidence: "medium" },
    { header: "notes", column: null, confidence: "high" },
  ];

  it("reads a good mapping", () => {
    const result = read(answer(good));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mappings).toHaveLength(4);
  });

  it("refuses a column this template does not have", () => {
    const result = read(
      answer([{ header: "item_code", column: "wholesale_price", confidence: "high" }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("wholesale_price");
  });

  it("refuses two headers pointing at one column", () => {
    // Silently dropping a column of the merchant's file is the failure they
    // would not spot until the import was wrong.
    const result = read(
      answer([
        { header: "item_code", column: "skus", confidence: "high" },
        { header: "notes", column: "skus", confidence: "low" },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("skus");
  });

  it("refuses a header that is not in the file", () => {
    const result = read(
      answer([{ header: "product_code", column: "skus", confidence: "high" }]),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses the same header twice", () => {
    const result = read(
      answer([
        { header: "item_code", column: "skus", confidence: "high" },
        { header: "item_code", column: null, confidence: "low" },
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it("fills in a header the model skipped, as ignored", () => {
    const result = read(
      answer([{ header: "item_code", column: "skus", confidence: "high" }]),
    );
    if (!result.ok) throw new Error(result.error);

    expect(result.value.mappings).toHaveLength(4);
    expect(result.value.mappings.find((one) => one.header === "notes")).toEqual({
      header: "notes",
      column: null,
      confidence: "low",
    });
  });

  it("treats an unlabelled guess as a low-confidence one", () => {
    const result = read(
      answer([{ header: "item_code", column: "skus", confidence: "certain" }]),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.mappings[0]?.confidence).toBe("low");
  });

  it("refuses an answer that is not an object", () => {
    expect(read("skus").ok).toBe(false);
    expect(read({ mappings: "skus" }).ok).toBe(false);
  });
});

describe("applyMapping", () => {
  it("renames the columns and leaves the data alone", () => {
    const mapped = applyMapping(doc(), {
      item_code: "skus",
      "discount_%": "value",
      who_gets_it: "customer_tags",
      notes: null,
    });

    expect(mapped.headers).toEqual(["skus", "value", "customer_tags"]);
    expect(mapped.rows[0]?.cells).toEqual({
      skus: "SKU-1",
      value: "15",
      customer_tags: "wholesale",
    });
    // Row numbers survive: the error report points back at the merchant's file.
    expect(mapped.rows[0]?.line).toBe(2);
  });

  it("leaves a header the mapping does not mention", () => {
    const mapped = applyMapping(doc(), { item_code: "skus" });
    expect(mapped.headers).toContain("notes");
  });

  it("keeps a file importable end to end", () => {
    const mapped = applyMapping(
      parseCsv(
        ["Name,Kind,Off,Who", "Spring wholesale,percentage,15,wholesale"].join("\n"),
      ),
      { name: "rule_name", kind: "type", off: "value", who: "customer_tags" },
    );

    const plan = planImport(mapped, "rules", {
      currencyCode: "USD",
      skuToVariantId: new Map(),
      existingNames: new Set(),
      now: new Date("2026-09-10T12:00:00Z"),
    });

    expect(plan.errors).toEqual([]);
    expect(plan.planned).toHaveLength(1);
    expect(plan.planned[0]?.rule.name).toBe("Spring wholesale");
  });
});

describe("toColumnMapping", () => {
  it("turns guesses into the mapping applyMapping takes", () => {
    const guesses: ColumnGuess[] = [
      { header: "item_code", column: "skus", confidence: "high" },
      { header: "notes", column: null, confidence: "low" },
    ];
    expect(toColumnMapping(guesses)).toEqual({ item_code: "skus", notes: null });
  });
});
