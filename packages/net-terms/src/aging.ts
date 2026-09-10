import { addMoney, subtractMoney, zero, type Money } from "@mannon/pricing-engine";

import {
  AGING_BUCKETS,
  type AgingBucket,
  type AgingSummary,
  type Invoice,
} from "./types";

/**
 * How late an invoice is, in the bands an accountant already uses.
 *
 * Whole days, computed in UTC. An invoice due today is current, not one day
 * late: a merchant chasing somebody on the morning of the due date is a
 * merchant losing a customer over a rounding decision.
 */
const DAY_MS = 86_400_000;

export function daysOverdue(dueAt: Date, now: Date): number {
  const due = Date.UTC(dueAt.getUTCFullYear(), dueAt.getUTCMonth(), dueAt.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - due) / DAY_MS);
}

export function bucketFor(dueAt: Date | null, now: Date): AgingBucket {
  // An invoice with no due date was never put on terms, so it is not late.
  if (!dueAt) return "current";

  const late = daysOverdue(dueAt, now);
  if (late <= 0) return "current";
  if (late <= 15) return "days_1_15";
  if (late <= 30) return "days_16_30";
  return "days_30_plus";
}

/** What is still owed on one invoice. Never negative — an overpayment is zero. */
export function balanceOf(invoice: Invoice): Money {
  const remaining = subtractMoney(invoice.amount, invoice.paid);
  return remaining.amount > 0 ? remaining : zero(invoice.amount.currencyCode);
}

export function isSettled(invoice: Invoice): boolean {
  return invoice.paidAt !== null || balanceOf(invoice).amount === 0;
}

/**
 * The ledger's headline numbers.
 *
 * Every bucket appears, including the empty ones: a table that hides "16–30
 * days" when it happens to be empty makes a merchant wonder whether it was
 * dropped or whether nobody is that late.
 *
 * Settled invoices are ignored rather than filtered by the caller, so no caller
 * can forget to.
 */
export function summariseAging(
  invoices: Invoice[],
  now: Date,
  currencyCode: string,
): AgingSummary {
  const totals = new Map<AgingBucket, { outstanding: Money; invoiceCount: number }>(
    AGING_BUCKETS.map((bucket) => [
      bucket,
      { outstanding: zero(currencyCode), invoiceCount: 0 },
    ]),
  );

  let outstanding = zero(currencyCode);
  let overdue = zero(currencyCode);
  let overdueCount = 0;
  let invoiceCount = 0;

  for (const invoice of invoices) {
    if (isSettled(invoice)) continue;

    const balance = balanceOf(invoice);
    // A ledger never converts between currencies; an invoice in another one is
    // counted nowhere rather than added to a total it does not belong in.
    if (balance.currencyCode !== currencyCode) continue;

    const bucket = bucketFor(invoice.dueAt, now);
    const running = totals.get(bucket)!;
    running.outstanding = addMoney(running.outstanding, balance);
    running.invoiceCount += 1;

    outstanding = addMoney(outstanding, balance);
    invoiceCount += 1;

    if (bucket !== "current") {
      overdue = addMoney(overdue, balance);
      overdueCount += 1;
    }
  }

  return {
    buckets: AGING_BUCKETS.map((bucket) => ({ bucket, ...totals.get(bucket)! })),
    outstanding,
    overdue,
    overdueCount,
    invoiceCount,
  };
}

/**
 * Ledger order: the most overdue first, then the soonest due.
 *
 * The same rule as the orders list — what needs chasing is what a merchant
 * opened this page for.
 */
export function byUrgency(a: Invoice, b: Invoice): number {
  if (a.dueAt && b.dueAt) return a.dueAt.getTime() - b.dueAt.getTime();
  // No due date sorts last: it is not on terms, so it is not being chased.
  if (a.dueAt) return -1;
  if (b.dueAt) return 1;
  return a.name.localeCompare(b.name);
}
