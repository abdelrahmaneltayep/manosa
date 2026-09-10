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

/** The store-local calendar day an instant falls on: `YYYY-MM-DD`. */
export function localDay(at: Date, timeZone: string | null): string {
  // `en-CA` formats as `YYYY-MM-DD`, which sorts and compares as a string.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone ?? UTC,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
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
