import { describe, expect, it } from "vitest";

import {
  MAX_LINES,
  MAX_QUANTITY,
  parsePasteList,
  wasTruncated,
} from "~/lib/storefront/paste-list";

/**
 * What a wholesale buyer actually pastes.
 *
 * Not a clean list — a column out of a spreadsheet, or the body of a purchase
 * order. These cases are the shapes that arrive, and the rule underneath all of
 * them is that nothing is dropped silently.
 */

describe("separators", () => {
  it("reads commas, tabs and semicolons", () => {
    for (const sep of [",", "\t", ";"]) {
      const result = parsePasteList(`ABC-123${sep}12`);
      expect(result.lines).toEqual([
        { lineNumber: 1, raw: `ABC-123${sep}12`, sku: "ABC-123", quantity: 12 },
      ]);
    }
  });

  it("reads a space-separated line where the quantity is last", () => {
    expect(parsePasteList("ABC-123 12").lines[0]).toMatchObject({
      sku: "ABC-123",
      quantity: 12,
    });
  });

  it("does not mistake a SKU with spaces in it for a quantity", () => {
    expect(parsePasteList("BLUE MUG LARGE").lines[0]).toMatchObject({
      sku: "BLUE MUG LARGE",
      quantity: 1,
    });
  });

  it("reads the quantity first, with or without an x", () => {
    expect(parsePasteList("12, ABC-123").lines[0]).toMatchObject({
      sku: "ABC-123",
      quantity: 12,
    });
    expect(parsePasteList("12, x ABC-123").lines[0]).toMatchObject({
      sku: "ABC-123",
      quantity: 12,
    });
  });

  it("reads a thousands separator inside a quantity", () => {
    expect(parsePasteList("ABC-123\t1,200").lines[0]?.quantity).toBe(1200);
  });
});

describe("what gets skipped and what gets reported", () => {
  it("skips blank lines without complaining", () => {
    const result = parsePasteList("ABC-123,1\n\n   \nDEF-456,2");
    expect(result.lines).toHaveLength(2);
    expect(result.issues).toHaveLength(0);
  });

  it("skips a spreadsheet header row", () => {
    // A buyer who pasted their first row did not make a mistake worth a red
    // line against it.
    const result = parsePasteList("SKU,Quantity\nABC-123,12");
    expect(result.lines).toHaveLength(1);
    expect(result.issues).toHaveLength(0);
  });

  it("does not mistake a real product line for a header", () => {
    const result = parsePasteList("SKU,12");
    expect(result.lines[0]).toMatchObject({ sku: "SKU", quantity: 12 });
  });

  it("reports a quantity that is not a number, on the right line", () => {
    const result = parsePasteList("ABC-123,12\nDEF-456,a dozen");
    expect(result.lines).toHaveLength(1);
    expect(result.issues).toEqual([
      {
        lineNumber: 2,
        raw: "DEF-456,a dozen",
        code: "quantity_not_a_number",
        sku: "DEF-456",
      },
    ]);
  });

  it("reports a quantity of zero rather than adding nothing to the cart", () => {
    expect(parsePasteList("ABC-123,0").issues[0]?.code).toBe("no_quantity");
  });

  it("reports an absurd quantity as the typo it almost always is", () => {
    const result = parsePasteList(`ABC-123,${MAX_QUANTITY + 1}`);
    expect(result.issues[0]?.code).toBe("quantity_too_large");
    expect(result.lines).toHaveLength(0);
  });

  it("defaults a bare SKU to one rather than refusing the paste", () => {
    expect(parsePasteList("ABC-123").lines[0]).toMatchObject({
      sku: "ABC-123",
      quantity: 1,
    });
  });

  it("takes a different default when the block asks for one", () => {
    expect(parsePasteList("ABC-123", { defaultQuantity: 12 }).lines[0]?.quantity).toBe(
      12,
    );
  });
});

describe("the same SKU twice", () => {
  it("adds the quantities and says so, rather than letting one win", () => {
    const result = parsePasteList("ABC-123,10\nDEF-456,5\nabc-123,2");

    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toMatchObject({ sku: "ABC-123", quantity: 12 });
    // The buyer is told, because two lines becoming one is a thing they should
    // see before they check out.
    expect(result.issues).toEqual([
      { lineNumber: 3, raw: "abc-123,2", code: "duplicate", sku: "abc-123" },
    ]);
  });
});

describe("size", () => {
  it("stops at the line cap rather than reading a pasted file", () => {
    const text = Array.from({ length: MAX_LINES + 50 }, (_, i) => `SKU-${i},1`).join(
      "\n",
    );
    const result = parsePasteList(text);

    expect(result.lines).toHaveLength(MAX_LINES);
    expect(wasTruncated(text)).toBe(true);
    expect(wasTruncated("ABC-123,1")).toBe(false);
  });

  it("handles a paste that is nothing but whitespace", () => {
    expect(parsePasteList("\n\n  \n")).toEqual({ lines: [], issues: [] });
    expect(parsePasteList("")).toEqual({ lines: [], issues: [] });
  });
});

describe("a real paste", () => {
  it("reads a messy purchase order the way a person would", () => {
    const result = parsePasteList(
      [
        "SKU\tQty",
        "MUG-BL-L\t100",
        "",
        "MUG-BL-S\t50",
        "GRINDER-01",
        "MUG-BL-L\t20",
        "TOTAL\t170",
      ].join("\n"),
    );

    expect(result.lines).toEqual([
      { lineNumber: 2, raw: "MUG-BL-L\t100", sku: "MUG-BL-L", quantity: 120 },
      { lineNumber: 4, raw: "MUG-BL-S\t50", sku: "MUG-BL-S", quantity: 50 },
      { lineNumber: 5, raw: "GRINDER-01", sku: "GRINDER-01", quantity: 1 },
      // "TOTAL 170" is not skipped. It reads as a SKU with a quantity, which
      // is the honest reading of it, and becomes "no such SKU" at lookup where
      // the buyer can see it. Guessing that a line is a summary — and being
      // wrong about a product genuinely called TOTAL — is the worse failure.
      { lineNumber: 7, raw: "TOTAL\t170", sku: "TOTAL", quantity: 170 },
    ]);
    expect(result.issues.map((issue) => issue.code)).toContain("duplicate");
  });
});
