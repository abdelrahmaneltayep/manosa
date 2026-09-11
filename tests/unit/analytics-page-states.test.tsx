import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { AnalyticsPage } from "~/components/analytics/AnalyticsPage";
import type { AnalyticsView } from "~/components/analytics/types";
import type { Locale } from "~/i18n/config";
import { createCaptureHarness, type CaptureHarness } from "../support/state-capture";

/**
 * The analytics page, in every state it has.
 *
 * Structure only — Polaris never upgrades here — but the marks themselves are
 * ours: the SVG in these captures is exactly what a merchant's browser gets,
 * so bar geometry, label placement and the legend *are* verifiable from them
 * even though the Polaris chrome around them is a stand-in.
 */

const OUT = resolve(process.cwd(), "qa/6.2");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Analytics",
    outFor: () => OUT,
    dirs: [OUT],
  });
});

/* -------------------------------------------------------------------------- */

// Shaped like `formatCurrency`'s real output, separator and all: a fixture
// that formats money differently from production is a fixture that hides a
// formatting bug.
const money = (amount: number) =>
  new Intl.NumberFormat("en", { style: "currency", currency: "USD" }).format(
    amount / 100,
  );

/**
 * A run of days, as long as the window really is.
 *
 * Seven points used to stand in for every window, so no capture had ever
 * rendered a 31- or 91-point chart — which is every real 30- and 90-day view,
 * and is why label collisions and off-by-half-a-slot marks went unseen.
 */
const series = (count: number, seed = 7) =>
  Array.from({ length: count }, (_, index) => {
    const at = new Date(Date.UTC(2026, 8, 1) + index * 86_400_000);
    const day = at.toISOString().slice(0, 10);
    // Deterministic, and shaped like a week: a flat line hides nothing but
    // also shows nothing.
    const value = (((index * seed) % 11) + 2) * 12_000;
    return {
      day,
      label: `${at.getUTCDate()} ${at.toLocaleString("en", { month: "short", timeZone: "UTC" })}`,
      value,
      money: money(value),
    };
  });

const points = (values: number[]) =>
  values.map((value, index) => ({
    day: `2026-09-${String(index + 1).padStart(2, "0")}`,
    label: `${index + 1} Sep`,
    value,
    money: money(value),
  }));

const ranked = (entries: [string, number][]) =>
  entries.map(([label, value], index) => ({
    key: `k${index}`,
    label,
    value,
    money: money(value),
    isRest: label === "Everyone else",
  }));

const view = (overrides: Partial<AnalyticsView> = {}): AnalyticsView => ({
  loading: false,
  range: 30,
  ranges: [7, 30, 90],
  isExample: false,
  partial: false,
  historyDays: 120,
  currencyCode: "USD",
  timeZone: "Europe/London",
  excludedOrders: 0,
  ordersMissingLines: 0,
  ordersCapped: false,
  annotations: [],
  aov: { value: money(31_000), orders: 42 },
  axisTicks: [money(250_000), money(187_500), money(125_000), money(62_500), money(0)],
  revenue: {
    wholesale: {
      key: "wholesale",
      points: points([120_000, 90_000, 150_000, 80_000, 210_000, 170_000, 240_000]),
      total: money(1_060_000),
    },
    retail: {
      key: "retail",
      points: points([40_000, 55_000, 30_000, 60_000, 45_000, 50_000, 35_000]),
      total: money(315_000),
    },
  },
  byGroup: ranked([
    ["Cafés", 620_000],
    ["Restaurants", 310_000],
    ["Hotels", 130_000],
  ]),
  topBuyers: ranked([
    ["Café Aroma", 410_000],
    ["Bean There Ltd", 280_000],
    ["Everyone else", 370_000],
  ]),
  topProducts: ranked([
    ["House Blend 1kg", 500_000],
    ["Espresso Beans 1kg", 340_000],
  ]),
  rules: [
    {
      key: "Café trade price",
      label: "Café trade price",
      value: 620_000,
      money: money(620_000),
      isRest: false,
      lines: 42,
      discounted: money(210_000),
      stillExists: true,
    },
    {
      key: "Launch offer",
      label: "Launch offer",
      value: 120_000,
      money: money(120_000),
      isRest: false,
      lines: 9,
      discounted: money(60_000),
      stillExists: false,
    },
  ],
  funnel: [
    { key: "submitted", value: 48, ofPrevious: null },
    { key: "approved", value: 31, ofPrevious: "65%" },
    { key: "ordered", value: 22, ofPrevious: "71%" },
  ],
  aging: [
    { key: "current", amount: money(420_000), value: 420_000, count: 6 },
    { key: "days_1_15", amount: money(180_000), value: 180_000, count: 3 },
    { key: "days_16_30", amount: money(90_000), value: 90_000, count: 2 },
    { key: "days_30_plus", amount: money(45_000), value: 45_000, count: 1 },
  ],
  ...overrides,
});

