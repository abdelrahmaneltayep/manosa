import { describe, expect, it } from "vitest";

import {
  addMoney,
  compareMoney,
  currencyExponent,
  formatMoney,
  money,
  MoneyError,
  multiplyMoney,
  parseMoney,
  roundMinorUnits,
  subtractMoney,
} from "../src/money";

describe("parsing and formatting", () => {
  it("round-trips two-decimal currencies", () => {
    for (const value of ["0.00", "0.01", "9.99", "10.00", "1234.56"]) {
      expect(formatMoney(parseMoney(value, "USD"))).toBe(value);
    }
  });

  it("handles currencies with no minor unit", () => {
    expect(currencyExponent("JPY")).toBe(0);
    const yen = parseMoney("1250", "JPY");
    expect(yen.amount).toBe(1250);
    expect(formatMoney(yen)).toBe("1250");
  });

  it("handles three-decimal currencies", () => {
    expect(currencyExponent("KWD")).toBe(3);
    const dinar = parseMoney("12.345", "KWD");
    expect(dinar.amount).toBe(12345);
    expect(formatMoney(dinar)).toBe("12.345");
  });

  it("pads a short fraction rather than misreading it", () => {
    // "10.5" USD is ten dollars fifty, not ten dollars five cents.
    expect(parseMoney("10.5", "USD").amount).toBe(1050);
  });

  /**
   * Truncating here would be a rounding decision buried in a parser — the exact
   * place a money bug survives review.
   */
  it("refuses more precision than the currency has", () => {
    expect(() => parseMoney("10.005", "USD")).toThrow(MoneyError);
    expect(() => parseMoney("10.5", "JPY")).toThrow(MoneyError);
  });

  /**
   * Trailing zeros are formatting, not precision — and refusing them broke
   * every zero-decimal-currency store.
   *
   * Shopify serialises `MoneyV2.amount` with a decimal point whatever the
   * currency, so a JPY cart line arrives as "1000.0". That threw, the discount
   * Function caught it and returned no operations, and every wholesale buyer
   * in that store paid retail, silently, for ever. Nothing is rounded away
   * here: "1000.0" JPY is exactly 1000 yen.
   */
  it("accepts trailing zeros past the currency's exponent", () => {
    expect(parseMoney("1000.0", "JPY").amount).toBe(1000);
    expect(parseMoney("1000.00", "JPY").amount).toBe(1000);
    expect(parseMoney("10.500", "USD").amount).toBe(1050);
    expect(parseMoney("10.5000000", "USD").amount).toBe(1050);
    expect(parseMoney("0.0", "KRW").amount).toBe(0);
    // A three-decimal currency keeps all three, and drops only the padding.
    expect(parseMoney("10.5000", "BHD").amount).toBe(10500);
  });

  it("still refuses a significant digit past the exponent", () => {
    // The zero is not trailing — it is followed by a 5.
    expect(() => parseMoney("10.0050", "USD")).toThrow(MoneyError);
    expect(() => parseMoney("1000.10", "JPY")).toThrow(MoneyError);
    expect(() => parseMoney("1000.01", "JPY")).toThrow(MoneyError);
  });

  it("keeps a zero that is inside the exponent", () => {
    // "10.050" is ten dollars five cents, not fifty.
    expect(parseMoney("10.050", "USD").amount).toBe(1005);
    expect(parseMoney("10.05", "USD").amount).toBe(1005);
  });

  it("rejects anything that is not a decimal amount", () => {
    for (const bad of ["", "abc", "1.2.3", "1,000.00", "$10", "1e3", " "]) {
      expect(() => parseMoney(bad, "USD"), bad).toThrow(MoneyError);
    }
  });

  it("normalises the currency code", () => {
    expect(parseMoney("1.00", "usd").currencyCode).toBe("USD");
  });

  it("formats amounts below one unit", () => {
    expect(formatMoney(money(7, "USD"))).toBe("0.07");
    expect(formatMoney(money(0, "USD"))).toBe("0.00");
  });
});

describe("arithmetic", () => {
  it("refuses fractional minor units", () => {
    expect(() => money(10.5, "USD")).toThrow(MoneyError);
  });

  it("adds and subtracts exactly", () => {
    const a = parseMoney("0.10", "USD");
    const b = parseMoney("0.20", "USD");
    // The sum that famously is not 0.3 in floating point.
    expect(formatMoney(addMoney(a, b))).toBe("0.30");
    expect(formatMoney(subtractMoney(b, a))).toBe("0.10");
  });

  it("multiplies by a quantity", () => {
    expect(formatMoney(multiplyMoney(parseMoney("8.80", "USD"), 20))).toBe("176.00");
  });

  it("refuses to multiply by a fraction, which would hide a rounding choice", () => {
    expect(() => multiplyMoney(parseMoney("10.00", "USD"), 0.5)).toThrow(MoneyError);
  });

  /**
   * Converting between currencies means inventing a rate. The engine never
   * does it, so the arithmetic refuses to let it happen by accident.
   */
  it("refuses to mix currencies", () => {
    const usd = parseMoney("10.00", "USD");
    const eur = parseMoney("10.00", "EUR");
    expect(() => addMoney(usd, eur)).toThrow(/never converts/);
    expect(() => subtractMoney(usd, eur)).toThrow(MoneyError);
    expect(() => compareMoney(usd, eur)).toThrow(MoneyError);
  });
});

describe("rounding", () => {
  it("rounds half up by default", () => {
    expect(roundMinorUnits(666.5)).toBe(667);
    expect(roundMinorUnits(666.4)).toBe(666);
    expect(roundMinorUnits(666.6)).toBe(667);
  });

  it("rounds half to even when asked", () => {
    expect(roundMinorUnits(666.5, "half_even")).toBe(666);
    expect(roundMinorUnits(667.5, "half_even")).toBe(668);
    expect(roundMinorUnits(666.4, "half_even")).toBe(666);
  });

  it("supports always-down and always-up", () => {
    expect(roundMinorUnits(666.9, "down")).toBe(666);
    expect(roundMinorUnits(666.1, "up")).toBe(667);
  });

  it("does not drift toward positive infinity on negatives", () => {
    // Math.round(-0.5) is -0, which is the trap this helper avoids.
    expect(roundMinorUnits(-666.5)).toBe(-667);
  });
});
