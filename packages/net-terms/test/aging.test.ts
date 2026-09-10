import { money, zero } from "@mannon/pricing-engine";
import { describe, expect, it } from "vitest";

import {
  balanceOf,
  bucketFor,
  byUrgency,
  daysOverdue,
  isSettled,
  summariseAging,
} from "../src/aging";
import type { Invoice } from "../src/types";

const usd = (amount: number) => money(amount, "USD");
const NOW = new Date("2026-09-10T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const daysAhead = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

const invoice = (overrides: Partial<Invoice> = {}): Invoice => ({
  id: "i1",
  name: "#1001",
  amount: usd(100000),
  paid: zero("USD"),
  dueAt: daysAhead(10),
  paidAt: null,
  ...overrides,
});

describe("bucketFor", () => {
  it("counts an invoice due today as current, not a day late", () => {
    // A merchant chasing somebody on the morning of the due date loses a
    // customer over a rounding decision.
    expect(bucketFor(new Date("2026-09-10T23:59:00Z"), NOW)).toBe("current");
    expect(bucketFor(new Date("2026-09-10T00:01:00Z"), NOW)).toBe("current");
  });

  it("uses the checklist's bands", () => {
    expect(bucketFor(daysAhead(5), NOW)).toBe("current");
    expect(bucketFor(daysAgo(1), NOW)).toBe("days_1_15");
    expect(bucketFor(daysAgo(15), NOW)).toBe("days_1_15");
    expect(bucketFor(daysAgo(16), NOW)).toBe("days_16_30");
    expect(bucketFor(daysAgo(30), NOW)).toBe("days_16_30");
    expect(bucketFor(daysAgo(31), NOW)).toBe("days_30_plus");
  });

  it("calls an invoice that was never on terms current, not late", () => {
    expect(bucketFor(null, NOW)).toBe("current");
  });

  it("counts whole days regardless of the time of day", () => {
    expect(daysOverdue(new Date("2026-09-09T23:00:00Z"), NOW)).toBe(1);
    expect(daysOverdue(new Date("2026-09-10T01:00:00Z"), NOW)).toBe(0);
  });
});

describe("balanceOf", () => {
  it("subtracts what has been paid", () => {
    expect(balanceOf(invoice({ paid: usd(40000) }))).toEqual(usd(60000));
  });

  it("never reports a negative balance on an overpayment", () => {
    expect(balanceOf(invoice({ paid: usd(120000) }))).toEqual(zero("USD"));
  });

  it("treats a fully paid invoice as settled, with or without a date", () => {
    expect(isSettled(invoice({ paid: usd(100000) }))).toBe(true);
    expect(isSettled(invoice({ paidAt: daysAgo(1) }))).toBe(true);
    expect(isSettled(invoice({ paid: usd(40000) }))).toBe(false);
  });
});

describe("summariseAging", () => {
  it("totals each bucket and the whole ledger", () => {
    const summary = summariseAging(
      [
        invoice({ id: "a", dueAt: daysAhead(5), amount: usd(10000) }),
        invoice({ id: "b", dueAt: daysAgo(3), amount: usd(20000) }),
        invoice({ id: "c", dueAt: daysAgo(20), amount: usd(30000) }),
        invoice({ id: "d", dueAt: daysAgo(60), amount: usd(40000) }),
      ],
      NOW,
      "USD",
    );

    expect(summary.outstanding).toEqual(usd(100000));
    expect(summary.overdue).toEqual(usd(90000));
    expect(summary.overdueCount).toBe(3);
    expect(summary.invoiceCount).toBe(4);
    expect(summary.buckets.map((b) => b.outstanding.amount)).toEqual([
      10000, 20000, 30000, 40000,
    ]);
  });

  it("shows every bucket even when it is empty", () => {
    // A table that hides "16–30 days" leaves a merchant wondering whether it
    // was dropped or whether nobody is that late.
    const summary = summariseAging([], NOW, "USD");
    expect(summary.buckets).toHaveLength(4);
    expect(summary.buckets.every((b) => b.invoiceCount === 0)).toBe(true);
    expect(summary.outstanding).toEqual(zero("USD"));
  });

  it("counts only what is still owed, and skips settled invoices", () => {
    const summary = summariseAging(
      [
        invoice({ id: "a", amount: usd(100000), paid: usd(60000), dueAt: daysAgo(5) }),
        invoice({ id: "b", amount: usd(50000), paid: usd(50000), dueAt: daysAgo(5) }),
        invoice({ id: "c", amount: usd(50000), paidAt: daysAgo(1), dueAt: daysAgo(5) }),
      ],
      NOW,
      "USD",
    );

    expect(summary.outstanding).toEqual(usd(40000));
    expect(summary.invoiceCount).toBe(1);
  });

  it("never adds an invoice in another currency into the total", () => {
    const summary = summariseAging(
      [
        invoice({ id: "a", amount: usd(10000) }),
        invoice({ id: "b", amount: money(90000, "SAR"), paid: zero("SAR") }),
      ],
      NOW,
      "USD",
    );

    expect(summary.outstanding).toEqual(usd(10000));
    expect(summary.invoiceCount).toBe(1);
  });
});

describe("byUrgency", () => {
  it("puts the most overdue first and the not-on-terms last", () => {
    const rows = [
      invoice({ id: "soon", dueAt: daysAhead(2) }),
      invoice({ id: "none", dueAt: null, name: "#0001" }),
      invoice({ id: "late", dueAt: daysAgo(40) }),
    ].sort(byUrgency);

    expect(rows.map((row) => row.id)).toEqual(["late", "soon", "none"]);
  });
});
