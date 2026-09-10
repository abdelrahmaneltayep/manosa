import { summariseAging, type AgingSummary } from "@mannon/net-terms";
import type { Order } from "@prisma/client";

import { db } from "~/db.server";
import { toInvoice } from "~/lib/terms/terms.server";

/**
 * The store-wide ledger.
 *
 * Per-buyer figures come from `ledgerFor`; this is the same question asked
 * across every buyer, for the Orders → Terms page. Both go through
 * `summariseAging`, so a merchant adding up the rows gets the headline number.
 */

export const LEDGER_PAGE_SIZE = 25;

/** Orders on terms that still owe something, most overdue first. */
const OUTSTANDING = {
  isWholesale: true,
  cancelledAt: null,
  paidAt: null,
  netTermsDueAt: { not: null },
} as const;

export interface LedgerPage {
  rows: Order[];
  summary: AgingSummary;
  page: number;
  pageCount: number;
  /** Whether anyone is on terms at all — tells "nobody" from "all paid". */
  anyBuyerHasTerms: boolean;
}

export async function ledgerPage({
  page = 1,
  pageSize = LEDGER_PAGE_SIZE,
  now = new Date(),
  currencyCode,
}: {
  page?: number;
  pageSize?: number;
  now?: Date;
  currencyCode: string;
}): Promise<LedgerPage> {
  // The summary is over every outstanding invoice, not just this page: a
  // merchant reading "£40,000 outstanding" and then paging through would
  // otherwise find the total changing under them.
  const all = await db.order.findMany({
    where: OUTSTANDING,
    orderBy: [{ netTermsDueAt: "asc" }, { name: "asc" }],
  });

  const owing = all.filter(
    (order) => order.totalPrice - order.refundedAmount - order.amountPaid > 0,
  );
  const summary = summariseAging(owing.map(toInvoice), now, currencyCode);

  const anyBuyerHasTerms =
    owing.length > 0 ||
    (await db.customer.count({
      where: {
        OR: [{ netTermsDays: { not: null } }, { group: { netTermsDays: { not: null } } }],
      },
    })) > 0;

  const pageCount = Math.max(1, Math.ceil(owing.length / pageSize));
  const start = Math.max(0, (page - 1) * pageSize);

  return {
    rows: owing.slice(start, start + pageSize),
    summary,
    page,
    pageCount,
    anyBuyerHasTerms,
  };
}
