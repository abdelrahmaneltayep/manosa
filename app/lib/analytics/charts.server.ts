import { money, type Money } from "@mannon/pricing-engine";
import { summariseAging, type AgingBucket } from "@mannon/net-terms";

import { db } from "~/db.server";
import { orderRevenue } from "~/lib/orders/totals";
import {
  bucketByDay,
  localDay,
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

/**
 * The first instant of the store-local day an instant falls in.
 *
 * Walked back an hour at a time rather than computed, because an offset is not
 * a constant: a zone that moves its clocks does not have a fixed distance to
 * its own midnight, and the two days a year that is true are exactly the days
 * an off-by-one here would be invisible.
 */
export function startOfLocalDay(at: Date, timeZone: string | null): Date {
  const day = localDay(at, timeZone);
  let cursor = at.getTime();

  while (localDay(new Date(cursor - 60 * 60 * 1000), timeZone) === day) {
    cursor -= 60 * 60 * 1000;
  }
  // Then to the minute, so a zone with a half-hour or 45-minute offset lands
  // on its own midnight rather than an hour inside it.
  while (localDay(new Date(cursor - 60 * 1000), timeZone) === day) {
    cursor -= 60 * 1000;
  }
  return new Date(cursor);
}

/** One mirrored order line, as the charts read it. */
interface ChartLine {
  productId: string | null;
  title: string;
  currentTotal: number;
  currentQuantity: number;
  discounts: unknown;
}

/**
 * The most orders one view will read.
 *
 * A 90-day window on the 10k-order store Appendix A asks us to test against is
 * a `findMany` with no ceiling on a page carrying an LCP budget. The cap is
 * generous enough that a real shop never meets it, and `ordersCapped` says so
 * when one does rather than quietly charting a subset.
 */
export const MAX_ORDERS = 5_000;

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
  /** The window had more orders than one view reads. Said, never silent. */
  ordersCapped: boolean;
  annotations: Annotation[];
  revenue: { wholesale: MoneySeries; retail: MoneySeries };
  /**
   * Average wholesale order value, and the orders it is an average of.
   *
   * `pages-features.md` §7 asks for AOV; `feature-checklist.md` §7 does not
   * list it. Included because it is one division away from figures already
   * here and a merchant asked for it. A single current value is a stat, not a
   * chart — a one-bar bar chart of an average would say less than the number.
   */
  aov: { value: Money; orders: number };
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
  // Snapped to the beginning of a store-local day, so "Last 7 days" is seven
  // whole days and not eight buckets whose first is a half-day drawn at full
  // width. Counting back `range - 1` days from today makes today the seventh.
  const start = startOfLocalDay(
    new Date(now.getTime() - (options.range - 1) * DAY),
    timeZone,
  );

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

  const [orders, excludedOrders, ordersMissingLines, outstanding, agentPublishedAt] =
    await Promise.all([
      db.order.findMany({
        where: { ...inWindow, currencyCode },
        select: {
          id: true,
          customerId: true,
          company: true,
          totalPrice: true,
          refundedAmount: true,
          isWholesale: true,
          processedAt: true,
        },
        orderBy: { processedAt: "desc" },
        take: MAX_ORDERS + 1,
      }),
      // Counted and said out loud rather than quietly dropped: a merchant whose
      // euro orders are missing from a chart deserves to know why.
      db.order.count({ where: { ...inWindow, currencyCode: { not: currencyCode } } }),
      db.order.count({ where: { ...inWindow, currencyCode, linesTruncated: true } }),
      // **Not** windowed. An aging report is about invoices that are late, and
      // a late invoice was issued long ago — usually further back than the
      // window. Filtering it by `processedAt` made the chart contradict
      // `/app/orders/terms` by construction and put a whole bucket
      // ("over 30 days late", in a 30-day window) permanently out of reach.
      // This is a standing figure, like the KPI cards' "outstanding": it is
      // true as of today, and the card says so.
      db.order.findMany({
        where: {
          isWholesale: true,
          cancelledAt: null,
          currencyCode,
          paidAt: null,
          netTermsDueAt: { not: null },
        },
        select: {
          id: true,
          totalPrice: true,
          refundedAmount: true,
          amountPaid: true,
          netTermsDueAt: true,
          paidAt: true,
        },
      }),
      db.agentGuardrails
        .findUnique({ where: { shop: name } })
        .then((guardrails) => guardrails?.publishedAt ?? null),
    ]);

  const ordersCapped = orders.length > MAX_ORDERS;
  if (ordersCapped) orders.length = MAX_ORDERS;

  const wholesaleOrders = orders.filter((order) => order.isWholesale);

  const [lines, activeRuleNames] = await Promise.all([
    wholesaleOrders.length === 0
      ? Promise.resolve([])
      : db.orderLine.findMany({
          where: { orderId: { in: wholesaleOrders.map((order) => order.id) } },
          select: {
            productId: true,
            title: true,
            currentTotal: true,
            currentQuantity: true,
            discounts: true,
          },
        }),
    db.pricingRule
      .findMany({ where: { archivedAt: null }, select: { name: true } })
      .then((rules) => new Set(rules.map((rule) => rule.name))),
  ]);

  /**
   * What the merchant actually kept.
   *
   * `Order.totalPrice` is written from Shopify's `current_total_price`, which
   * is **already** net of refunds and edits — so subtracting `refundedAmount`
   * removes the refund a second time. That version put four different numbers
   * for one order on four screens a merchant can open side by side.
   *
   * `refundedAmount` is kept for the gross figure, which is
   * `totalPrice + refundedAmount`, not the other way round.
   */
  const net = (order: { totalPrice: number }) => Math.max(0, order.totalPrice);

  const series = (rows: typeof orders) =>
    bucketByDay(
      rows.map((order) => ({ at: order.processedAt, amount: net(order) })),
      { start, end: now, timeZone, currencyCode },
    );

  return {
    window,
    excludedOrders,
    ordersMissingLines,
    ordersCapped,
    annotations: annotationsFor(shop?.installedAt ?? null, agentPublishedAt, window),
    revenue: {
      wholesale: series(wholesaleOrders),
      retail: series(orders.filter((order) => !order.isWholesale)),
    },
    aov: {
      value: money(
        wholesaleOrders.length === 0
          ? 0
          : Math.round(
              wholesaleOrders.reduce((sum, order) => sum + net(order), 0) /
                wholesaleOrders.length,
            ),
        currencyCode,
      ),
      orders: wholesaleOrders.length,
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
    // Read once and handed to both consumers. Each used to run its own
    // `findMany` over the same order ids, so every line of every order was
    // materialised in Node twice per page view and once more per CSV export.
    topProducts: topProducts(lines, options.labels),
    rules: rulePerformance(lines, activeRuleNames),
    funnel: await registrationFunnel(start, now),
    aging: agingFor(outstanding, currencyCode, now),
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

function topProducts(lines: readonly ChartLine[], labels: ChartLabels): RankedRow[] {
  const rows: Record<string, RankedRow> = {};
  for (const line of lines) {
    // A product deleted in Shopify still sold; keyed by title when its id is
    // gone, so it stays on the chart instead of merging into one blank row.
    const key = line.productId ?? `title:${line.title}`;
    rows[key] ??= { key, label: line.title, value: 0 };
    // `currentTotal`, not `discountedTotal`: the second is what was ordered,
    // which counts a fully refunded line as money the merchant still has.
    rows[key]!.value += line.currentTotal;
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
function rulePerformance(
  lines: readonly ChartLine[],
  known: ReadonlySet<string>,
): RuleRow[] {
  const rows: Record<string, RuleRow> = {};

  for (const line of lines) {
    // A line that went back entirely earned its rule nothing, and counting it
    // would credit a rule for revenue the merchant refunded.
    if (line.currentQuantity <= 0) continue;

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
      row.value += line.currentTotal;
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
    select: { status: true, customerId: true, createdAt: true },
  });

  const approved = submissions.filter((row) => row.status === "APPROVED");
  const approvedIds = approved
    .map((row) => row.customerId)
    .filter((id): id is string => Boolean(id));

  // "Ordered" means *this application led to an order*: a real one, placed
  // after they applied. Without the date bound and the cancellation check, a
  // buyer's cancelled order from eight months before they applied counted as a
  // conversion — which on a store converting its existing retail customers to
  // wholesale, the normal case for this product, inflates the last step
  // systematically and can claim 100%.
  const appliedAt = new Map(
    approved
      .filter((row) => row.customerId)
      .map((row) => [row.customerId!, row.createdAt]),
  );

  const candidates =
    approvedIds.length === 0
      ? []
      : await db.order.findMany({
          where: {
            customerId: { in: approvedIds },
            isWholesale: true,
            cancelledAt: null,
          },
          select: { customerId: true, processedAt: true },
        });

  const converted = new Set(
    candidates
      .filter((order) => {
        const applied = order.customerId ? appliedAt.get(order.customerId) : undefined;
        return applied !== undefined && order.processedAt >= applied;
      })
      .map((order) => order.customerId),
  );
  const ordered = converted.size;

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
        amount: money(orderRevenue(order), currencyCode),
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
