import { db } from "~/db.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * How a buyer has paid, historically.
 *
 * Checklist §5: *"✦ Risk signal: chip per buyer (on-time streak / 2 late
 * payments); suggested action only, never auto-changes terms."*
 *
 * `terms_risk` has carried a prompt version since 4.1 with no prompt, no
 * caller and nothing on any screen. It does not need one: "paid the last six
 * invoices on time" and "two of the last six were late" are counted off the
 * ledger, and a model asked to say the same thing would be the same number
 * with a licence fee, a timeout and a way to be wrong.
 *
 * **Suggested action only.** Nothing here changes a buyer's terms or their
 * credit limit; the merchant decides, and the chip is there so they decide
 * with the record in front of them rather than a feeling.
 */

/** How far back a payment record still says something about today. */
export const RISK_WINDOW = 12;

/** Late by less than this is a payment run, not a late payment. */
export const GRACE_DAYS = 2;

const DAY = 86_400_000;

export type RiskLevel = "good" | "watch" | "late";

export interface TermsRisk {
  level: RiskLevel;
  /** Settled invoices this was read from, newest first, at most `RISK_WINDOW`. */
  settled: number;
  /** How many of them were paid after their due date (beyond the grace). */
  late: number;
  /** Consecutive on-time payments, most recent first. Zero once one is late. */
  streak: number;
  /** Invoices overdue right now. A present-tense fact, not a history. */
  overdueNow: number;
}

/**
 * Risk for a page of buyers, in one query.
 *
 * Keyed by Shopify's customer GID, which is what `Order.customerId` holds.
 */
export async function riskFor(
  customerIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, TermsRisk>> {
  shopScope.require("riskFor");
  const found = new Map<string, TermsRisk>();
  if (customerIds.length === 0) return found;

  const orders = await db.order.findMany({
    where: {
      customerId: { in: [...customerIds] },
      isWholesale: true,
      cancelledAt: null,
      netTermsDueAt: { not: null },
    },
    select: {
      customerId: true,
      netTermsDueAt: true,
      paidAt: true,
      totalPrice: true,
      amountPaid: true,
    },
    orderBy: { netTermsDueAt: "desc" },
  });

  const byBuyer = new Map<string, typeof orders>();
  for (const order of orders) {
    if (!order.customerId) continue;
    const list = byBuyer.get(order.customerId);
    if (list) list.push(order);
    else byBuyer.set(order.customerId, [order]);
  }

  for (const [customerId, rows] of byBuyer) {
    // Still owing counts as unsettled however much has been paid against it:
    // a part-paid invoice is not a paid one.
    const settled = rows
      .filter((row) => row.paidAt !== null && row.totalPrice - row.amountPaid <= 0)
      .slice(0, RISK_WINDOW);

    const overdueNow = rows.filter(
      (row) =>
        row.paidAt === null &&
        row.totalPrice - row.amountPaid > 0 &&
        row.netTermsDueAt !== null &&
        row.netTermsDueAt.getTime() < now.getTime(),
    ).length;

    const wasLate = (row: (typeof rows)[number]) =>
      row.paidAt !== null &&
      row.netTermsDueAt !== null &&
      row.paidAt.getTime() - row.netTermsDueAt.getTime() > GRACE_DAYS * DAY;

    const late = settled.filter(wasLate).length;

    let streak = 0;
    for (const row of settled) {
      if (wasLate(row)) break;
      streak += 1;
    }

    // Nothing settled and nothing overdue is a buyer with no record, not a
    // good one. Saying "always pays on time" about a first invoice is the
    // kind of confident emptiness this repo keeps refusing to ship.
    if (settled.length === 0 && overdueNow === 0) continue;

    found.set(customerId, {
      level: overdueNow > 0 || late >= 2 ? "late" : late === 1 ? "watch" : "good",
      settled: settled.length,
      late,
      streak,
      overdueNow,
    });
  }

  return found;
}
