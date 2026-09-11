import type { AgingSummary } from "@mannon/net-terms";
import { amountOwed } from "~/lib/orders/totals";
import { formatMoney, money } from "@mannon/pricing-engine";
import type { Order, OrderLimit } from "@prisma/client";

import type {
  BucketView,
  LedgerRowView,
  LimitRowView,
  OrderRowView,
  PaymentChipTone,
  PlacedVia,
} from "~/components/orders/types";
import type { Translate } from "~/i18n/translate";
import { formatCurrency } from "~/lib/money";
import {
  daysUntilDue,
  paymentState,
  type PaymentState,
} from "~/lib/orders/orders.server";

/**
 * Turning stored orders and limits into what the screens render.
 *
 * All the translating happens here rather than in the components, for the
 * reason 2.2 found out the hard way: a view that carries a function does not
 * survive the loader-to-component JSON boundary, and the page crashes the first
 * time it needs one.
 */

/** Relative for a week, absolute after — the checklist's rule for the log. */
const RELATIVE_DAYS = 7;
const DAY_MS = 86_400_000;

const TONES: Readonly<Record<PaymentState, PaymentChipTone>> = {
  paid: "success",
  overdue: "critical",
  due: "warning",
  pending: "neutral",
  refunded: "info",
  partially_refunded: "info",
  cancelled: "neutral",
};

export function orderAdminUrl(shop: string, orderId: string): string {
  const numeric = orderId.split("/").pop() ?? "";
  return `https://${shop}/admin/orders/${numeric}`;
}

function paymentLabel(order: Order, state: PaymentState, t: Translate): string {
  if (state === "due" || state === "overdue") {
    const days = daysUntilDue(order, new Date()) ?? 0;
    // The number the merchant asks their buyer about is the due date, so the
    // chip carries it rather than only the word "overdue".
    return order.netTermsDays
      ? t(`orders.payment.${state}Terms`, {
          days: order.netTermsDays,
          count: Math.abs(days),
        })
      : t(`orders.payment.${state}`, { count: Math.abs(days) });
  }
  return t(`orders.payment.${state}`);
}

export function toOrderRowView(
  order: Order & { buyerRowId?: string | null },
  options: { shop: string; now: Date; t: Translate; locale?: string },
): OrderRowView {
  const { t, now, locale } = options;
  const state = paymentState(order, now);
  const days = Math.floor((now.getTime() - order.processedAt.getTime()) / DAY_MS);

  return {
    id: order.id,
    name: order.name,
    adminUrl: orderAdminUrl(options.shop, order.orderId),
    buyer: order.company || order.email || t("orders.list.unknownBuyer"),
    buyerHref: order.buyerRowId ? `/app/customers/${order.buyerRowId}` : null,
    placedVia: order.source as PlacedVia,
    payment: { label: paymentLabel(order, state, t), tone: TONES[state] },
    refund:
      order.refundedAmount > 0
        ? t("orders.list.refunded", {
            amount: formatCurrency(
              money(order.refundedAmount, order.currencyCode),
              locale,
            ),
          })
        : null,
    total: formatCurrency(money(order.totalPrice, order.currencyCode), locale),
    quantity: order.totalQuantity,
    processedAt: order.processedAt.toISOString(),
    processedLabel:
      days <= RELATIVE_DAYS
        ? t("orders.list.daysAgo", { count: Math.max(0, days) })
        : order.processedAt.toISOString().slice(0, 10),
    needsResync: order.needsResync,
    cancelled: order.cancelledAt !== null,
  };
}

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One line saying what a limit actually does.
 *
 * Written out rather than shown as four columns of numbers because a merchant
 * reading their own limits back is checking that they mean what they intended,
 * and "$200–$5,000, 24+, in packs of 12" answers that faster than a table does.
 */
