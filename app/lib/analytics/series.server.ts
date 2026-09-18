import { money, type Money } from "@mannon/pricing-engine";

/**
 * Turning rows into a chart's worth of buckets.
 *
 * Pure, and deliberately so: every decision a chart makes about *when*
 * something happened is here, where a test can reach it. The two that matter
 * are the timezone and the gaps.
 *
 * **The timezone is the store's, not the server's.** Checklist §7 says
 * "Timezone = store timezone (stated in footer)", and a merchant in Sydney
 * whose Monday sales land in Sunday's bar because the server is in UTC has
 * been shown the wrong week.
 *
 * **A day with no orders is a bar of zero, not a missing bar.** Dropping empty
 * days silently compresses a quiet fortnight into a busy-looking line.
 */

export const UTC = "UTC";

/**
 * A zone `Intl` will accept, or UTC.
 *
 * `ianaTimezone` is a text column. A value `Intl` does not recognise — a bad
 * write, or a Node built without full ICU — threw `RangeError` out of every
 * caller, and since both analytics loaders reach this through the review
 * scheduler, the whole page returned 500 rather than falling back to the zone
 * the footer already says it is using when the column is null.
 */
function usableZone(timeZone: string | null): string {
  if (!timeZone) return UTC;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(0);
    return timeZone;
  } catch {
    return UTC;
  }
}

/** The store-local calendar day an instant falls on: `YYYY-MM-DD`. */
export function localDay(at: Date, timeZone: string | null): string {
  // `en-CA` formats as `YYYY-MM-DD`, which sorts and compares as a string.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: usableZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

const QUARTER_HOUR = 15 * 60 * 1000;
const BRACKET = 2 * 24 * 60 * 60 * 1000;

/**
 * The first instant of a store-local `YYYY-MM-DD`, as a UTC `Date`.
 *
 * Binary search between two instants certainly either side of it, on a
 * fifteen-minute grid because Kathmandu and Chatham are not on the hour. The
 * same shape as `monthStart` in `review.server.ts`, which now delegates here.
 *
 * Pricing needs it as much as analytics do: the rule builder's fields are
 * `s-date-field`, so a merchant who sets "ends 1 July" means the end of that
 * day in their own shop's time. `new Date("2026-07-01")` is UTC midnight, so
 * the rule was dead for the whole of the day they named — and in a US-Pacific
 * store a rule starting "1 July" went live at 18:00 on 30 June, store time.
 */
export function dayStart(day: string, timeZone: string | null): Date {
  const [year, month, date] = day.split("-").map(Number);
  const base = Date.UTC(year!, (month ?? 1) - 1, date ?? 1);

  // Monotonic: local time only moves forward, and `YYYY-MM-DD` sorts as dates.
  const reached = (at: number) => localDay(new Date(at), timeZone) >= day;

  let before = Math.floor((base - BRACKET) / QUARTER_HOUR);
  let after = Math.ceil((base + BRACKET) / QUARTER_HOUR);

  while (after - before > 1) {
    const mid = Math.floor((before + after) / 2);
    if (reached(mid * QUARTER_HOUR)) after = mid;
    else before = mid;
  }
  return new Date(after * QUARTER_HOUR);
}

/**
 * The last instant of a store-local day, as a UTC `Date`.
 *
 * Inclusive of the whole day the merchant named. "Ends 1 July" means the rule
 * is live all through 1 July and dead on the 2nd — which is what the words say
 * and what nobody would have to be told.
 */
export function dayEnd(day: string, timeZone: string | null): Date {
  const [year, month, date] = day.split("-").map(Number);
  const nextDay = new Date(Date.UTC(year!, (month ?? 1) - 1, (date ?? 1) + 1));
  return new Date(dayStart(localDay(nextDay, UTC), timeZone).getTime() - 1);
}

/**
 * Every store-local day from `start` to `end`, inclusive.
 *
 * Walked in twelve-hour steps rather than by adding 24 hours, so a day is
 * neither skipped nor repeated across a daylight-saving change — the two days
 * a year when adding 86,400,000 milliseconds does not land on the next day.
 */
export function daysBetween(start: Date, end: Date, timeZone: string | null): string[] {
  const days: string[] = [];
  const last = localDay(end, timeZone);

  let cursor = start.getTime();
  let day = localDay(start, timeZone);

  while (day <= last) {
    if (days[days.length - 1] !== day) days.push(day);
    cursor += 12 * 60 * 60 * 1000;
    day = localDay(new Date(cursor), timeZone);

    // A guard, not a limit: a caller that hands in reversed dates gets an
    // empty chart rather than a loop that never ends.
    if (days.length > 800) break;
  }

  return days;
}

export interface SeriesPoint {
  /** The store-local day, `YYYY-MM-DD`. */
  day: string;
  value: number;
}

export interface MoneySeries {
  points: SeriesPoint[];
  currencyCode: string;
  total: Money;
}

/**
 * Sum rows into one bucket per day, including the days with nothing in them.
 *
 * Rows outside the window are ignored rather than clamped into the first or
 * last bucket, which would put a month of history into one bar.
 */
export function bucketByDay(
  rows: readonly { at: Date; amount: number }[],
  options: { start: Date; end: Date; timeZone: string | null; currencyCode: string },
): MoneySeries {
  const days = daysBetween(options.start, options.end, options.timeZone);
  const totals = new Map(days.map((day) => [day, 0]));

  let total = 0;
  for (const row of rows) {
    const day = localDay(row.at, options.timeZone);
    const running = totals.get(day);
    if (running === undefined) continue;
    totals.set(day, running + row.amount);
    total += row.amount;
  }

  return {
    points: days.map((day) => ({ day, value: totals.get(day) ?? 0 })),
    currencyCode: options.currencyCode,
    total: money(total, options.currencyCode),
  };
}

export interface CountSeries {
  points: SeriesPoint[];
  total: number;
}

/**
 * How many rows fell on each day, including the days with none.
 *
 * Separate from `bucketByDay` rather than a flag on it: a count is not money,
 * has no currency, and formatting one as money is how a chart ends up telling
 * a merchant they took "$14.00" in orders.
 */
export function countByDay(
  rows: readonly { at: Date }[],
  options: { start: Date; end: Date; timeZone: string | null },
): CountSeries {
  const days = daysBetween(options.start, options.end, options.timeZone);
  const totals = new Map(days.map((day) => [day, 0]));

  let total = 0;
  for (const row of rows) {
    const day = localDay(row.at, options.timeZone);
    const running = totals.get(day);
    // Outside the window, and dropped rather than clamped into the first
    // bucket — the same rule as the money series above.
    if (running === undefined) continue;
    totals.set(day, running + 1);
    total += 1;
  }

  return { points: days.map((day) => ({ day, value: totals.get(day) ?? 0 })), total };
}

/**
 * The biggest few, and everything else added up.
 *
 * A "top ten" that silently drops the tail makes the parts not add up to the
 * whole, which is the first thing a merchant checks. The remainder comes back
 * as its own entry rather than vanishing.
 */
export interface RankedRow {
  key: string;
  label: string;
  value: number;
  /** True for the row that stands in for everything below the cut. */
  isRest?: boolean;
}

export function topWithRest(
  rows: readonly RankedRow[],
  options: { limit: number; restLabel: string },
): RankedRow[] {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  if (sorted.length <= options.limit) return sorted;

  const top = sorted.slice(0, options.limit);
  const rest = sorted.slice(options.limit).reduce((sum, row) => sum + row.value, 0);

  if (rest <= 0) return top;
  return [...top, { key: "__rest", label: options.restLabel, value: rest, isRest: true }];
}
