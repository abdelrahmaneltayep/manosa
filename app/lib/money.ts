import {
  formatMoney,
  formatMoneyWithCode,
  money,
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
