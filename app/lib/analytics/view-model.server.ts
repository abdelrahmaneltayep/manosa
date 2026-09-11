import { money } from "@mannon/pricing-engine";

import type {
  AnalyticsView,
  AgingRowView,
  FunnelStepView,
  PointView,
  RankedRowView,
  RuleRowView,
  SeriesView,
} from "~/components/analytics/types";
import { db } from "~/db.server";
import type { AnalyticsData, Range } from "~/lib/analytics/charts.server";
import { RANGES } from "~/lib/analytics/charts.server";
import type { Translate } from "~/i18n/translate";
import { gridlines, niceMax } from "~/lib/analytics/geometry";
import { formatCurrency } from "~/lib/money";
import type { MoneySeries } from "~/lib/analytics/series.server";

/**
 * What the analytics screen reads.
 *
 * Every figure is formatted here, once, in the shop's own currency — a
 * component that formatted money would be a second place for the page and its
 * CSV to disagree about what a number means.
 */

export interface ViewOptions {
  locale: string;
  t: Translate;
}

/** "1 Sep" — short enough for an axis, unambiguous enough to read. */
export function dayLabel(day: string, locale: string): string {
  // `YYYY-MM-DD` is a calendar day, not an instant: parsed as UTC noon so no
  // timezone can shunt it onto the day before.
  const at = new Date(`${day}T12:00:00Z`);
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(at);
}

function seriesView(
  key: string,
  series: MoneySeries,
  options: { locale: string },
): SeriesView {
  const points: PointView[] = series.points.map((point) => ({
    day: point.day,
    label: dayLabel(point.day, options.locale),
    value: point.value,
    money: formatCurrency(money(point.value, series.currencyCode), options.locale),
  }));

  return {
    key,
    points,
    total: formatCurrency(series.total, options.locale),
  };
}

const rankedView = (
  rows: AnalyticsData["byGroup"],
  currencyCode: string,
  locale: string,
): RankedRowView[] =>
  rows.map((row) => ({
    key: row.key,
    label: row.label,
    value: row.value,
    money: formatCurrency(money(row.value, currencyCode), locale),
    isRest: row.isRest === true,
  }));

/**
 * How much of the previous step reached this one.
 *
 * Blank on the first step, which has nothing to be a share of, and blank —
 * never `0%` — when the step before it was empty. A conversion rate computed
 * from nothing is the checklist's own example of a number that lies.
 */
export function shareOfPrevious(value: number, previous: number | null): string | null {
  if (previous === null || previous === 0) return null;
  return `${Math.round((value / previous) * 100)}%`;
}

export function analyticsView(data: AnalyticsData, options: ViewOptions): AnalyticsView {
  const { locale, t } = options;
  const currencyCode = data.window.currencyCode;

  const funnel: FunnelStepView[] = data.funnel.map((step, index) => ({
    key: step.key,
    value: step.value,
    ofPrevious: shareOfPrevious(
      step.value,
      index === 0 ? null : data.funnel[index - 1]!.value,
    ),
  }));

  const aging: AgingRowView[] = data.aging.map((row) => ({
    key: row.bucket,
    amount: formatCurrency(row.amount, locale),
    value: row.amount.amount,
    count: row.count,
  }));

  const rules: RuleRowView[] = data.rules.map((row) => ({
    key: row.key,
    label: row.label,
    value: row.value,
    money: formatCurrency(money(row.value, currencyCode), locale),
    isRest: false,
    lines: row.lines,
    discounted: formatCurrency(money(row.discounted, currencyCode), locale),
    stillExists: row.stillExists,
  }));

  // The value axis the chart draws against: the same `niceMax` the marks are
  // scaled by, split into the same number of bands the gridlines use, and
  // formatted here where money formatting lives.
  const axisMax = niceMax([
    ...data.revenue.wholesale.points.map((point) => point.value),
    ...data.revenue.retail.points.map((point) => point.value),
  ]);
  const bands = gridlines().length - 1;
  const axisTicks = Array.from({ length: bands + 1 }, (_, index) =>
    formatCurrency(
      money(Math.round((axisMax * (bands - index)) / bands), currencyCode),
      locale,
    ),
  );

  return {
    loading: false,
    range: data.window.range,
    axisTicks,
    aov: {
      value: formatCurrency(data.aov.value, locale),
      orders: data.aov.orders,
    },
    ranges: [...RANGES],
    // An example is shown only when there is genuinely nothing — not when a
    // window happens to be quiet, which is a real answer and its own state.
    isExample: false,
    partial: data.window.partial,
    historyDays: data.window.historyDays,
    currencyCode,
    timeZone: data.window.timeZone,
    excludedOrders: data.excludedOrders,
    ordersMissingLines: data.ordersMissingLines,
    ordersCapped: data.ordersCapped,
    annotations: data.annotations.map((mark) => ({
      key: mark.key,
      day: mark.day,
      label: t(`analytics.annotation.${mark.key}`),
    })),
    revenue: {
      wholesale: seriesView("wholesale", data.revenue.wholesale, { locale }),
      retail: seriesView("retail", data.revenue.retail, { locale }),
    },
    byGroup: rankedView(data.byGroup, currencyCode, locale),
    topBuyers: rankedView(data.topBuyers, currencyCode, locale),
    topProducts: rankedView(data.topProducts, currencyCode, locale),
    rules,
    funnel,
    aging,
  };
}

