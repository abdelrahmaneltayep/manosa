import { money, type Money } from "@mannon/pricing-engine";
import { summariseAging, type AgingBucket } from "@mannon/net-terms";

import { db } from "~/db.server";
import {
  bucketByDay,
  topWithRest,
  type MoneySeries,
  type RankedRow,
} from "~/lib/analytics/series.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * The six charts of checklist §7.
 *
 * Three rules hold across all of them, and they are the reason this module
 * exists rather than six loaders:
 *
 * 1. **One currency.** Every sum is restricted to the shop's own, because a
 *    store selling in two currencies has two revenue figures and adding them
 *    produces a third that is not money. Orders in another currency are
 *    counted and reported as excluded, never silently folded in.
 * 2. **The store's own day.** Bucketing happens in the shop's timezone, so a
 *    merchant in Sydney sees their Monday in Monday's bar.
 * 3. **Nothing here is a price.** These are sums of what Shopify already
 *    charged. The pricing engine decides prices; this counts receipts.
 */

const DAY = 86_400_000;

/** The windows the page offers. Longer than 90 days is not mirrored anyway. */
export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = 30;

export const isRange = (value: number): value is Range =>
  (RANGES as readonly number[]).includes(value);

/**
 * How much history a trend line needs before it means anything.
 *
 * The checklist's rule: "<7 days → daily bars only, no trend line". Under a
 * week, a line through the points is a shape drawn on noise.
 */
export const MIN_TREND_DAYS = 7;

/** How many rows a "top" chart names before the rest is one row. */
export const TOP_ROWS = 10;

export interface ChartWindow {
  range: Range;
  start: Date;
  end: Date;
  timeZone: string | null;
  currencyCode: string;
  /** Days of history this shop has, measured from install. */
  historyDays: number;
  /** Under `MIN_TREND_DAYS`: bars only, and the page says why. */
  partial: boolean;
}

export interface Annotation {
  /** A catalogue key — "installed", "agent_published". */
  key: string;
  day: string;
}

export interface FunnelStep {
  key: "submitted" | "approved" | "ordered";
  value: number;
}

export interface AnalyticsData {
  window: ChartWindow;
  /** Orders in the window this app could not add up. Stated, never hidden. */
  excludedOrders: number;
  /** Orders whose lines Shopify did not fully return — see ADR 0024. */
  ordersMissingLines: number;
  annotations: Annotation[];
  revenue: { wholesale: MoneySeries; retail: MoneySeries };
  byGroup: RankedRow[];
  topBuyers: RankedRow[];
  topProducts: RankedRow[];
  rules: RuleRow[];
  funnel: FunnelStep[];
  aging: { bucket: AgingBucket; amount: Money; count: number }[];
}

export interface RuleRow extends RankedRow {
  /** How many lines this rule priced. */
  lines: number;
  /** What it took off those lines. */
  discounted: number;
  /** False when no current rule has this name — a rename, or a deleted rule. */
  stillExists: boolean;
}

/** Labels a chart needs that are not the merchant's data. */
export interface ChartLabels {
  rest: string;
  retail: string;
  ungrouped: string;
  unnamedBuyer: string;
}