export function limitSummary(
  row: OrderLimit,
  options: { t: Translate; currencyCode: string; locale?: string },
): string {
  const { t, currencyCode, locale } = options;
  const asMoney = (value: number) => formatCurrency(money(value, currencyCode), locale);
  const parts: string[] = [];

  if (row.minSubtotal !== null && row.maxSubtotal !== null) {
    parts.push(
      t("limits.summary.between", {
        min: asMoney(row.minSubtotal),
        max: asMoney(row.maxSubtotal),
      }),
    );
  } else if (row.minSubtotal !== null) {
    parts.push(t("limits.summary.min", { amount: asMoney(row.minSubtotal) }));
  } else if (row.maxSubtotal !== null) {
    parts.push(t("limits.summary.max", { amount: asMoney(row.maxSubtotal) }));
  }

  if (row.minQuantity !== null) {
    parts.push(t("limits.summary.minQuantity", { count: row.minQuantity }));
  }
  if (row.maxQuantity !== null) {
    parts.push(t("limits.summary.maxQuantity", { count: row.maxQuantity }));
  }
  if (row.quantityIncrement !== null) {
    parts.push(t("limits.summary.increment", { count: row.quantityIncrement }));
  }
  if (row.countries.length > 0) {
    parts.push(t("limits.summary.countries", { countries: row.countries.join(", ") }));
  }

  // A limit with no bounds at all constrains nothing, and saying so is more use
  // than an empty cell the merchant has to interpret.
  return parts.length > 0 ? parts.join(" · ") : t("limits.summary.none");
}

export function toLimitRowView(
  row: OrderLimit,
  options: {
    t: Translate;
    currencyCode: string;
    locale?: string;
    /** The group's name, when this limit is scoped to one. */
    groupName?: string | null;
  },
): LimitRowView {
  const { currencyCode, locale } = options;
  const asMoney = (value: number | null) =>
    value === null ? null : formatCurrency(money(value, currencyCode), locale);

  return {
    id: row.id,
    groupName: options.groupName ?? null,
    groupId: row.groupId,
    enabled: row.enabled,
    minSubtotal: asMoney(row.minSubtotal),
    maxSubtotal: asMoney(row.maxSubtotal),
    minQuantity: row.minQuantity,
    maxQuantity: row.maxQuantity,
    quantityIncrement: row.quantityIncrement,
    countries: row.countries,
    summary: limitSummary(row, options),
  };
}

/* -------------------------------------------------------------------------- */
/* The terms ledger                                                            */
/* -------------------------------------------------------------------------- */

/** Whole days between two dates, in UTC — the same arithmetic the ledger uses. */
function wholeDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.floor((b - a) / DAY_MS);
}

export function toLedgerRowView(
  order: Order & { buyerRowId?: string | null; error?: string | null },
  options: { shop: string; now: Date; t: Translate; locale?: string; canRemind: boolean },
): LedgerRowView {
  const { t, now, locale } = options;
  const balance = money(amountOwed(order), order.currencyCode);
  const late = order.netTermsDueAt ? wholeDaysBetween(order.netTermsDueAt, now) : 0;

  return {
    id: order.id,
    name: order.name,
    adminUrl: orderAdminUrl(options.shop, order.orderId),
    buyer: order.company || order.email || t("orders.list.unknownBuyer"),
    buyerHref: order.buyerRowId ? `/app/customers/${order.buyerRowId}` : null,
    terms: order.netTermsDays ? t("terms.net", { count: order.netTermsDays }) : null,
    dueLabel: !order.netTermsDueAt
      ? t("terms.ledger.noDueDate")
      : late > 0
        ? t("terms.ledger.overdueBy", { count: late })
        : t("terms.ledger.dueIn", { count: Math.abs(late) }),
    overdue: late > 0,
    balance: formatCurrency(balance, locale),
    balanceRaw: formatMoney(balance),
    paid:
      order.amountPaid > 0
        ? t("terms.ledger.partPaid", {
            amount: formatCurrency(money(order.amountPaid, order.currencyCode), locale),
          })
        : null,
    currencyCode: order.currencyCode,
    remindedLabel: order.remindedAt
      ? t("terms.ledger.remindedAgo", {
          count: wholeDaysBetween(order.remindedAt, now),
        })
      : null,
    canRemind: options.canRemind,
    error: order.error ?? null,
  };
}

export function toBucketViews(
  summary: AgingSummary,
  options: { locale?: string },
): BucketView[] {
  return summary.buckets.map((bucket) => ({
    bucket: bucket.bucket as BucketView["bucket"],
    outstanding: formatCurrency(bucket.outstanding, options.locale),
    invoiceCount: bucket.invoiceCount,
  }));
}
