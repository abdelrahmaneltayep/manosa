/**
 * Money, exactly.
 *
 * Prices are integer **minor units** (cents, fils, yen) plus a currency code.
 * No price arithmetic anywhere in this package touches a floating-point value,
 * because `0.1 + 0.2` is the kind of bug that shows up as a merchant emailing
 * about a one-cent discrepancy six months after launch.
 */

export interface Money {
  /** Whole minor units. 12.50 USD is 1250; 1250 JPY is 1250. */
  readonly amount: number;
  readonly currencyCode: string;
}

/**
 * Currencies whose minor unit is not two decimal places. Anything not listed
 * uses two, which is right for the large majority.
 */
const EXPONENTS: Readonly<Record<string, number>> = {
  BHD: 3,
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  IQD: 3,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

export function currencyExponent(currencyCode: string): number {
  return EXPONENTS[currencyCode.toUpperCase()] ?? 2;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function money(amount: number, currencyCode: string): Money {
  if (!Number.isSafeInteger(amount)) {
    throw new MoneyError(
      `Money must be whole minor units, got ${amount} ${currencyCode}. ` +
        `Use parseMoney("12.50", "USD") to build one from a decimal string.`,
    );
  }
  return { amount, currencyCode: currencyCode.toUpperCase() };
}

export function zero(currencyCode: string): Money {
  return money(0, currencyCode);
}

/** Parse a decimal string — the form Shopify's API uses — into minor units. */
export function parseMoney(value: string, currencyCode: string): Money {
  const trimmed = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new MoneyError(`"${value}" is not a decimal amount`);
  }

  const [, sign, whole, fraction = ""] = match;
  const exponent = currencyExponent(currencyCode);

  if (fraction.length > exponent) {
    // Silently truncating here would be a rounding decision hidden inside a
    // parser, which is exactly where a money bug goes unnoticed.
    throw new MoneyError(
      `"${value}" has more precision than ${currencyCode.toUpperCase()} allows ` +
        `(${exponent} decimal place${exponent === 1 ? "" : "s"}). Round before parsing.`,
    );
  }

  const padded = fraction.padEnd(exponent, "0");
  const minor = Number(`${whole}${padded}`);
  if (!Number.isSafeInteger(minor)) {
    throw new MoneyError(`"${value}" ${currencyCode} is too large to represent exactly`);
  }

  return money(sign === "-" ? -minor : minor, currencyCode);
}

/** Format as a decimal string. The inverse of `parseMoney`. */
export function formatMoney(value: Money): string {
  const exponent = currencyExponent(value.currencyCode);
  const negative = value.amount < 0;
  const digits = Math.abs(value.amount)
    .toString()
    .padStart(exponent + 1, "0");

  if (exponent === 0) return `${negative ? "-" : ""}${digits}`;

  const whole = digits.slice(0, -exponent);
  const fraction = digits.slice(-exponent);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Money with its currency named, for somewhere `Intl` is not available.
 *
 * `formatMoney` deliberately returns bare digits: it is what goes on the wire
 * to Shopify and into a CSV, where a symbol would be wrong. But a *buyer*
 * reading "add 38.00 to reach your 200.00 minimum" is being told a number with
 * no unit.
 *
 * Shopify Functions run on a JavaScript runtime without full ICU, so this is
 * the honest formatting available there: the ISO code, which is never wrong in
 * any locale. Anywhere with `Intl` — the admin, the server — should use
 * `formatCurrency` in `app/lib/money.ts` instead, which produces "$1,200.50".
 */
export function formatMoneyWithCode(value: Money): string {
  return `${value.currencyCode} ${formatMoney(value)}`;
}

function assertSameCurrency(a: Money, b: Money, operation: string): void {
  if (a.currencyCode !== b.currencyCode) {
    throw new MoneyError(
      `Cannot ${operation} ${a.currencyCode} and ${b.currencyCode}. ` +
        `This package never converts between currencies — it would have to invent a rate.`,
    );
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "add");
  return money(a.amount + b.amount, a.currencyCode);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "subtract");
  return money(a.amount - b.amount, a.currencyCode);
}

export function multiplyMoney(value: Money, factor: number): Money {
  if (!Number.isInteger(factor)) {
    throw new MoneyError(
      `multiplyMoney takes a whole factor (a quantity); got ${factor}. ` +
        `For a percentage use applyPercentage, which rounds explicitly.`,
    );
  }
  return money(value.amount * factor, value.currencyCode);
}

export function compareMoney(a: Money, b: Money): number {
  assertSameCurrency(a, b, "compare");
  return a.amount - b.amount;
}

export function isZero(value: Money): boolean {
  return value.amount === 0;
}

export function maxMoney(a: Money, b: Money): Money {
  return compareMoney(a, b) >= 0 ? a : b;
}

export type RoundingMode = "half_up" | "half_even" | "down" | "up";

/**
 * Round a fractional minor-unit amount to a whole one.
 *
 * `half_up` is the default because it is what commercial pricing conventionally
 * uses and what a merchant checking the arithmetic by hand expects. It is a
 * setting rather than a constant because Settings exposes multi-currency
 * rounding (spec §8), and because half-even matters to anyone reconciling
 * large volumes.
 */
export function roundMinorUnits(value: number, mode: RoundingMode = "half_up"): number {
  switch (mode) {
    case "down":
      return Math.floor(value);
    case "up":
      return Math.ceil(value);
    case "half_even": {
      const floor = Math.floor(value);
      const diff = value - floor;
      if (diff > 0.5) return floor + 1;
      if (diff < 0.5) return floor;
      return floor % 2 === 0 ? floor : floor + 1;
    }
    case "half_up":
    default:
      // Math.round breaks ties toward +Infinity, which is wrong for negatives;
      // prices are never negative here, but the helper should not be a trap.
      return value < 0 ? -Math.round(-value) : Math.round(value);
  }
}