/* -------------------------------------------------------------------------- */

describe("the analytics page", () => {
  it("draws all seven charts, with a legend and both totals", () => {
    const html = render(<AnalyticsPage view={view()} />);

    expect(html).toContain("Wholesale and retail revenue");
    expect(html).toContain("Wholesale · $10,600.00");
    expect(html).toContain("Retail · $3,150.00");
    expect(html).toContain("Top wholesale buyers");
    expect(html).toContain("Pricing rule performance");
    expect(html).toContain("Registration funnel");
    expect(html).toContain("Net terms aging");
    // A line, not bars, once there is enough history to draw one.
    expect(html).toContain("<polyline");
    capture("01-analytics-full", html);
  });

  it("says what currency and which timezone every number is in", () => {
    const html = render(<AnalyticsPage view={view()} />);

    // The checklist asks for both, and without them a merchant in Riyadh
    // reading UTC days is looking at the wrong week with no way to tell.
    expect(html).toContain("Every figure on this page is in USD");
    expect(html).toContain("Europe/London");
    capture("02-analytics-footer", html);
  });

  it("says so when it has not read the store's timezone", () => {
    const html = render(<AnalyticsPage view={view({ timeZone: null })} />);

    expect(html).toContain("counted in UTC");
    expect(html).not.toContain("your store&#x27;s days, in");
  });

  it("shows a worked example, twice labelled, when nothing has ever sold", () => {
    const html = render(<AnalyticsPage view={view({ isExample: true })} />);

    // A sample dashboard a merchant mistakes for their own is worse than an
    // empty one, so it is said in a banner *and* the charts are washed out.
    expect(html).toContain(
      "Example — your data appears after your first wholesale order",
    );
    expect(html).toContain("mn-viz--example");
    expect(html).toContain("the CSV exports are empty");
    capture("03-analytics-example", html);
  });

  it("draws bars and no trend line under a week of history", () => {
    const html = render(<AnalyticsPage view={view({ partial: true, historyDays: 3 })} />);

    // The checklist's rule. A line through three points is a shape, not a trend.
    expect(html).not.toContain("<polyline");
    expect(html).toContain("3 days of history");
    capture("04-analytics-partial", html);
  });

  it("marks the day the app arrived and the day the agent went live", () => {
    const html = render(
      <AnalyticsPage
        view={view({
          annotations: [
            { key: "installed", day: "2026-09-02", label: "Mannon installed" },
            { key: "agent_published", day: "2026-09-05", label: "Buyer Agent published" },
          ],
        })}
      />,
    );

    // A line that starts at zero because the app was not there yet is not a
    // line that starts at zero because nothing sold.
    expect(html).toContain("Mannon installed");
    expect(html).toContain("Buyer Agent published");
    capture("05-analytics-annotated", html);
  });

  it("names the orders it could not add up, rather than dropping them quietly", () => {
    const html = render(
      <AnalyticsPage view={view({ excludedOrders: 4, ordersMissingLines: 2 })} />,
    );

    expect(html).toContain("4 orders in this window are in another currency");
    expect(html).toContain("2 orders have more lines than Shopify returned");
    capture("06-analytics-caveats", html);
  });

  it("marks a rule that no longer exists under the name the buyer saw", () => {
    const html = render(<AnalyticsPage view={view()} />);

    expect(html).toContain("Renamed or removed");
    expect(html).toContain("renaming one does not rewrite what it earned");
    capture("07-analytics-rules", html);
  });

  it("leaves a funnel's first step without a share of nothing", () => {
    const html = render(<AnalyticsPage view={view()} />);

    // The first step has nothing to be a share of, so it shows a dash — not
    // "0%", and not "100%".
    expect(html).toContain("—");
    capture("08-analytics-funnel", html);
  });

  it("says a window is empty rather than drawing an empty chart", () => {
    const html = render(
      <AnalyticsPage
        view={view({
          revenue: {
            wholesale: { key: "wholesale", points: [], total: "$0.00" },
            retail: { key: "retail", points: [], total: "$0.00" },
          },
          byGroup: [],
          topBuyers: [],
          topProducts: [],
          rules: [],
          funnel: [
            { key: "submitted", value: 0, ofPrevious: null },
            { key: "approved", value: 0, ofPrevious: null },
            { key: "ordered", value: 0, ofPrevious: null },
          ],
          aging: [],
        })}
      />,
    );

    expect(html).toContain("Nothing in this window.");
    capture("09-analytics-empty-window", html);
  });

  it("offers a CSV per chart, carrying the window on screen", () => {
    const html = render(
      <AnalyticsPage
        view={view({
          range: 90,
          // A real 91-point series. The capture that used to carry this name
          // rendered the seven-point default, so nothing here had ever drawn a
          // long window.
          revenue: {
            wholesale: { key: "wholesale", points: series(91), total: money(6_000_000) },
            retail: { key: "retail", points: series(91, 3), total: money(2_000_000) },
          },
        })}
      />,
    );

    expect(html).toContain("/app/analytics/export?chart=products&amp;range=90");
    expect(html).toContain("/app/analytics/export?chart=aging&amp;range=90");
    capture("10-analytics-90-days", html);
  });

  it("draws a month without its day labels colliding", () => {
    const html = render(
      <AnalyticsPage
        view={view({
          revenue: {
            wholesale: { key: "wholesale", points: series(31), total: money(2_000_000) },
            retail: { key: "retail", points: series(31, 5), total: money(700_000) },
          },
          annotations: [
            { key: "installed", day: "2026-09-03", label: "Mannon installed" },
            { key: "agent_published", day: "2026-09-06", label: "Buyer Agent published" },
          ],
        })}
      />,
    );

    // Two marks a few days apart is the ordinary onboarding path, and both
    // used to be drawn on the same line, overlapping.
    expect(html).toContain("Mannon installed");
    expect(html).toContain("Buyer Agent published");
    capture("12-analytics-month", html);
  });

  it("marks a recent install without its label running off the chart", () => {
    const html = render(
      <AnalyticsPage
        view={view({
          revenue: {
            wholesale: { key: "wholesale", points: series(31), total: money(2_000_000) },
            retail: { key: "retail", points: series(31, 5), total: money(700_000) },
          },
          annotations: [
            // Three days before the end — a shop that installed recently, and
            // the one case where the label was silently clipped.
            { key: "installed", day: "2026-09-28", label: "Mannon installed" },
          ],
        })}
      />,
    );

    expect(html).toContain('text-anchor="end"');
    capture("13-analytics-recent-install", html);
  });

  it("says when a window held more orders than it read", () => {
    const html = render(<AnalyticsPage view={view({ ordersCapped: true })} />);

    expect(html).toContain("more orders than one view reads");
    capture("14-analytics-capped", html);
  });

  it("shows a skeleton while the window is being read", () => {
    const html = render(<AnalyticsPage view={view({ loading: true })} />);

    expect(html).toContain("Reading your numbers");
    // The stale charts are not left on screen under a spinner.
    expect(html).toContain("hidden");
    capture("15-analytics-loading", html);
  });

  it("keeps a tiny row visible beside a dominant one", () => {
    const html = render(
      <AnalyticsPage
        view={view({
          topBuyers: ranked([
            ["Café Aroma", 12_345_678],
            ["The corner shop", 2_000],
            ["Everyone else", 5_000],
          ]),
        })}
      />,
    );

    // A row present in the data is a row with a mark; the tail used to render
    // as floating numbers beside nothing.
    expect(html).toContain("mn-rest");
    capture("16-analytics-long-tail", html);
  });

  it("reads right to left in Arabic, with its value labels beside the bars", () => {
    const html = render(<AnalyticsPage view={view()} />, "ar");

    expect(html).toContain("التحليلات");
    expect(html).toContain("أكبر مشتري الجملة");
    // Without these the default `start` anchor resolves to the *right* edge in
    // an RTL document, so every value was drawn leftwards across its own bar.
    expect(html).toContain('text-anchor="start"');
    expect(html).toContain('dir="ltr"');
    capture("11-analytics-arabic", html, "ar");
  });
});
