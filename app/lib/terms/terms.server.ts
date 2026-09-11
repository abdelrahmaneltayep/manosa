import {
  balanceOf,
  byUrgency,
  checkEligibility,
  publishedFrom,
  sourceFrom,
  summariseAging,
  termsWithLimit,
  type AgingSummary,
  type Eligibility,
  type Invoice,
  type SerializedBuyerTerms,
  type Terms,
} from "@mannon/net-terms";
import { money, zero, type Money } from "@mannon/pricing-engine";
import type { Customer, CustomerGroup, Order } from "@prisma/client";

import { db } from "~/db.server";
import { amountOwed } from "~/lib/orders/totals";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Net payment terms, from the database side.
 *
 * Nothing here decides anything: `@mannon/net-terms` decides, and the payment
 * customization Function asks the same module. This file's job is to find the
 * rows, turn them into what that module takes, and put the answer somewhere
 * checkout can read it.
 */

/** The terms options the checklist names, plus whatever the merchant types. */
export const TERM_PRESETS = [15, 30, 60, 90] as const;

export type BuyerWithGroup = Customer & { group?: CustomerGroup | null };

/** The store's own currency, which every limit and balance is written in. */
export async function shopCurrency(): Promise<string> {
  const shop = shopScope.require("terms");
  const record = await db.shop.findUnique({ where: { shop } });
  return record?.currencyCode ?? "USD";
}

/**
 * Whose terms apply to this buyer.
 *
 * The customer-over-group rule lives in the pure module; this only supplies the
 * two levels.
 */
export function termsFor(buyer: BuyerWithGroup, currencyCode: string): Terms | null {
  return termsWithLimit(
    sourceFrom(buyer.netTermsDays, buyer.creditLimit),
    buyer.group ? sourceFrom(buyer.group.netTermsDays, buyer.group.creditLimit) : null,
    currencyCode,
  );
}

/** True when this buyer's own terms replace their group's — the chip. */
export function termsAreOverridden(buyer: BuyerWithGroup): boolean {
  return buyer.netTermsDays !== null && (buyer.group?.netTermsDays ?? null) !== null;
}

/**
 * An order as the ledger sees it.
 *
 * `totalPrice` alone. It is written from Shopify's `current_total_price`,
 * which already has the refund taken off it, so subtracting `refundedAmount`
 * here charged the refund twice and showed the merchant **less** owed than
 * they were owed — on the one screen whose whole job is chasing money.
 */
export function toInvoice(order: Order): Invoice {
  return {
    id: order.id,
    name: order.name,
    amount: money(order.totalPrice, order.currencyCode),
    paid: money(order.amountPaid, order.currencyCode),
    dueAt: order.netTermsDueAt,
    paidAt: order.paidAt,
  };
}

/**
 * Every order a buyer still owes on.
 *
 * Cancelled orders are excluded: a merchant is not chasing money for goods that
 * were never sent, and leaving them in would overstate what is owed on the one
 * screen where that number matters.
 */
export async function outstandingFor(customerId: string): Promise<Order[]> {
  return db.order.findMany({
    where: {
      customerId,
      isWholesale: true,
      cancelledAt: null,
      paidAt: null,
      netTermsDueAt: { not: null },
    },
    orderBy: { netTermsDueAt: "asc" },
  });
}

export interface BuyerLedger {
  terms: Terms | null;
  overridden: boolean;
  summary: AgingSummary;
  invoices: Invoice[];
  eligibility: Eligibility;
}

/**
 * What one buyer owes, and whether they may take on more.
 *
 * Assembled in one place because the admin, the published metafield and — from
 * phase 5 — the Buyer Agent must all quote the same figures. The checklist is
 * explicit about it: "agent and checkout both say so with the same number".
 */
export async function ledgerFor(
  buyer: BuyerWithGroup,
  { now = new Date(), currencyCode }: { now?: Date; currencyCode: string },
): Promise<BuyerLedger> {
  const terms = termsFor(buyer, currencyCode);
  const orders = await outstandingFor(buyer.customerId);
  const invoices = orders
    .map(toInvoice)
    .filter((invoice) => balanceOf(invoice).amount > 0);
  const summary = summariseAging(invoices, now, currencyCode);

  return {
    terms,
    overridden: termsAreOverridden(buyer),
    summary,
    invoices: [...invoices].sort(byUrgency),
    eligibility: checkEligibility({
      isAuthenticated: true,
      terms,
      outstanding: summary.outstanding,
      overdueCount: summary.overdueCount,
      // No cart in the admin. A limit is reported as headroom rather than as a
      // verdict on a purchase nobody is making.
      cartTotal: zero(currencyCode),
    }),
  };
}

/** The buyer facts the payment Function reads. Null when they have no terms. */
export function publishableTerms(
  terms: Terms | null,
  summary: AgingSummary,
  overdueBlocks: boolean,
): SerializedBuyerTerms | null {
  if (!terms) return null;
  return publishedFrom(
    terms,
    summary.outstanding,
    overdueBlocks ? summary.overdueCount : 0,
  );
}

/** What is still owed on one order. */
export function balanceOfOrder(order: Order): Money {
  const remaining = amountOwed(order);
  return remaining > 0 ? money(remaining, order.currencyCode) : zero(order.currencyCode);
}
