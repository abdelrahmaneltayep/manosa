import { money, zero } from "@mannon/pricing-engine";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_METHOD_NAME,
  deserializeBuyerTerms,
  deserializeSettings,
  publishedFrom,
  serializeSettings,
  sourceFrom,
  TERMS_FORMAT_VERSION,
  termsFromPublished,
} from "../src/codec";

const usd = (amount: number) => money(amount, "USD");

describe("settings", () => {
  it("round-trips", () => {
    const settings = serializeSettings({
      methodName: "Invoice me",
      overdueBlocks: false,
    });
    expect(deserializeSettings(JSON.stringify(settings))).toEqual(settings);
  });

  it("falls back to the defaults for anything unreadable", () => {
    // A payment Function that crashes takes the store's checkout with it.
    for (const value of [null, undefined, "not json", "[]", "{}", 42, { v: 99 }]) {
      expect(deserializeSettings(value).methodName).toBe(DEFAULT_METHOD_NAME);
    }
  });

  it("refuses a newer format rather than guessing at it", () => {
    expect(deserializeSettings({ v: TERMS_FORMAT_VERSION + 1, methodName: "X" })).toEqual(
      serializeSettings(),
    );
  });

  it("ignores an empty method name", () => {
    expect(deserializeSettings({ v: 1, methodName: "   " }).methodName).toBe(
      DEFAULT_METHOD_NAME,
    );
  });
});

describe("buyer terms", () => {
  it("round-trips through the metafield", () => {
    const published = publishedFrom(
      { days: 30, creditLimit: usd(500000), source: "group" },
      usd(120000),
      1,
    );
    const read = deserializeBuyerTerms(JSON.stringify(published));

    expect(read).toEqual(published);
    expect(termsFromPublished(read!)).toMatchObject({
      days: 30,
      creditLimit: usd(500000),
    });
  });

  it("returns null — meaning no terms — for anything unreadable", () => {
    // Failing towards *not* extending credit is the right direction.
    for (const value of [null, "not json", "[]", {}, { days: 0 }, { days: "soon" }]) {
      expect(deserializeBuyerTerms(value)).toBeNull();
    }
  });

  it("returns null when the currency is missing or malformed", () => {
    expect(deserializeBuyerTerms({ days: 30, currencyCode: "DOLLARS" })).toBeNull();
    expect(deserializeBuyerTerms({ days: 30 })).toBeNull();
  });

  it("counts an unreadable balance as nothing owed, not as a block", () => {
    const read = deserializeBuyerTerms({
      days: 30,
      currencyCode: "usd",
      outstanding: "lots",
      overdueCount: null,
    });

    expect(read).toMatchObject({ outstanding: 0, overdueCount: 0, currencyCode: "USD" });
  });

  it("carries no credit limit through as no ceiling", () => {
    const published = publishedFrom(
      { days: 30, creditLimit: null, source: "customer" },
      zero("USD"),
      0,
    );
    expect(published.creditLimit).toBeNull();
    expect(termsFromPublished(published).creditLimit).toBeNull();
  });
});

describe("sourceFrom", () => {
  it("is null when a level sets nothing at all", () => {
    expect(sourceFrom(null, null)).toBeNull();
    expect(sourceFrom(30, null)).toEqual({ days: 30, creditLimit: null });
    expect(sourceFrom(null, 50000)).toEqual({ days: null, creditLimit: 50000 });
  });
});
