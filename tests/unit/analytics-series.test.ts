import { describe, expect, it } from "vitest";

import {
  bucketByDay,
  daysBetween,
  localDay,
  topWithRest,
} from "~/lib/analytics/series.server";

/**
 * When a chart says something happened.
 *
 * Every one of these is a way a chart lies quietly: the wrong day because the
 * server is not where the merchant is, a missing bar that makes a quiet
 * fortnight look busy, a day skipped or doubled across a clock change, and a
 * "top ten" whose parts do not add up to the whole.
 */

describe("the store's own day", () => {
  it("is the merchant's calendar day, not the server's", () => {
    const at = new Date("2026-09-10T20:00:00Z");

    // 6am on the 11th in Sydney; 1pm on the 10th in Denver. A merchant in
    // Sydney whose Monday sales land in Sunday's bar has been shown the wrong
    // week.
    expect(localDay(at, "Australia/Sydney")).toBe("2026-09-11");
    expect(localDay(at, "America/Denver")).toBe("2026-09-10");
    expect(localDay(at, "UTC")).toBe("2026-09-10");
  });

  it("falls back to UTC when the shop's timezone was never read", () => {
    expect(localDay(new Date("2026-09-10T20:00:00Z"), null)).toBe("2026-09-10");
  });
});

describe("the days a window covers", () => {
  it("includes both ends", () => {
    const days = daysBetween(
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-05T23:59:59Z"),
      "UTC",
    );

    expect(days).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ]);
  });

  it("neither skips nor repeats a day across a clock change", () => {
    // The two days a year when adding 86,400,000ms does not land on the next
    // day. London springs forward on 29 March 2026.
    const days = daysBetween(
      new Date("2026-03-27T12:00:00Z"),
      new Date("2026-03-31T12:00:00Z"),
      "Europe/London",
    );

    expect(days).toEqual([
      "2026-03-27",
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
      "2026-03-31",
    ]);
    expect(new Set(days).size).toBe(days.length);
  });

  it("and across a fall-back too", () => {
    const days = daysBetween(
      new Date("2026-10-24T12:00:00Z"),
      new Date("2026-10-27T12:00:00Z"),
      "Europe/London",
    );

    expect(days).toEqual(["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]);
  });

  it("is empty rather than endless when the window is backwards", () => {
    expect(
      daysBetween(
        new Date("2026-09-05T00:00:00Z"),
        new Date("2026-09-01T00:00:00Z"),
        "UTC",
      ),
    ).toEqual([]);
  });
});

describe("bucketing rows into days", () => {
  const window = {
    start: new Date("2026-09-01T00:00:00Z"),
    end: new Date("2026-09-03T23:59:59Z"),
    timeZone: "UTC",
    currencyCode: "USD",
  };

  it("keeps a day with nothing in it as a bar of zero", () => {
    const series = bucketByDay(
      [
        { at: new Date("2026-09-01T09:00:00Z"), amount: 1000 },
        { at: new Date("2026-09-03T09:00:00Z"), amount: 2500 },
      ],
      window,
    );

    // Dropping the empty day would compress a quiet stretch into a busy line.
    expect(series.points).toEqual([
      { day: "2026-09-01", value: 1000 },
      { day: "2026-09-02", value: 0 },
      { day: "2026-09-03", value: 2500 },
    ]);
    expect(series.total).toEqual({ amount: 3500, currencyCode: "USD" });
  });

  it("adds up several rows in the same day", () => {
    const series = bucketByDay(
      [
        { at: new Date("2026-09-02T01:00:00Z"), amount: 100 },
        { at: new Date("2026-09-02T23:00:00Z"), amount: 400 },
      ],
      window,
    );

    expect(series.points[1]).toEqual({ day: "2026-09-02", value: 500 });
  });

  it("ignores a row outside the window rather than clamping it in", () => {
    const series = bucketByDay(
      [
        { at: new Date("2026-08-01T09:00:00Z"), amount: 9999 },
        { at: new Date("2026-12-01T09:00:00Z"), amount: 9999 },
      ],
      window,
    );

    // Clamping would put a month of history into the first bar.
    expect(series.points.every((point) => point.value === 0)).toBe(true);
    expect(series.total.amount).toBe(0);
  });

  it("buckets by the store's day, not the server's", () => {
    const series = bucketByDay([{ at: new Date("2026-09-01T20:00:00Z"), amount: 700 }], {
      ...window,
      timeZone: "Australia/Sydney",
    });

    // 6am on the 2nd in Sydney.
    expect(series.points.find((point) => point.day === "2026-09-02")?.value).toBe(700);
  });
});

describe("a top ten that adds up", () => {
  const rows = [
    { key: "a", label: "A", value: 500 },
    { key: "b", label: "B", value: 400 },
    { key: "c", label: "C", value: 300 },
    { key: "d", label: "D", value: 200 },
    { key: "e", label: "E", value: 100 },
  ];

  it("orders by size", () => {
    const ranked = topWithRest(rows, { limit: 5, restLabel: "Everyone else" });
    expect(ranked.map((row) => row.key)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("carries the tail rather than dropping it", () => {
    const ranked = topWithRest(rows, { limit: 3, restLabel: "Everyone else" });

    // The first thing a merchant does with a "top 3" is check it against the
    // total. A silently dropped tail makes that fail.
    expect(ranked).toHaveLength(4);
    expect(ranked[3]).toEqual({
      key: "__rest",
      label: "Everyone else",
      value: 300,
      isRest: true,
    });
    expect(ranked.reduce((sum, row) => sum + row.value, 0)).toBe(1500);
  });

  it("does not add an empty remainder row", () => {
    const ranked = topWithRest([...rows, { key: "f", label: "F", value: 0 }], {
      limit: 5,
      restLabel: "Everyone else",
    });
    expect(ranked).toHaveLength(5);
  });
});
