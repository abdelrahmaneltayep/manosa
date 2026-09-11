import { describe, expect, it } from "vitest";

import { chartCsv, csvCell, isChartKey } from "~/lib/analytics/csv.server";
import { dayLabel, shareOfPrevious } from "~/lib/analytics/view-model.server";
import type { AnalyticsView } from "~/components/analytics/types";

const t = (key: string) => key;

/**
 * What the analytics screen and its files say.
 *
 * Two of these are invariant 4 in miniature: a conversion rate computed from
 * nothing is blank rather than 0%, and the worked example a shop with no data
 * sees on screen never reaches a CSV, because a file has no watermark.
 */

describe("a share of the step before", () => {
  it("is a percentage of the previous step", () => {
    expect(shareOfPrevious(31, 48)).toBe("65%");
    expect(shareOfPrevious(48, 48)).toBe("100%");
  });

  it("is blank on the first step, which has nothing to be a share of", () => {
    expect(shareOfPrevious(48, null)).toBeNull();
  });

  it("is blank — never 0% — when the step before it was empty", () => {
    // The checklist's own example of a number that lies: a form nobody opened
    // has a blank conversion rate, not a zero one.
    expect(shareOfPrevious(0, 0)).toBeNull();
  });
});

describe("the axis label for a day", () => {
  it("is the day the string names, whatever timezone this process runs in", () => {
    // `YYYY-MM-DD` is a calendar day, not an instant. Parsed as midnight it
    // lands on the day *before* for every reader west of UTC — which is how a
    // whole axis ends up shifted by one.
    expect(dayLabel("2026-09-01", "en")).toContain("1");
    expect(dayLabel("2026-09-01", "en")).toContain("Sep");
    expect(dayLabel("2026-12-31", "en")).toContain("31");
    expect(dayLabel("2026-01-01", "en")).toContain("Jan");
  });

  it("orders the parts the way the merchant's language does", () => {
    // Day-first in most of the world, month-first in the US, and Arabic in
    // Arabic — none of which this module decides.
    expect(dayLabel("2026-09-01", "en-GB")).toMatch(/^1 Sep/u);
    expect(dayLabel("2026-09-01", "en-US")).toMatch(/^Sep 1$/u);
    expect(dayLabel("2026-09-01", "ar")).toContain("سبتمبر");
  });
});

/* -------------------------------------------------------------------------- */

const money = (amount: number) => `$${amount}`;

const view = (): AnalyticsView => ({
  range: 30,
  ranges: [7, 30, 90],
  isExample: false,
  partial: false,
  historyDays: 90,
  currencyCode: "USD",
  timeZone: "UTC",
  excludedOrders: 0,
  ordersMissingLines: 0,
  annotations: [],
  revenue: {
    wholesale: {
      key: "wholesale",
      points: [{ day: "2026-09-01", label: "1 Sep", value: 1000, money: money(1000) }],
      total: money(1000),
    },
    retail: {
      key: "retail",
      points: [{ day: "2026-09-01", label: "1 Sep", value: 250, money: money(250) }],
      total: money(250),
    },
  },
  byGroup: [{ key: "g", label: "Cafés", value: 1000, money: money(1000), isRest: false }],
  topBuyers: [
    // A buyer's own company name, which is untrusted text.
    {
      key: "b",
      label: "=cmd|' /c calc'!A1",
      value: 900,
      money: money(900),
      isRest: false,
    },
  ],
  topProducts: [{ key: "p", label: "Mug", value: 700, money: money(700), isRest: false }],
  rules: [
    {
      key: "Old name",
      label: "Old name",
      value: 500,
      money: money(500),
      isRest: false,
      lines: 4,
      discounted: money(100),
      stillExists: false,
    },
  ],
  funnel: [
    { key: "submitted", value: 10, ofPrevious: null },
    { key: "approved", value: 4, ofPrevious: "40%" },
    { key: "ordered", value: 0, ofPrevious: "0%" },
  ],
  aging: [{ key: "current", amount: money(400), value: 400, count: 2 }],
});

describe("a chart as a file", () => {
  it("knows which charts it can export", () => {
    expect(isChartKey("products")).toBe(true);
    expect(isChartKey("../../etc/passwd")).toBe(false);
    expect(isChartKey("")).toBe(false);
  });

  it("defuses a company name a spreadsheet would run", () => {
    // A buyer's company name reaches this file verbatim.
    expect(csvCell("=cmd|' /c calc'!A1")).toBe(`"'=cmd|' /c calc'!A1"`);
    expect(csvCell(`he said "hi"`)).toBe(`"he said ""hi"""`);
    expect(csvCell(42)).toBe(`"42"`);
  });

  it("carries the raw minor units beside the formatted figure", () => {
    // One for a person reading it in Excel, one for a script adding it up.
    const csv = chartCsv("buyers", view(), t);
    expect(csv).toContain(`"900"`);
    expect(csv).toContain(`"$900"`);
  });

  it("says in the file when a rule no longer exists under that name", () => {
    const csv = chartCsv("rules", view(), t);
    expect(csv.split("\n")[1]).toContain(`"no"`);
  });

  it("writes a day per row for the revenue chart, both series", () => {
    const rows = chartCsv("revenue", view(), t).split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe(`"2026-09-01","1000","250","USD"`);
  });

  it("leaves a rate computed from nothing blank in the file too", () => {
    const rows = chartCsv("funnel", view(), t).split("\n");
    expect(rows[1]).toContain(`""`);
  });

  it("exports a header and nothing else for a shop with no data", () => {
    // The screen shows a worked example there. A CSV cannot be watermarked,
    // so somebody else's numbers must never reach one.
    for (const chart of ["revenue", "buyers", "rules", "funnel", "aging"] as const) {
      const rows = chartCsv(chart, null, t).split("\n");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.length).toBeGreaterThan(0);
    }
  });
});
