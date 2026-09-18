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

  // Trailing zeros past the currency's exponent are formatting, not precision.
  // Shopify serialises `MoneyV2.amount` with a decimal point whatever the
  // currency — a JPY cart line arrives as "1000.0" — and refusing that made
  // every zero-decimal-currency store checkout at retail, silently, for ever.
  // Nothing is rounded away here: "1000.0" JPY is exactly 1000 yen.
  const significant = fraction.replace(/0+$/, "");

  if (significant.length > exponent) {
    // Truncating a *significant* digit would be a rounding decision hidden
    // inside a parser, which is exactly where a money bug goes unnoticed.
    throw new MoneyError(
      `"${value}" has more precision than ${currencyCode.toUpperCase()} allows ` +
        `(${exponent} decimal place${exponent === 1 ? "" : "s"}). Round before parsing.`,
    );
  }

  const padded = fraction.slice(0, exponent).padEnd(exponent, "0");
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

/* -------------------------------------------------------------------------- */
/* Exact fractional minor units                                               */
/* -------------------------------------------------------------------------- */

/**
 * A running price, held exactly, as a fraction of minor units.
 *
 * The line at the top of this file — *"No price arithmetic anywhere in this
 * package touches a floating-point value"* — was not true of the cascade. A
 * percentage rule became `factor = (100 - percentage) / 100` and the running
 * price was multiplied by it in binary floating point. Every case whose exact
 * value lands on a half-cent tie landed just *below* it, and `half_up` — chosen
 * because it is "what a merchant checking the arithmetic by hand expects" —
 * rounded it down.
 *
 * $10.75 with 6% off is the plainest one. Exactly: `1075 × 94 / 100 = 1010.5`,
 * half-up **1011**, $10.11. In float it came out 1010, $10.10. A cent per unit,
 * in the buyer's favour, on every line, for ever: 12,096 wrong answers across
 * whole-number percentages 1–99 against prices $0.01–$2,000.00, every one low.
 *
 * So a percentage is an integer over an integer now — 6% is 9400/10000 — and
 * the fraction is carried exactly to the single rounding at the end.
 */
export interface Fraction {
  /** Numerator, in minor units × `denominator`. */
  readonly numerator: number;
  /** Always ≥ 1. */
  readonly denominator: number;
}

export const wholeUnits = (minorUnits: number): Fraction => ({
  numerator: minorUnits,
  denominator: 1,
});

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y > 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

/** Lowest terms. Keeps the numbers small enough to stay exact. */
export function reduceFraction({ numerator, denominator }: Fraction): Fraction {
  if (denominator === 1) return { numerator, denominator };
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

/**
 * Beyond this a product of two safe integers stops being exact.
 *
 * `Number.MAX_SAFE_INTEGER` is 2^53 − 1. A multiply is only attempted when both
 * the numerator and the denominator stay inside it; past that the fraction is
 * collapsed to whole minor units first, which is the one place in this module
 * precision is deliberately given up. It takes at least four stacked percentage
 * rules on a single line to reach, and `resolve.test.ts` pins that.
 */
const SAFE = Number.MAX_SAFE_INTEGER;

export function subtractFromFraction(value: Fraction, minorUnits: number): Fraction {
  return {
    numerator: value.numerator - minorUnits * value.denominator,
    denominator: value.denominator,
  };
}

/**
 * Multiply by an exact ratio — `9400/10000` for "6% off".
 *
 * `mode` is used only if the fraction has to be collapsed first; in every
 * reachable case it is not.
 */
export function multiplyFraction(
  value: Fraction,
  numerator: number,
  denominator: number,
  mode: RoundingMode = "half_up",
): Fraction {
  const start =
    Math.abs(value.numerator) > SAFE / Math.max(1, Math.abs(numerator)) ||
    value.denominator > SAFE / Math.max(1, denominator)
      ? wholeUnits(roundFraction(value, mode))
      : value;

  return reduceFraction({
    numerator: start.numerator * numerator,
    denominator: start.denominator * denominator,
  });
}

/** Round an exact fraction to whole minor units. The only rounding there is. */
export function roundFraction(value: Fraction, mode: RoundingMode = "half_up"): number {
  const { numerator, denominator } = value;
  if (denominator === 1) return numerator;

  const floor = Math.floor(numerator / denominator);
  // Twice the remainder against the denominator, so a tie is an integer
  // comparison rather than a comparison against 0.5 in floating point.
  const twiceRemainder = 2 * (numerator - floor * denominator);

  switch (mode) {
    case "down":
      return floor;
    case "up":
      return numerator === floor * denominator ? floor : floor + 1;
    case "half_even":
      if (twiceRemainder > denominator) return floor + 1;
      if (twiceRemainder < denominator) return floor;
      return floor % 2 === 0 ? floor : floor + 1;
    case "half_up":
    default:
      // A tie goes up, which is what `half_up` means and what the float path
      // could not deliver: `1010.5` was never exactly representable.
      return twiceRemainder >= denominator ? floor + 1 : floor;
  }
}
