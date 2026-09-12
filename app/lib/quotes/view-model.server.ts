import { money, formatMoney, type PricingRule } from "@mannon/pricing-engine";
import type { Customer, Quote, QuoteLine } from "@prisma/client";

import type {
  PaymentChipTone,
  QuoteDetailView,
  QuoteLineView,
  QuoteRowView,
  QuoteStatusKey,
} from "~/components/orders/types";
import type { Translate } from "~/i18n/translate";
import { formatCurrency } from "~/lib/money";
import { orderAdminUrl } from "~/lib/orders/view-model.server";
import { priceDriftFor, type BuyerForPricing } from "~/lib/quotes/pricing.server";
import { allowedActions, daysUntil, type QuoteState } from "~/lib/quotes/state";

/**
 * Turning quotes into what the screens render.
 *
 * All the translating happens here: a view that carries a function does not
 * survive the loader-to-component JSON boundary, which 2.2 found out the hard
 * way.
 */

const TONES: Readonly<Record<QuoteStatusKey, PaymentChipTone>> = {
  NEW: "warning",
  DRAFTED: "neutral",
  SENT: "info",
  ACCEPTED: "success",
  DECLINED: "neutral",
  EXPIRED: "critical",
};

/** "Expires in 3 days", "Expired 2 days ago", or nothing at all. */
export function expiryLabel(
  quote: Pick<Quote, "status" | "expiresAt">,
  now: Date,
  t: Translate,
): string | null {
  if (!quote.expiresAt) return null;
  const days = daysUntil(quote.expiresAt, now);

  if (quote.status === "EXPIRED" || days < 0) {
    return t("quotes.expiredAgo", { count: Math.abs(days) });
  }
  if (quote.status !== "SENT") return null;
  return t("quotes.expiresIn", { count: days });
}

export function toQuoteRowView(
  quote: Quote & { lines: QuoteLine[]; buyerRowId?: string | null },
  options: { now: Date; t: Translate; locale?: string },
): QuoteRowView {
  const { t, now, locale } = options;
  const status = quote.status as QuoteStatusKey;

  return {
    id: quote.id,
    number: quote.number,
    buyer: quote.company || quote.email || t("orders.list.unknownBuyer"),
    buyerHref: quote.buyerRowId ? `/app/customers/${quote.buyerRowId}` : null,
    status,
    statusLabel: t(`quotes.status.${status}`),
    statusTone: TONES[status],
    // Empty, not "$0.00": a request nobody has priced has no total, and zero
    // would read as free.
    total:
      quote.lines.length === 0
        ? ""
        : formatCurrency(money(quote.subtotal, quote.currencyCode), locale),
    lineCount: quote.lines.length,
    expiryLabel: expiryLabel(quote, now, t),
    source: quote.source as QuoteRowView["source"],
    createdAt: quote.createdAt.toISOString(),
  };
}

/** Tier and history, so a merchant pricing a quote knows who they are talking to. */
export function buyerContext(
  buyer: (Customer & { group?: { name: string } | null }) | null,
  t: Translate,
  locale?: string,
): string | null {
  if (!buyer) return null;

  const parts: string[] = [];
  if (buyer.group) parts.push(buyer.group.name);
  parts.push(
    t("quotes.detail.contextOrders", {
      count: buyer.orderCount,
      spend: formatCurrency(money(buyer.lifetimeSpend, buyer.currencyCode), locale),
    }),
  );
  return parts.join(" · ");
}

export interface DetailOptions {
  now: Date;
  t: Translate;
  locale?: string;
  shop: string;
  buyer: (Customer & { group?: { name: string } | null }) | null;
  buyerRowId: string | null;
  publicUrl: string | null;
  /** Live rules, for the locked-price comparison. Empty skips the check. */
  rules: PricingRule[];
  entitled: boolean;
  requiredPlan: string;
  error: string | null;
  search: {
    query: string;
    results: {
      variantId: string;
      /**
       * Carried through the form so the added line is priced with the whole
       * context. Both of these used to be dropped between the search and the
       * quote — `productId: null` and no collections — so adding a line by
       * hand lost every product- and collection-scoped rule that the search
       * result itself had matched.
       */
      productId: string;
      collectionIds: string[];
      title: string;
      sku: string | null;
      price: string;
    }[];
    searched: boolean;
  };
}

