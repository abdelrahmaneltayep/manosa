import { describe, expect, it } from "vitest";

import { rangeIsInverted, readDay } from "~/lib/activity/feed.server";

/**
 * The date range on the activity log.
 *
 * An inverted range matched nothing and said nothing: the page rendered the
 * ordinary "nothing of this kind yet", which a merchant reads as a fact about
 * their store rather than as a fact about what they typed.
 */

const day = (value: string) => readDay(value);

describe("an inverted date range", () => {
  it("is the one a merchant needs telling about", () => {
    expect(rangeIsInverted(day("2026-09-07"), day("2026-09-01"))).toBe(true);
  });

  it("is not a range that runs the right way", () => {
    expect(rangeIsInverted(day("2026-09-01"), day("2026-09-07"))).toBe(false);
  });

  it("is not a single day asked for at both ends", () => {
    expect(rangeIsInverted(day("2026-09-01"), day("2026-09-01"))).toBe(false);
  });

  it("is not a range with one end open", () => {
    // "Everything since 7 September" and "everything up to 1 September" are
    // both questions with answers; neither is backwards.
    expect(rangeIsInverted(day("2026-09-07"), null)).toBe(false);
    expect(rangeIsInverted(null, day("2026-09-01"))).toBe(false);
    expect(rangeIsInverted(null, null)).toBe(false);
  });

  it("is not a half-typed date, which reads as no date at all", () => {
    // `readDay` refuses a partial, so "2026-09" is the same as leaving it
    // blank — and a blank end cannot invert a range.
    expect(readDay("2026-09")).toBeNull();
    expect(rangeIsInverted(day("2026-09-07"), readDay("2026-09"))).toBe(false);
  });
});
