import type { Order, Prisma } from "@prisma/client";

import { db } from "~/db.server";

/**
 * Reading the wholesale order mirror.
 *
 * Every query here is shop-scoped by the Prisma extension; none of them reach
 * Shopify. That is the point of the mirror: sorting a store's wholesale orders
 * by "overdue first" and totalling a period is a database question, and asking
 * the Admin API it would cost a page load per screen.
 */

export const ORDERS_PAGE_SIZE = 25;

export type PaymentState =
  | "paid"
  | "overdue"
  | "due"
  | "pending"
  | "refunded"
  | "partially_refunded"
  | "cancelled";

export interface OrderFilters {
  search: string;
  /** "", "storefront", "quick_order", "buyer_agent", "draft", "pos", "other" */
  source: string;
  /** "", "paid", "outstanding", "overdue", "refunded" */
  payment: string;
}

export const EMPTY_FILTERS: OrderFilters = { search: "", source: "", payment: "" };

/**
 * What state a merchant would call this order's payment.
 *
 * Shopify's `financialStatus` answers most of it. Net terms are the part it
 * cannot know about — an order Shopify calls "pending" is either awaiting a
 * card or on agreed terms, and those are not the same row in a wholesale list.
 */
export function paymentState(order: Order, now: Date): PaymentState {
  if (order.cancelledAt) return "cancelled";

  switch (order.financialStatus) {
    case "refunded":
      return "refunded";
    case "partially_refunded":
      return "partially_refunded";
    case "paid":
      return "paid";
    default:
      break;
  }

  if (order.paidAt) return "paid";
  if (order.netTermsDueAt) {
    return order.netTermsDueAt.getTime() < now.getTime() ? "overdue" : "due";
  }
  return "pending";
}

/** Whole days until terms are due; negative once they are past. */
export function daysUntilDue(order: Order, now: Date): number | null {
  if (!order.netTermsDueAt) return null;
  const DAY_MS = 86_400_000;
  return Math.round((order.netTermsDueAt.getTime() - now.getTime()) / DAY_MS);
}

function whereFor(filters: OrderFilters, now: Date): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = { isWholesale: true };
  const and: Prisma.OrderWhereInput[] = [];

  const search = filters.search.trim();
  if (search) {
    and.push({
      OR: [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { company: { contains: search, mode: "insensitive" } },
      ],
    });
  }

  if (filters.source) {
    // An unknown value filters to nothing rather than being ignored: a filter
    // that silently does not apply is worse than one that shows no rows.
    and.push({ source: filters.source.toUpperCase() as Order["source"] });
  }

  switch (filters.payment) {
    case "paid":
      and.push({ OR: [{ financialStatus: "paid" }, { paidAt: { not: null } }] });
      break;
    case "overdue":
      and.push({ paidAt: null, netTermsDueAt: { lt: now }, cancelledAt: null });
      break;
    case "outstanding":
      and.push({
        paidAt: null,
        cancelledAt: null,
        financialStatus: { not: "paid" },
      });
      break;
    case "refunded":
      and.push({
        OR: [
          { financialStatus: { in: ["refunded", "partially_refunded"] } },
          { refundedAmount: { gt: 0 } },
        ],
      });
      break;
    default:
      break;
  }

  if (and.length > 0) where.AND = and;
  return where;
}

export interface OrderListResult {
  rows: Order[];
  total: number;
  totalUnfiltered: number;
  page: number;
  pageSize: number;
}

/**
 * A page of wholesale orders, overdue first.
 *
 * "Overdue rows float to top by default sort" (checklist §5). That is not a
 * column the database has, so it is expressed as: anything with a due date in
 * the past, oldest due date first, then everything else newest first. Two
 * queries rather than one clever one — the alternative is raw SQL that the
 * tenant extension cannot scope, and an unscoped query is not worth the tidiness.
 */
export async function listOrders(
  filters: OrderFilters,
  { page = 1, pageSize = ORDERS_PAGE_SIZE, now = new Date() } = {},
): Promise<OrderListResult> {
  const where = whereFor(filters, now);
  const base = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];

  const isOverdue: Prisma.OrderWhereInput = {
    paidAt: null,
    cancelledAt: null,
    netTermsDueAt: { lt: now },
  };

  // The complement, spelled out rather than written as `NOT: isOverdue`. In SQL
  // a NULL due date makes `netTermsDueAt < now` unknown, so the whole NOT is
  // unknown and the row matches neither band — every order without net terms
  // would silently vanish from the second page.
  const isNotOverdue: Prisma.OrderWhereInput = {
    OR: [
      { paidAt: { not: null } },
      { cancelledAt: { not: null } },
      { netTermsDueAt: null },
      { netTermsDueAt: { gte: now } },
    ],
  };

  const overdueWhere: Prisma.OrderWhereInput = { ...where, AND: [...base, isOverdue] };
  const restWhere: Prisma.OrderWhereInput = { ...where, AND: [...base, isNotOverdue] };

  const [total, totalUnfiltered, overdueTotal] = await Promise.all([
    db.order.count({ where }),
    db.order.count({ where: { isWholesale: true } }),
    db.order.count({ where: overdueWhere }),
  ]);

  const skip = Math.max(0, (page - 1) * pageSize);
  const rows: Order[] = [];

  // The overdue band first, oldest debt at the top.
  if (skip < overdueTotal) {
    rows.push(
      ...(await db.order.findMany({
        where: overdueWhere,
        orderBy: [{ netTermsDueAt: "asc" }, { processedAt: "desc" }],
        skip,
        take: pageSize,
      })),
    );
  }

  if (rows.length < pageSize) {
    const restSkip = Math.max(0, skip - overdueTotal);
    rows.push(
      ...(await db.order.findMany({
        where: restWhere,
        orderBy: [{ processedAt: "desc" }, { name: "desc" }],
        skip: restSkip,
        take: pageSize - rows.length,
      })),
    );
  }

  return { rows, total, totalUnfiltered, page, pageSize };
}

export async function countNeedingResync(): Promise<number> {
  return db.order.count({ where: { isWholesale: true, needsResync: true } });
}