export function toQuoteDetailView(
  quote: Quote & { lines: QuoteLine[] },
  options: DetailOptions,
): QuoteDetailView {
  const { t, now, locale, rules } = options;
  const status = quote.status as QuoteStatusKey;
  const allowed = allowedActions(status as QuoteState);

  const buyerFacts: BuyerForPricing = {
    customerId: quote.customerId,
    tags: options.buyer?.tags ?? [],
    groupIds: options.buyer?.groupId ? [options.buyer.groupId] : [],
  };

  const lines: QuoteLineView[] = quote.lines.map((line) => {
    // Never to change the price — only to say that the store would now charge
    // something else, which is what a merchant honouring an old quote wants.
    const drift =
      rules.length > 0
        ? priceDriftFor(
            {
              variantId: line.variantId,
              productId: line.productId,
              quantity: line.quantity,
              unitPrice: money(line.unitPrice, quote.currencyCode),
              listPrice: money(line.listPrice, quote.currencyCode),
              collectionIds: line.collectionIds,
            },
            buyerFacts,
            rules,
            { now, currencyCode: quote.currencyCode },
          )
        : { current: money(line.unitPrice, quote.currencyCode), drifted: false };

    return {
      id: line.id,
      variantId: line.variantId,
      title: line.title,
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: formatCurrency(money(line.unitPrice, quote.currencyCode), locale),
      unitPriceRaw: formatMoney(money(line.unitPrice, quote.currencyCode)),
      listPrice: formatCurrency(money(line.listPrice, quote.currencyCode), locale),
      lineTotal: formatCurrency(
        money(line.unitPrice * line.quantity, quote.currencyCode),
        locale,
      ),
      ruleSummary: line.ruleSummary,
      currentPrice: drift.drifted ? formatCurrency(drift.current, locale) : null,
    };
  });

  return {
    id: quote.id,
    number: quote.number,
    status,
    statusLabel: t(`quotes.status.${status}`),
    statusTone: TONES[status],
    source: quote.source as QuoteDetailView["source"],
    buyer: {
      name: quote.company || quote.email || t("orders.list.unknownBuyer"),
      email: quote.email,
      href: options.buyerRowId ? `/app/customers/${options.buyerRowId}` : null,
      context: buyerContext(options.buyer, t, locale),
    },
    requestNote: quote.requestNote,
    message: quote.message ?? "",
    internalNote: quote.internalNote ?? "",
    lines,
    subtotal: formatCurrency(money(quote.subtotal, quote.currencyCode), locale),
    currencyCode: quote.currencyCode,
    expiryLabel: expiryLabel(quote, now, t),
    lockedLabel: quote.lockedAt
      ? t("quotes.detail.lockedAt", { at: quote.lockedAt.toISOString().slice(0, 10) })
      : null,
    publicUrl: quote.sentAt ? options.publicUrl : null,
    draftOrder:
      quote.draftOrderId && quote.draftOrderName
        ? {
            name: quote.draftOrderName,
            href: orderAdminUrl(options.shop, quote.draftOrderId).replace(
              "/orders/",
              "/draft_orders/",
            ),
          }
        : null,
    actions: {
      draft: allowed.includes("draft"),
      send: allowed.includes("send"),
      withdraw: allowed.includes("withdraw"),
      reopen: allowed.includes("reopen"),
    },
    hasDrift: lines.some((line) => line.currentPrice !== null),
    // ✦ The margin-floor check needs the AI layer (4.x).
    aiAvailable: false,
    entitled: options.entitled,
    requiredPlan: options.requiredPlan,
    error: options.error,
    search: options.search,
  };
}
