import { describe, expect, it } from "vitest";

import { decode, encode, isReadableText } from "~/lib/orders/po-envelope.server";
import type { PoEnvelope } from "~/lib/orders/po-envelope.server";

/**
 * The hidden field that carries a half-finished purchase order.
 *
 * It is a form field, so it is merchant-editable, so everything in it is
 * untrusted — including the parts Claude originally wrote. These are the
 * checks that stand between a hand-edited quantity and a real draft order.
 */

const envelope = (overrides: Partial<PoEnvelope> = {}): PoEnvelope => ({
  buyerId: "c1",
  reference: "PO-4417",
  notes: null,
  lines: [
    { sku: "MUG-BL-L", description: "Blue mug", quantity: 200, statedPrice: "4.00" },
  ],
  chosen: {},
  model: "claude-sonnet-4-5",
  promptVersion: "po/1",
  requestId: "req_1",
  ...overrides,
});

const oneLine = (quantity: number) =>
  JSON.stringify(
    envelope({
      lines: [{ sku: "MUG", description: null, quantity, statedPrice: null }],
    }),
  );

describe("the round trip", () => {
  it("comes back as it went out", () => {
    expect(decode(encode(envelope()))).toEqual(envelope());
  });

  it("drops a chosen entry that is not a variant id", () => {
    const decoded = decode(
      JSON.stringify({ ...envelope(), chosen: { "0": "", "1": 7, "2": "gid://v/2" } }),
    );
    expect(decoded?.chosen).toEqual({ "2": "gid://v/2" });
  });
});

describe("what it refuses", () => {
  it("refuses a negative quantity", () => {
    expect(decode(oneLine(-5))).toBeNull();
  });

  it("refuses a fractional quantity", () => {
    expect(decode(oneLine(2.5))).toBeNull();
  });

  it("refuses a quantity of zero", () => {
    expect(decode(oneLine(0))).toBeNull();
  });

  it("refuses an envelope with no provenance", () => {
    expect(decode(JSON.stringify({ ...envelope(), model: "" }))).toBeNull();
  });

  it("refuses an envelope with no lines", () => {
    expect(decode(JSON.stringify({ ...envelope(), lines: [] }))).toBeNull();
  });

  it("refuses anything that is not an object", () => {
    expect(decode("null")).toBeNull();
    expect(decode('"a string"')).toBeNull();
    expect(decode("not json at all")).toBeNull();
    expect(decode("")).toBeNull();
  });
});

describe("telling text from bytes", () => {
  it("accepts what a purchase order actually looks like", () => {
    expect(isReadableText("SKU,QTY\nMUG-BL-L,200\n")).toBe(true);
    expect(isReadableText("200 x Blue mug (MUG-BL-L) @ 4.00 GBP")).toBe(true);
    expect(isReadableText("")).toBe(true);
  });

  it("refuses a PDF and a zip-backed spreadsheet", () => {
    expect(isReadableText("%PDF-1.7")).toBe(false);
    expect(isReadableText("PK ")).toBe(false);
  });

  it("refuses bytes that are mostly unprintable", () => {
    const noise = Array.from({ length: 200 }, (_, index) =>
      String.fromCharCode(index % 26),
    ).join("");
    expect(isReadableText(noise)).toBe(false);
  });
});
