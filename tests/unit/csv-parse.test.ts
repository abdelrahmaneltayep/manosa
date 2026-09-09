import { describe, expect, it } from "vitest";

import {
  CsvParseError,
  normalizeHeader,
  parseCsv,
  toCsv,
  toCsvValue,
} from "~/lib/pricing/csv/parse";

/**
 * Merchant spreadsheets are the messiest input this app takes. Every case here
 * is one a real export produces.
 */
describe("reading a CSV", () => {
  it("reads a plain file", () => {
    const doc = parseCsv("sku,price\nABC-1,8.00\nABC-2,9.50\n");
    expect(doc.headers).toEqual(["sku", "price"]);
    expect(doc.rows).toHaveLength(2);
    expect(doc.rows[0]!.cells).toEqual({ sku: "ABC-1", price: "8.00" });
  });

  it("reports the original line number, for error messages", () => {
    const doc = parseCsv("sku\nA\nB\n");
    expect(doc.rows.map((row) => row.line)).toEqual([2, 3]);
  });

  it("handles Windows line endings", () => {
    const doc = parseCsv("sku,price\r\nABC-1,8.00\r\n");
    expect(doc.rows[0]!.cells.price).toBe("8.00");
  });

  /** Excel writes one, and it would otherwise become part of the first header. */
  it("strips the byte-order mark Excel adds", () => {
    const doc = parseCsv("﻿sku,price\nABC-1,8.00\n");
    expect(doc.headers).toEqual(["sku", "price"]);
  });

  it("keeps commas inside quoted values", () => {
    const doc = parseCsv('name,price\n"Beans, 1kg",8.00\n');
    expect(doc.rows[0]!.cells.name).toBe("Beans, 1kg");
  });

  it("keeps newlines inside quoted values, and still counts lines after them", () => {
    const doc = parseCsv('name,sku\n"Two\nlines",ABC-1\nSecond,ABC-2\n');
    expect(doc.rows[0]!.cells.name).toBe("Two\nlines");
    expect(doc.rows[1]!.cells.sku).toBe("ABC-2");
    expect(doc.rows[1]!.line).toBe(4);
  });

  it("unescapes doubled quotes", () => {
    const doc = parseCsv('name\n"He said ""hi"""\n');
    expect(doc.rows[0]!.cells.name).toBe('He said "hi"');
  });

  it("tolerates a stray quote inside an unquoted value", () => {
    // Excel produces these; refusing the whole file would be unhelpful.
    const doc = parseCsv('name\n12" pipe\n');
    expect(doc.rows[0]!.cells.name).toBe('12" pipe');
  });

  it("skips blank lines rather than calling them errors", () => {
    const doc = parseCsv("sku\nABC-1\n\n\nABC-2\n");
    expect(doc.rows.map((row) => row.cells.sku)).toEqual(["ABC-1", "ABC-2"]);
  });

  it("does not invent a row from the trailing newline", () => {
    expect(parseCsv("sku\nABC-1\n").rows).toHaveLength(1);
    expect(parseCsv("sku\nABC-1").rows).toHaveLength(1);
  });

  it("reports ragged rows instead of silently shifting the columns", () => {
    const doc = parseCsv("sku,price,tag\nABC-1,8.00\nABC-2,9.00,gold,extra\n");
    expect(doc.raggedLines).toEqual([2, 3]);
    // Missing cells read as empty rather than as the next column's value.
    expect(doc.rows[0]!.cells.tag).toBe("");
  });

  it("trims cells, because spreadsheets pad them", () => {
    const doc = parseCsv("sku , price\n ABC-1 , 8.00 \n");
    expect(doc.rows[0]!.cells.sku).toBe("ABC-1");
    expect(doc.rows[0]!.cells.price).toBe("8.00");
  });

  it("normalises header names, because merchants title them differently", () => {
    expect(normalizeHeader(" Min Quantity ")).toBe("min_quantity");
    expect(normalizeHeader("Customer-Tag")).toBe("customer_tag");
    expect(normalizeHeader("﻿SKU")).toBe("sku");
  });

  it("refuses an empty file with a reason", () => {
    expect(() => parseCsv("")).toThrow(CsvParseError);
    expect(() => parseCsv("   \n")).toThrow(/empty/);
  });

  it("refuses a file that ends inside a quote, naming the row", () => {
    expect(() => parseCsv('name\n"unclosed\n')).toThrow(/unclosed/i);
  });
});

describe("writing a CSV", () => {
  it("quotes only what needs it", () => {
    expect(toCsvValue("plain")).toBe("plain");
    expect(toCsvValue("has,comma")).toBe('"has,comma"');
    expect(toCsvValue('has"quote')).toBe('"has""quote"');
    expect(toCsvValue("has\nnewline")).toBe('"has\nnewline"');
    expect(toCsvValue(null)).toBe("");
  });

  it("round-trips through the reader", () => {
    const csv = toCsv(
      ["sku", "name", "price"],
      [
        ["ABC-1", "Beans, 1kg", "8.00"],
        ["ABC-2", 'He said "hi"', "9.50"],
      ],
    );

    const doc = parseCsv(csv);
    expect(doc.rows[0]!.cells.name).toBe("Beans, 1kg");
    expect(doc.rows[1]!.cells.name).toBe('He said "hi"');
  });
});
