import { describe, expect, it } from "vitest";

import {
  columns,
  endRoomFor,
  gridlines,
  inner,
  line,
  niceMax,
  wholeMax,
  PLOT,
  polyline,
  rows,
  shouldLabel,
  withEndRoom,
} from "~/lib/analytics/geometry";

/**
 * Where a mark goes.
 *
 * Arithmetic a chart cannot be looked at to check — Polaris never upgrades in
 * this environment, so a bar in the wrong place is a bar nobody would see. Each
 * of these is a way a chart draws something untrue: a bar taller than its own
 * axis, a negative value reading as a small positive one, an all-zero chart
 * dividing by nothing, or thirty labels collapsing into a grey smear.
 */

describe("the top of the value axis", () => {
  it("rounds up to a number a person would say", () => {
    expect(niceMax([37])).toBe(50);
    expect(niceMax([120])).toBe(200);
    expect(niceMax([1])).toBe(1);
    expect(niceMax([6_500])).toBe(10_000);
  });

  it("is never zero, so an empty chart still has a scale", () => {
    // Every bar is `value / max`. A max of zero is every bar at NaN.
    expect(niceMax([])).toBe(1);
    expect(niceMax([0, 0, 0])).toBe(1);
    expect(niceMax([-5])).toBe(1);
  });
});

describe("the top of an axis that counts things", () => {
  it("is a whole number of bands, so every label is a whole count", () => {
    // `niceMax` would make three orders a scale of five, and five over four
    // bands labels the axis 5, 3.75, 2.5, 1.25 — there is no such thing as
    // 3.75 orders.
    for (const peak of [1, 2, 3, 5, 7, 9, 11, 23, 100, 101]) {
      const top = wholeMax([peak]);
      expect(top % 4, `peak ${peak} → ${top}`).toBe(0);
      expect(top).toBeGreaterThanOrEqual(peak);
      for (let band = 0; band <= 4; band += 1) {
        expect(Number.isInteger((top * band) / 4)).toBe(true);
      }
    }
  });

  it("is never zero, and never smaller than the peak", () => {
    expect(wholeMax([])).toBe(4);
    expect(wholeMax([0, 0])).toBe(4);
    expect(wholeMax([13])).toBe(16);
  });
});

describe("columns", () => {
  const box = inner();

  it("sits every bar on the baseline and none above the axis", () => {
    const bars = columns([10, 20, 40], { max: 40 });

    for (const bar of bars) {
      expect(bar.y + bar.height).toBeCloseTo(box.y + box.height, 5);
      expect(bar.y).toBeGreaterThanOrEqual(box.y - 0.001);
    }
    expect(bars[2]!.height).toBeCloseTo(box.height, 5);
  });

  it("leaves a gap between neighbours rather than a border around each", () => {
    const bars = columns([1, 1, 1], { max: 1, gap: 2 });
    const gap = bars[1]!.x - (bars[0]!.x + bars[0]!.width);

    expect(gap).toBeCloseTo(2, 5);
  });

  it("keeps a bar inside its own axis, whatever the value claims", () => {
    // A value above the max would otherwise draw straight out of the card.
    const [tall] = columns([999], { max: 10 });
    expect(tall!.height).toBeCloseTo(box.height, 5);

    // And a negative one would hang off a baseline this chart does not draw,
    // reading as a very small positive bar.
    const [negative] = columns([-50], { max: 10 });
    expect(negative!.height).toBe(0);
  });

  it("draws nothing for no data rather than one bar of everything", () => {
    expect(columns([])).toEqual([]);
  });
});

describe("rows", () => {
  it("grows from the inline-start edge, one per value", () => {
    const bars = rows([50, 100], { max: 100 });
    const box = inner();

    expect(bars).toHaveLength(2);
    expect(bars[0]!.x).toBeCloseTo(box.x, 5);
    expect(bars[0]!.width).toBeCloseTo(box.width / 2, 5);
    expect(bars[1]!.width).toBeCloseTo(box.width, 5);
    // Stacked down the plot, not on top of each other.
    expect(bars[1]!.y).toBeGreaterThan(bars[0]!.y);
  });
});

describe("the line", () => {
  it("spans the plot, first point to last", () => {
    const box = inner();
    const points = line([1, 2, 3], { max: 3 });

    expect(points[0]!.x).toBeCloseTo(box.x, 5);
    expect(points[2]!.x).toBeCloseTo(box.x + box.width, 5);
    expect(points[2]!.y).toBeCloseTo(box.y, 5);
  });

  it("puts a lone point in the middle, not at the edge", () => {
    // At the left edge it reads as the start of a line that is not there.
    const box = inner();
    const [only] = line([5], { max: 10 });
    expect(only!.x).toBeCloseTo(box.x + box.width / 2, 5);
  });

  it("renders to coordinates an SVG can use", () => {
    expect(polyline([{ x: 1.234, y: 5.678 }])).toBe("1.23,5.68");
  });
});

describe("room for a value written beside its bar", () => {
  it("keeps the longest bar's label inside the viewBox", () => {
    // The longest bar reaches the full plot width and its label is drawn past
    // the end of it. Without this, the one row a reader most wants to read is
    // the one whose number is cropped off the edge.
    const labels = ["$5,000.00", "$3,400.00"];
    const plot = withEndRoom(labels);
    const [longest] = rows([100, 68], { max: 100, plot });

    const labelEnd = longest!.x + longest!.width + 0.8 + labels[0]!.length * 1.15;
    expect(labelEnd).toBeLessThanOrEqual(PLOT.width);
  });

  it("reserves more for a longer number", () => {
    expect(endRoomFor(["$1.00"])).toBeLessThan(endRoomFor(["$1,234,567.00"]));
  });

  it("never eats the whole plot, however long the label", () => {
    const plot = withEndRoom(["x".repeat(200)]);
    expect(inner(plot).width).toBeGreaterThan(50);
  });
});

describe("the chrome", () => {
  it("puts the x-axis band inside the box, not below it", () => {
    // A container sized to the plot alone gives the card its own little
    // scrollbar, which is the shape of this bug in every dashboard.
    const box = inner();
    expect(box.y + box.height).toBeLessThan(PLOT.height);
  });

  it("draws a gridline at zero and at the top", () => {
    const box = inner();
    const lines = gridlines();

    expect(lines[0]).toBeCloseTo(box.y, 5);
    expect(lines.at(-1)).toBeCloseTo(box.y + box.height, 5);
  });

  it("labels the first and last day whatever the window", () => {
    // Those two are how a reader knows what window they are looking at.
    for (const count of [1, 7, 30, 90]) {
      expect(shouldLabel(0, count)).toBe(true);
      expect(shouldLabel(count - 1, count)).toBe(true);
    }
  });

  it("thins the rest rather than smearing thirty labels together", () => {
    const drawn = Array.from({ length: 30 }, (_, index) => shouldLabel(index, 30));
    expect(drawn.filter(Boolean).length).toBeLessThanOrEqual(8);
  });

  it("labels every day when they fit", () => {
    const drawn = Array.from({ length: 7 }, (_, index) => shouldLabel(index, 7));
    expect(drawn.every(Boolean)).toBe(true);
  });
});