export async function loadAnalytics(options: {
  range: Range;
  now?: Date;
  labels: ChartLabels;
}): Promise<AnalyticsData> {
  const name = shopScope.require("analytics");
  const now = options.now ?? new Date();
  const shop = await db.shop.findUnique({ where: { shop: name } });

  const currencyCode = shop?.currencyCode ?? "USD";
  const timeZone = shop?.ianaTimezone ?? null;
  const start = new Date(now.getTime() - options.range * DAY);

  const historyDays = shop
    ? Math.floor((now.getTime() - shop.installedAt.getTime()) / DAY)
    : 0;

  const window: ChartWindow = {
    range: options.range,
    start,
    end: now,
    timeZone,
    currencyCode,
    historyDays,
    partial: historyDays < MIN_TREND_DAYS,
  };

  // `processedAt` is when Shopify says the order happened. `createdAt` is when
  // Mannon mirrored it, and the install backfill imports sixty days at once —
  // windowing on that reported two months of revenue as "the last 7 days".
  const inWindow = { processedAt: { gte: start, lte: now }, cancelledAt: null };

  const [orders, excludedOrders, ordersMissingLines, agentPublishedAt] =
    await Promise.all([
      db.order.findMany({
        where: { ...inWindow, currencyCode },
        select: {
          id: true,
          customerId: true,
          company: true,
          totalPrice: true,
          refundedAmount: true,
          amountPaid: true,
          netTermsDueAt: true,
          paidAt: true,
          isWholesale: true,
          processedAt: true,
        },
      }),
      // Counted and said out loud rather than quietly dropped: a merchant whose
      // euro orders are missing from a chart deserves to know why.
      db.order.count({ where: { ...inWindow, currencyCode: { not: currencyCode } } }),
      db.order.count({ where: { ...inWindow, currencyCode, linesTruncated: true } }),
      db.agentGuardrails
        .findUnique({ where: { shop: name } })
        .then((guardrails) => guardrails?.publishedAt ?? null),
    ]);

  const wholesaleOrders = orders.filter((order) => order.isWholesale);

  // Refunds come off everywhere else in this app, so they come off here.
  const net = (order: { totalPrice: number; refundedAmount: number }) =>
    Math.max(0, order.totalPrice - order.refundedAmount);

  const series = (rows: typeof orders) =>
    bucketByDay(
      rows.map((order) => ({ at: order.processedAt, amount: net(order) })),
      { start, end: now, timeZone, currencyCode },
    );

  return {
    window,
    excludedOrders,
    ordersMissingLines,
    annotations: annotationsFor(shop?.installedAt ?? null, agentPublishedAt, window),
    revenue: {
      wholesale: series(wholesaleOrders),
      retail: series(orders.filter((order) => !order.isWholesale)),
    },
    byGroup: await revenueByGroup(wholesaleOrders, net, options.labels),
    topBuyers: topWithRest(
      Object.values(
        wholesaleOrders.reduce<Record<string, RankedRow>>((rows, order) => {
          const key = order.customerId ?? `name:${order.company ?? ""}`;
          const label = order.company ?? options.labels.unnamedBuyer;
          rows[key] ??= { key, label, value: 0 };
          rows[key]!.value += net(order);
          return rows;
        }, {}),
      ),
      { limit: TOP_ROWS, restLabel: options.labels.rest },
    ),
    topProducts: await topProducts(
      wholesaleOrders.map((order) => order.id),
      options.labels,
    ),
    rules: await rulePerformance(wholesaleOrders.map((order) => order.id)),
    funnel: await registrationFunnel(start, now),
    aging: agingFor(wholesaleOrders, currencyCode, now),
  };
}

/* -------------------------------------------------------------------------- */

/**
 * The two dates worth marking on a revenue chart.
 *
 * The checklist asks for the Buyer Agent's launch date to be annotated, and the
 * install date for the same reason: a line that starts at zero because the app
 * was not there yet is not a line that starts at zero because nothing sold.
 */
export function annotationsFor(
  installedAt: Date | null,
  agentPublishedAt: Date | null,
  window: ChartWindow,
): Annotation[] {
  const marks: Annotation[] = [];
  const inside = (at: Date) => at >= window.start && at <= window.end;

  if (installedAt && inside(installedAt)) {
    marks.push({ key: "installed", day: dayOf(installedAt, window) });
  }
  if (agentPublishedAt && inside(agentPublishedAt)) {
    marks.push({ key: "agent_published", day: dayOf(agentPublishedAt, window) });
  }
  return marks;
}

const dayOf = (at: Date, window: ChartWindow) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: window.timeZone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

async function revenueByGroup(
  orders: readonly {
    customerId: string | null;
    totalPrice: number;
    refundedAmount: number;
  }[],
  net: (order: { totalPrice: number; refundedAmount: number }) => number,
  labels: ChartLabels,
): Promise<RankedRow[]> {
  const customerIds = [
    ...new Set(
      orders.map((order) => order.customerId).filter((id): id is string => !!id),
    ),
  ];

  const buyers = await db.customer.findMany({
    where: { customerId: { in: customerIds } },
    select: { customerId: true, group: { select: { id: true, name: true } } },
  });

  const groupOf = new Map(
    buyers.map((buyer) => [
      buyer.customerId,
      buyer.group ? { key: buyer.group.id, label: buyer.group.name } : null,
    ]),
  );

  const rows: Record<string, RankedRow> = {};
  for (const order of orders) {
    const group = order.customerId ? groupOf.get(order.customerId) : null;
    // A wholesale buyer in no group is still wholesale revenue; putting them
    // nowhere would make the chart disagree with the total above it.
    const key = group?.key ?? "__ungrouped";
    const label = group?.label ?? labels.ungrouped;
    rows[key] ??= { key, label, value: 0 };
    rows[key]!.value += net(order);
  }

  return topWithRest(Object.values(rows), {
    limit: TOP_ROWS,
    restLabel: labels.rest,
  });
}

