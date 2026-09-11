import { describe, expect, it } from "vitest";

import {
  diffOf,
  factLines,
  monthOf,
  monthStart,
  nextMonth,
  previousMonth,
  type MonthFacts,
} from "~/lib/analytics/review.server";
import { readReview } from "~/lib/ai/prompts/monthly-review.server";
import { withoutSlots } from "~/lib/ai/prompts/buyer-agent.server";

/**
 * Which month a month is.
 *
 * The whole feature turns on this: a review headed "March" that begins on the
 * 28th of February is a review of something else. A merchant's month is their
 * month, in their timezone, and none of the obvious ways to compute that are
 * right across a date line or a clock change.
 */

describe("the first instant of a month", () => {
  const iso = (at: Date) => at.toISOString();

  it("is local midnight, not UTC midnight", () => {
    // Sydney is ten hours ahead: their March begins while it is still
    // February in London.
    expect(iso(monthStart("2026-03", "Australia/Sydney"))).toBe(
      "2026-02-28T13:00:00.000Z",
    );
    expect(iso(monthStart("2026-03", "UTC"))).toBe("2026-03-01T00:00:00.000Z");
    // And Denver's begins seven hours after UTC's.
    expect(iso(monthStart("2026-03", "America/Denver"))).toBe("2026-03-01T07:00:00.000Z");
  });

  it("falls back to UTC when the shop's timezone was never read", () => {
    expect(iso(monthStart("2026-03", null))).toBe("2026-03-01T00:00:00.000Z");
  });

  /**
   * Both halves, every month, every awkward zone.
   *
   * The old version of this test asserted only that the start instant is
   * *somewhere* in the month — which is still true when the month begins at
   * 01:00 on the **2nd**, and it did, for every zone at UTC+12 or further
   * east. The instant one millisecond earlier has to be in the month before,
   * or it is not the start of anything.
   */
  it("is the first local instant of the month, and nothing before it", () => {
    const zones = [
      "UTC",
      "Australia/Sydney",
      "America/Denver",
      "Asia/Riyadh",
      // Past UTC+12, where walking backwards from midday UTC never ran.
      "Pacific/Auckland",
      "Pacific/Apia",
      "Pacific/Tongatapu",
      "Pacific/Kiritimati",
      // Not on the hour: an hour-stepping loop cannot land on :45.
      "Pacific/Chatham",
      "Asia/Kathmandu",
      "Australia/Eucla",
      // Behind UTC, and the half-hour ones.
      "Pacific/Honolulu",
      "America/St_Johns",
      "Asia/Tehran",
    ];

    for (const zone of zones) {
      for (let index = 1; index <= 12; index += 1) {
        const month = `2026-${String(index).padStart(2, "0")}`;
        const start = monthStart(month, zone);

        expect(monthOf(start, zone), `${zone} ${month} start`).toBe(month);
        expect(
          monthOf(new Date(start.getTime() - 1), zone),
          `${zone} ${month} the instant before`,
        ).toBe(previousMonth(month));
      }
    }
  });

  it("is still the first across a clock change", () => {
    // Some zones move their clocks at midnight, which is the one night
    // "midnight" is not a time that exists.
    for (const zone of ["America/Santiago", "Asia/Beirut", "Europe/London"]) {
      for (const month of ["2026-03", "2026-04", "2026-10", "2026-11"]) {
        expect(monthOf(monthStart(month, zone), zone)).toBe(month);
        expect(monthOf(new Date(monthStart(month, zone).getTime() - 1), zone)).toBe(
          previousMonth(month),
        );
      }
    }
  });
});

describe("the month before and after", () => {
  it("walks back over a year boundary", () => {
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(previousMonth("2026-09")).toBe("2026-08");
  });

  it("walks forward over one too", () => {
    expect(nextMonth("2026-12")).toBe("2027-01");
    expect(nextMonth("2026-09")).toBe("2026-10");
  });

  it("keeps two digits, so the strings still sort", () => {
    expect(nextMonth("2026-08")).toBe("2026-09");
    expect(previousMonth("2026-11")).toBe("2026-10");
  });
});

/* -------------------------------------------------------------------------- */

const facts = (overrides: Partial<MonthFacts> = {}): MonthFacts => ({
  month: "2026-09",
  currencyCode: "USD",
  wholesaleRevenue: { amount: 1_240_000, currencyCode: "USD" },
  retailRevenue: { amount: 310_000, currencyCode: "USD" },
  wholesaleOrders: 42,
  buyers: 18,
  newBuyers: 4,
  applications: 12,
  approvals: 7,
  owedNow: { amount: 420_000, currencyCode: "USD" },
  overdueNow: { amount: 90_000, currencyCode: "USD" },
  topBuyer: { label: "Café Aroma", amount: { amount: 310_000, currencyCode: "USD" } },
  topProduct: {
    label: "House Blend 1kg",
    amount: { amount: 260_000, currencyCode: "USD" },
  },
  deadRules: ["Launch offer"],
  quietBuyers: 3,
  ...overrides,
});

describe("what the model is told", () => {
  it("hands over slot names, never figures", () => {
    const { facts: lines, slots } = factLines(facts(), "en");

    // A fact line carrying a rendered number is a number the model can retype
    // slightly differently, and the guard cannot tell the two apart. Slot
    // *names* carry digits, so the check is the same one the guard makes:
    // no digit outside a slot.
    for (const line of lines) {
      expect(withoutSlots(line)).not.toMatch(/\p{Nd}/u);
    }
    expect(slots.f1).toBe("$12,400.00");
    expect(slots.q1).toBe("42");
  });

  it("names the biggest buyer and product only when there is one", () => {
    const quiet = factLines(facts({ topBuyer: null, topProduct: null }), "en");
    expect(quiet.slots.n1).toBeUndefined();
    expect(quiet.facts.some((line) => line.includes("biggest"))).toBe(false);

    const busy = factLines(facts(), "en");
    expect(busy.slots.n1).toBe("Café Aroma");
    expect(busy.slots.n2).toBe("House Blend 1kg");
  });

  it("offers each dead rule as its own slot", () => {
    const { slots } = factLines(facts({ deadRules: ["Launch offer", "Old tier"] }), "en");
    expect(slots.r1).toBe("Launch offer");
    expect(slots.r2).toBe("Old tier");
  });

  it("produces exactly the slots a review may then write", () => {
    // The contract between the two halves: `readReview` refuses any slot it
    // was not given, so these have to be the same set.
    const { slots } = factLines(facts(), "en");
    const read = readReview(slots);

    expect(
      read({
        quiet: false,
        sections: [
          {
            kind: "worked",
            headline: "{{n1}} led the month",
            body: "Wholesale took {{f1}} across {{q1}} orders.",
            action: "open_pricing",
            because: [],
          },
        ],
      }).ok,
    ).toBe(true);
  });
});

describe("what moved since last month", () => {
  it("is nothing at all for a shop's first month", () => {
    // A diff against a month that does not exist is not zero growth.
    expect(diffOf(facts(), null)).toBeNull();
  });

  it("subtracts the month before", () => {
    const last = facts({
      wholesaleRevenue: { amount: 1_000_000, currencyCode: "USD" },
      wholesaleOrders: 30,
      buyers: 20,
    });

    expect(diffOf(facts(), last)).toEqual({
      wholesaleRevenue: 240_000,
      wholesaleOrders: 12,
      buyers: -2,
    });
  });
});
