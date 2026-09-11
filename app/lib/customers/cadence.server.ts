import { db } from "~/db.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * When a buyer is due to order again.
 *
 * Checklist §3 asks the buyers list for *"last order (+ ✦ 'due to reorder'
 * chip when prediction fires)"*. `dueToReorder` has been a hardcoded `false`
 * in the view model since 2.1, under a comment saying it needed the AI layer,
 * and `reorder_prediction` has carried a prompt version since 4.1 with no
 * prompt behind it. A badge that cannot render is the fifth control of this
 * shape this repo has found.
 *
 * It does not need a model. Appendix B: *the model never computes what a
 * deterministic module can*. A buyer who orders every three weeks and last
 * ordered four weeks ago is due, and that is arithmetic — a sentence from
 * Claude saying the same thing would be the same number with a licence fee and
 * a failure mode.
 *
 * What it will not do is guess. Two orders make one interval, and one interval
 * is not a rhythm; a buyer needs at least three orders before this says
 * anything at all. The alternative — a chip that fires on every second-time
 * buyer — is a merchant learning to ignore it.
 */

/** Two intervals, so one unusual gap cannot be the whole pattern. */
export const MIN_ORDERS_FOR_CADENCE = 3;

/** A year. A rhythm from three years ago is not this buyer's rhythm. */
export const CADENCE_WINDOW_DAYS = 365;

/** Longest gap that still reads as a rhythm rather than two separate visits. */
export const MAX_CADENCE_DAYS = 180;

const DAY = 86_400_000;

export interface Cadence {
  /** The typical gap between this buyer's orders, in whole days. */
  everyDays: number;
  /** How long since their last one. */
  daysSince: number;
  /** How many orders the rhythm was read from. */
  orders: number;
  due: boolean;
}

/** The middle value, which one long holiday gap cannot drag around. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

/**
 * Cadence for a page of buyers, in one query.
 *
 * Takes the Shopify customer GIDs the list is showing — `Order.customerId` is
 * Shopify's GID, not this app's row id — and returns only the buyers who have
 * a rhythm at all.
 */
export async function cadenceFor(
  customerIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, Cadence>> {
  shopScope.require("cadenceFor");
  const found = new Map<string, Cadence>();
  if (customerIds.length === 0) return found;

  const orders = await db.order.findMany({
    where: {
      customerId: { in: [...customerIds] },
      isWholesale: true,
      cancelledAt: null,
      processedAt: { gte: new Date(now.getTime() - CADENCE_WINDOW_DAYS * DAY) },
    },
    select: { customerId: true, processedAt: true },
    orderBy: { processedAt: "asc" },
  });

  const byBuyer = new Map<string, Date[]>();
  for (const order of orders) {
    if (!order.customerId) continue;
    const list = byBuyer.get(order.customerId);
    if (list) list.push(order.processedAt);
    else byBuyer.set(order.customerId, [order.processedAt]);
  }

  for (const [customerId, dates] of byBuyer) {
    if (dates.length < MIN_ORDERS_FOR_CADENCE) continue;

    const gaps: number[] = [];
    for (let at = 1; at < dates.length; at += 1) {
      gaps.push(Math.round((dates[at]!.getTime() - dates[at - 1]!.getTime()) / DAY));
    }

    // A gap of zero is two orders on one day — a split shipment, a corrected
    // order — not a rhythm of nought days.
    const real = gaps.filter((gap) => gap > 0);
    if (real.length === 0) continue;

    const everyDays = median(real);
    if (everyDays > MAX_CADENCE_DAYS) continue;

    const daysSince = Math.floor(
      (now.getTime() - dates[dates.length - 1]!.getTime()) / DAY,
    );

    found.set(customerId, {
      everyDays,
      daysSince,
      orders: dates.length,
      due: daysSince >= everyDays,
    });
  }

  return found;
}