async function topProducts(
  orderIds: readonly string[],
  labels: ChartLabels,
): Promise<RankedRow[]> {
  if (orderIds.length === 0) return [];

  const lines = await db.orderLine.findMany({
    where: { orderId: { in: [...orderIds] } },
    select: { productId: true, title: true, discountedTotal: true },
  });

  const rows: Record<string, RankedRow> = {};
  for (const line of lines) {
    // A product deleted in Shopify still sold; keyed by title when its id is
    // gone, so it stays on the chart instead of merging into one blank row.
    const key = line.productId ?? `title:${line.title}`;
    rows[key] ??= { key, label: line.title, value: 0 };
    rows[key]!.value += line.discountedTotal;
  }

  return topWithRest(Object.values(rows), {
    limit: TOP_ROWS,
    restLabel: labels.rest,
  });
}

/**
 * What each pricing rule earned, and what it gave away.
 *
 * Read from the discount **title** on the line — the Function sets the winning
 * rule's name as the message, and that is the only place it survives. So a
 * renamed rule keeps its history under the old name, which is correct (it is
 * the name the buyer saw) and has to be *said*: `stillExists` is false when no
 * current rule carries that name, and the chart labels the row rather than
 * pretending the rule is gone.
 */
async function rulePerformance(orderIds: readonly string[]): Promise<RuleRow[]> {
  if (orderIds.length === 0) return [];

  const [lines, rules] = await Promise.all([
    db.orderLine.findMany({
      where: { orderId: { in: [...orderIds] } },
      select: { discounts: true, discountedTotal: true },
    }),
    db.pricingRule.findMany({ where: { archivedAt: null }, select: { name: true } }),
  ]);

  const known = new Set(rules.map((rule) => rule.name));
  const rows: Record<string, RuleRow> = {};

  for (const line of lines) {
    for (const discount of readDiscounts(line.discounts)) {
      rows[discount.title] ??= {
        key: discount.title,
        label: discount.title,
        value: 0,
        lines: 0,
        discounted: 0,
        stillExists: known.has(discount.title),
      };
      const row = rows[discount.title]!;
      row.lines += 1;
      row.discounted += discount.amount;
      row.value += line.discountedTotal;
    }
  }

  return Object.values(rows).sort((a, b) => b.value - a.value);
}

/** `OrderLine.discounts` read back from JSON, checked rather than asserted. */
export function readDiscounts(value: unknown): { title: string; amount: number }[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title : null;
    const amount = typeof record.amount === "number" ? record.amount : null;
    return title !== null && amount !== null ? [{ title, amount }] : [];
  });
}

/**
 * Submissions → approvals → first order.
 *
 * Each step counts the *same cohort* as it moves: the approvals are approvals
 * of submissions made in this window, not approvals that happened in it. A
 * funnel whose steps count different populations can show more approvals than
 * submissions, which is the classic way this chart lies.
 */
async function registrationFunnel(start: Date, end: Date): Promise<FunnelStep[]> {
  const submissions = await db.formSubmission.findMany({
    where: { createdAt: { gte: start, lte: end } },
    select: { status: true, customerId: true },
  });

  const approved = submissions.filter((row) => row.status === "APPROVED");
  const approvedIds = approved
    .map((row) => row.customerId)
    .filter((id): id is string => Boolean(id));

  const ordered =
    approvedIds.length === 0
      ? 0
      : await db.order
          .findMany({
            where: { customerId: { in: approvedIds }, isWholesale: true },
            select: { customerId: true },
            distinct: ["customerId"],
          })
          .then((rows) => rows.length);

  return [
    { key: "submitted", value: submissions.length },
    { key: "approved", value: approved.length },
    { key: "ordered", value: ordered },
  ];
}

/** The aging report, from the same module the ledger uses. */
function agingFor(
  orders: readonly {
    id: string;
    totalPrice: number;
    refundedAmount: number;
    amountPaid: number;
    paidAt?: Date | null;
    netTermsDueAt: Date | null;
  }[],
  currencyCode: string,
  now: Date,
) {
  const summary = summariseAging(
    orders
      .filter((order) => order.netTermsDueAt !== null)
      .map((order) => ({
        id: order.id,
        name: order.id,
        // Refunds come off the amount owed, as they do on the ledger itself.
        amount: money(Math.max(0, order.totalPrice - order.refundedAmount), currencyCode),
        paid: money(order.amountPaid, currencyCode),
        dueAt: order.netTermsDueAt,
        paidAt: order.paidAt ?? null,
      })),
    now,
    currencyCode,
  );

  return summary.buckets.map((bucket) => ({
    bucket: bucket.bucket,
    amount: bucket.outstanding,
    count: bucket.invoiceCount,
  }));
}
