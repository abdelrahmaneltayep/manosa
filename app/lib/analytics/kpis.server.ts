import { money, type Money } from "@mannon/pricing-engine";

import { db } from "~/db.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * The five numbers on Home.
 *
 * Two of them are about a period and move; three are about right now and do
 * not. Keeping that distinction in the type is the point: a "period" metric
 * can be compared with the period before it, and a "standing" one cannot — an
 * arrow beside "4 active pricing rules" would be comparing today's count with
 * a count nobody took.
 *
 * Nothing here is a price, so nothing here comes from the engine. These are
 * sums of what Shopify already charged.
 */

/** The checklist's period selector. */
export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

export const DEFAULT_PERIOD: Period = 30;

export function isPeriod(value: number): value is Period {
  return (PERIODS as readonly number[]).includes(value);
}

/**
 * How much history a metric needs before it means anything.
 *
 * Under a week, a week-on-week comparison is arithmetic on noise. The card
 * says "—" and why, rather than printing a number that will embarrass it.
 */
export const MIN_HISTORY_DAYS = 7;

const DAY = 86_400_000;

export interface KpiMoney {
  kind: "money";
  value: Money;
  /** The same figure for the period before this one. Null when unknowable. */
  previous: Money | null;
}

export interface KpiCount {
  kind: "count";
  value: number;
  previous: number | null;
}

export type KpiValue = KpiMoney | KpiCount;

export interface Kpi {
  key:
    | "wholesale_revenue"
    | "wholesale_orders"
    | "pending_approvals"
    | "active_rules"
    | "terms_outstanding";
  value: KpiValue;
  /** True when the shop has not been installed long enough to say. */
  partial: boolean;
  /** Where the merchant goes to see what feeds this number. */
  href: string;
}

export interface KpiSet {
  period: Period;
  currencyCode: string;
  kpis: Kpi[];
  /** Days of history this shop has. Under `MIN_HISTORY_DAYS`, cards say so. */
  historyDays: number;
}

/**
 * Read the five, for one period.
 *
 * Every sum is restricted to the shop's own currency. A store selling in two
 * currencies has two revenue figures, and adding them together produces a third
 * that is not money — see the same rule in the Merchant Agent's facts.
 */
export async function loadKpis(
  period: Period,
  options: { now?: Date } = {},
): Promise<KpiSet> {
  const now = options.now ?? new Date();
  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("kpis") },
  });
  const currencyCode = shop?.currencyCode ?? "USD";

  const start = new Date(now.getTime() - period * DAY);
  const previousStart = new Date(now.getTime() - period * 2 * DAY);

  // `processedAt` is when Shopify says the order happened. `createdAt` is when
  // Mannon mirrored it — which for the sixty days the install backfill imports
  // is the install itself, so windowing on it would have reported two months of
  // revenue as "the last 7 days".
  const wholesale = { isWholesale: true, cancelledAt: null };
  const inCurrency = { ...wholesale, currencyCode };

  const [
    current,
    previous,
    currentCount,
    previousCount,
    pendingApprovals,
    activeRules,
    outstanding,
  ] = await Promise.all([
    // The count is of every wholesale order; the sum is only of the ones
    // priced in the shop's own currency. Restricting the count too made a
    // shop with euro orders read "12 wholesale orders" when it had 20, while
    // the briefing directly below said 20.
    db.order.aggregate({
      where: { ...inCurrency, processedAt: { gte: start } },
      _sum: { totalPrice: true },
    }),
    db.order.aggregate({
      where: { ...inCurrency, processedAt: { gte: previousStart, lt: start } },
      _sum: { totalPrice: true },
    }),
    db.order.count({ where: { ...wholesale, processedAt: { gte: start } } }),
    db.order.count({
      where: { ...wholesale, processedAt: { gte: previousStart, lt: start } },
    }),
    db.formSubmission.count({ where: { status: "PENDING" } }),
    db.pricingRule.count({ where: { status: "ACTIVE", archivedAt: null } }),
    // The same four conditions the terms ledger uses, so the card and the
    // page it links to answer the same question.
    db.order.findMany({
      where: {
        isWholesale: true,
        paidAt: null,
        cancelledAt: null,
        currencyCode,
        netTermsDueAt: { not: null },
      },
      select: { totalPrice: true, amountPaid: true, refundedAmount: true },
    }),
  ]);

  // Refunds come off, as they do everywhere else in the app. Without this the
  // card said $1,000.00 and the ledger it links to said $600.00.
  const owed = outstanding.reduce(
    (sum, order) =>
      sum + Math.max(0, order.totalPrice - order.refundedAmount - order.amountPaid),
    0,
  );

  // Measured from the install, because that is the first moment this app could
  // have seen an order. A store that has sold wholesale for ten years still has
  // one day of data here on its first day, and saying otherwise is a claim
  // about numbers we do not have.
  const historyDays = shop
    ? Math.floor((now.getTime() - shop.installedAt.getTime()) / DAY)
    : 0;
  const partial = historyDays < MIN_HISTORY_DAYS;

  return {
    period,
    currencyCode,
    historyDays,
    kpis: [
      {
        key: "wholesale_revenue",
        value: {
          kind: "money",
          value: money(current._sum.totalPrice ?? 0, currencyCode),
          previous: money(previous._sum.totalPrice ?? 0, currencyCode),
        },
        partial,
        href: "/app/orders",
      },
      {
        key: "wholesale_orders",
        value: { kind: "count", value: currentCount, previous: previousCount },
        partial,
        href: "/app/orders",
      },
      {
        key: "pending_approvals",
        value: { kind: "count", value: pendingApprovals, previous: null },
        partial: false,
        href: "/app/customers/applications",
      },
      {
        key: "active_rules",
        value: { kind: "count", value: activeRules, previous: null },
        partial: false,
        href: "/app/pricing",
      },
      {
        key: "terms_outstanding",
        value: { kind: "money", value: money(owed, currencyCode), previous: null },
        partial: false,
        href: "/app/orders/terms",
      },
    ],
  };
}

/**
 * The percentage change, when there is one.
 *
 * Null when the base period is zero: "▲ ∞%" is not a number, and "▲ 400%" off
 * one order last week is a number that misleads. The card shows the two
 * figures instead and lets the merchant do the comparison they trust.
 */
export function deltaPercent(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}