/**
 * Has this shop ever had anything to show?
 *
 * Deliberately **not** "is this window empty", and this is now a query rather
 * than a read of the window's own totals — which is what it used to be, so a
 * merchant with a year of history and a quiet `?range=7` was shown invented
 * numbers, and clicking between the three range links made their business
 * appear and disappear.
 *
 * The second clause matters as much: a shop whose window orders are all in
 * another currency has revenue of zero **and a banner explaining why**.
 * Replacing that page with an example deleted the one true sentence on it.
 */
export async function hasAnyData(data: AnalyticsData): Promise<boolean> {
  if (data.excludedOrders > 0 || data.ordersMissingLines > 0) return true;

  const [orders, submissions] = await Promise.all([
    db.order.count({ where: { isWholesale: true } }),
    db.formSubmission.count(),
  ]);

  return orders > 0 || submissions > 0;
}

/**
 * Somebody else's numbers, clearly labelled as such.
 *
 * Shown only to a shop that has never had a wholesale order, because an empty
 * dashboard teaches a merchant nothing about what this page will do for them.
 * Every figure is obviously round, the page says what it is twice, and the
 * charts are washed out — and `isExample` also switches the CSV export off, so
 * these numbers can never leave the screen.
 */
export function exampleView(base: AnalyticsView, locale: string): AnalyticsView {
  const days = base.revenue.wholesale.points.length || 30;
  const shape = [3, 5, 4, 8, 6, 9, 7];
  const currencyCode = base.currencyCode;

  const point = (index: number, scale: number): PointView => {
    const day = base.revenue.wholesale.points[index]?.day ?? `2026-01-${index + 1}`;
    const value = (shape[index % shape.length] ?? 5) * scale;
    return {
      day,
      label: base.revenue.wholesale.points[index]?.label ?? dayLabel(day, locale),
      value,
      money: formatCurrency(money(value, currencyCode), locale),
    };
  };

  const series = (key: string, scale: number): SeriesView => {
    const points = Array.from({ length: days }, (_, index) => point(index, scale));
    return {
      key,
      points,
      total: formatCurrency(
        money(
          points.reduce((sum, entry) => sum + entry.value, 0),
          currencyCode,
        ),
        locale,
      ),
    };
  };

  const ranked = (labels: string[], scale: number): RankedRowView[] =>
    labels.map((label, index) => ({
      key: `example-${index}`,
      label,
      value: (labels.length - index) * scale,
      money: formatCurrency(money((labels.length - index) * scale, currencyCode), locale),
      isRest: false,
    }));

  return {
    ...base,
    isExample: true,
    axisTicks: base.axisTicks,
    // An example is not this shop's history, so it never claims to be partial.
    // The caveats are *not* cleared here: `hasAnyData` refuses the example
    // whenever one is set, because a banner explaining a zero is the only true
    // thing on such a page.
    partial: false,
    annotations: [],
    aov: { value: formatCurrency(money(42_000, currencyCode), locale), orders: 26 },
    revenue: { wholesale: series("wholesale", 12_000), retail: series("retail", 4_000) },
    byGroup: ranked(["Cafés", "Restaurants", "Hotels"], 250_000),
    topBuyers: ranked(["Café Aroma", "Bean There Ltd", "The Roastery"], 180_000),
    topProducts: ranked(
      ["House Blend 1kg", "Espresso Beans 1kg", "Filter Papers"],
      90_000,
    ),
    rules: ranked(["Café trade price", "Volume 100+", "Hotel contract"], 200_000).map(
      (row, index) => ({
        ...row,
        lines: (3 - index) * 14,
        discounted: formatCurrency(money((3 - index) * 30_000, currencyCode), locale),
        stillExists: true,
      }),
    ),
    funnel: [
      { key: "submitted", value: 48, ofPrevious: null },
      { key: "approved", value: 31, ofPrevious: "65%" },
      { key: "ordered", value: 22, ofPrevious: "71%" },
    ],
    aging: [
      {
        key: "current",
        amount: formatCurrency(money(420_000, currencyCode), locale),
        value: 420_000,
        count: 6,
      },
      {
        key: "days_1_15",
        amount: formatCurrency(money(180_000, currencyCode), locale),
        value: 180_000,
        count: 3,
      },
      {
        key: "days_16_30",
        amount: formatCurrency(money(90_000, currencyCode), locale),
        value: 90_000,
        count: 2,
      },
      {
        key: "days_30_plus",
        amount: formatCurrency(money(45_000, currencyCode), locale),
        value: 45_000,
        count: 1,
      },
    ],
  };
}

export const isRangeParam = (value: string): value is `${Range}` =>
  (RANGES as readonly number[]).includes(Number(value));
