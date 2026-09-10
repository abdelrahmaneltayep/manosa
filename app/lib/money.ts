import {
  currencyExponent,
  formatMoney,
  formatMoneyWithCode,
  money,
  parseMoney,
  type Money,
} from "@mannon/pricing-engine";

/**
 * Money as a person reads it.
 *
 * The engine's `formatMoney` returns bare digits on purpose — that is what goes
 * to Shopify and into a CSV, where a symbol would be wrong. Everything a
 * merchant or a buyer *reads* should go through here instead: "$1,200.50", not
 * "1200.50".
 *
 * `Intl` does the work, so the grouping, the symbol and its placement follow
 * the locale rather than a table we maintain. It is wrapped because a runtime
 * without full ICU throws on an unknown currency, and a total that cannot be
 * formatted must still be readable rather than absent.
 */
export function formatCurrency(value: Money, locale = "en"): string {
  const exponent = exponentOf(value);

  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: value.currencyCode,
    }).format(value.amount / 10 ** exponent);
  } catch {
    // An unknown currency code, or a runtime without the data for it.
    return formatMoneyWithCode(value);
  }
}

/** Minor units per major unit, recovered from the engine's own formatting. */
function exponentOf(value: Money): number {
  const formatted = formatMoney(money(1, value.currencyCode));
  const dot = formatted.indexOf(".");
  return dot < 0 ? 0 : formatted.length - dot - 1;
}

/** Format an integer number of minor units. */
export function formatMinorUnits(
  amount: number,
  currencyCode: string,
  locale = "en",
): string {
  return formatCurrency(money(amount, currencyCode), locale);
}

/**
 * A money amount as Shopify sends it, which is not quite as we store it.
 *
 * `parseMoney` is strict on purpose — extra precision is a rounding decision
 * and it refuses to make one silently — but that strictness is about *our*
 * arithmetic, and Shopify is a boundary. It sends `"5000.00"` for a
 * zero-decimal currency like JPY, which `parseMoney` rejects outright, and the
 * caller then recorded a zero: a ¥5,000 line mirrored as ¥0, with no log.
 *
 * So insignificant trailing zeros are trimmed here and only here. Anything
 * that would actually lose value still fails, loudly.
 */
export function parseShopifyMoney(
  amount: unknown,
  currencyCode: string,
  context: string,
): Money {
  const text =
    (typeof amount === "string" ? amount : String(amount ?? "0")).trim() || "0";
  const exponent = currencyExponent(currencyCode);

  // "5000.00" in JPY is five thousand yen written by a system that assumes two
  // decimal places. "5000.25" in JPY is a number we do not understand, and it
  // is not this function's job to guess.
  const trimmed = exponent === 0 ? text.replace(/\.0+$/u, "") : text;

  try {
    return parseMoney(trimmed, currencyCode);
  } catch (error) {
    // Never a silent zero. A line mirrored at nothing is revenue the merchant
    // never sees, on every chart, with nothing to explain it.
    console.error(
      `[mannon] could not read "${text}" as ${currencyCode} (${context}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return money(0, currencyCode);
  }
}
