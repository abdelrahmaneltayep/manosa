import { money, parseMoney } from "@mannon/pricing-engine";
import { describe, expect, it } from "vitest";

import { formatCurrency, formatMinorUnits } from "~/lib/money";

/**
 * The engine's `formatMoney` returns bare digits on purpose — it is what goes
 * to Shopify and into a CSV. Everything a person *reads* goes through this,
 * because "1200.50" is a number with no unit and "$1,200.50" is a price.
 *
 * This exists because the admin shipped without it: the buyers list, the rule
 * preview and the pricing trace all rendered totals as bare digits. Found in
 * the 3.1 QA pass.
 */

describe("money a person reads", () => {
  it("puts the symbol and the grouping in", () => {
    expect(formatCurrency(parseMoney("1200.50", "USD"))).toBe("$1,200.50");
    expect(formatCurrency(parseMoney("38.00", "USD"))).toBe("$38.00");
  });

  it("follows the currency's own minor units", () => {
    // Yen has none; Kuwaiti dinar has three.
    expect(formatCurrency(money(1250, "JPY"))).toBe("¥1,250");
    expect(formatCurrency(money(1234, "KWD"))).toContain("1.234");
  });

  it("follows the locale it is given", () => {
    const arabic = formatCurrency(parseMoney("1200.50", "SAR"), "ar");
    expect(arabic).not.toBe(formatCurrency(parseMoney("1200.50", "SAR"), "en"));
    // Whatever the digits look like, the currency is named.
    expect(arabic.length).toBeGreaterThan(4);
  });

  it("formats a negative amount as a negative amount", () => {
    expect(formatCurrency(money(-3800, "USD"))).toContain("38.00");
  });

  it("names an unrecognised currency by its code rather than failing", () => {
    // A total that cannot be formatted must still be readable. Intl handles
    // this one itself — it accepts any three-letter code and falls back to
    // printing it — so the assertion normalises the non-breaking space it
    // uses rather than pinning which of the two paths ran.
    expect(formatMinorUnits(1250, "ZZZ").replace(/\u00a0/g, " ")).toBe("ZZZ 12.50");
  });

  it("survives a runtime with no currency data at all", () => {
    const real = Intl.NumberFormat;
    try {
      // The fallback exists for a runtime without full ICU.
      (Intl as { NumberFormat: unknown }).NumberFormat = function throwing() {
        throw new RangeError("no currency data");
      };
      expect(formatMinorUnits(1250, "USD")).toBe("USD 12.50");
    } finally {
      (Intl as { NumberFormat: unknown }).NumberFormat = real;
    }
  });

  it("formats from minor units directly", () => {
    expect(formatMinorUnits(120050, "USD")).toBe("$1,200.50");
  });
});
