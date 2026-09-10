import type { LimitIssue } from "@mannon/order-limits";

/**
 * Everything the order screens render, as plain serialisable data.
 *
 * Same shape as the customer screens: the pages are pure functions of these, so
 * every state in checklist §5 — no orders yet, overdue, refunded, edited in
 * Shopify, plan-gated — is rendered and asserted in a test rather than left to
 * an admin nobody in this environment can open.
 */

export type PlacedVia =
  "STOREFRONT" | "QUICK_ORDER" | "BUYER_AGENT" | "DRAFT" | "POS" | "OTHER";

export type PaymentChipTone = "success" | "critical" | "warning" | "neutral" | "info";

export interface OrderRowView {
  id: string;
  /** "#1001". */
  name: string;
  /** Shopify's admin URL for the order, so the merchant can go and edit it. */
  adminUrl: string;
  /** Company, else the buyer's email, else a placeholder. */
  buyer: string;
  /** Set when we have the buyer mirrored and can link to their page. */
  buyerHref: string | null;
  placedVia: PlacedVia;
  /** Already-translated chip text for the payment state. */
  payment: { label: string; tone: PaymentChipTone };
  /** Already-translated, e.g. "Refunded $40.00". Null when nothing was refunded. */
  refund: string | null;
  /** Formatted money, e.g. "$1,200.50". */
  total: string;
  quantity: number;
  /** ISO date. */
  processedAt: string;
  /** Already-translated relative or absolute date for the row. */
  processedLabel: string;
  /** Shopify's copy has moved past ours — the row shows a resync badge. */
  needsResync: boolean;
  cancelled: boolean;
}

export interface OrderListView {
  rows: OrderRowView[];
  total: number;
  totalUnfiltered: number;
  page: number;
  pageSize: number;
  pageCount: number;
  filters: { search: string; source: string; payment: string };
  /** True while the one-off order backfill is still running. */
  syncing: boolean;
  /** Orders Shopify has edited since we mirrored them. */
  resyncCount: number;
  /** The 60-day reach of `read_orders`, stated rather than implied. */
  historyDays: number;
}

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

export interface LimitRowView {
  id: string;
  /** The group's name, or null for the store-wide limit. */
  groupName: string | null;
  groupId: string | null;
  enabled: boolean;
  /** Already-formatted money, or null when the bound is not set. */
  minSubtotal: string | null;
  maxSubtotal: string | null;
  minQuantity: number | null;
  maxQuantity: number | null;
  quantityIncrement: number | null;
  countries: string[];
  /** Already-translated one-line summary of what this limit does. */
  summary: string;
}

export interface LimitFormView {
  /** Null when creating. */
  id: string | null;
  groupId: string;
  enabled: boolean;
  /** Decimal strings as typed, so a rejected form gives back what was entered. */
  minSubtotal: string;
  maxSubtotal: string;
  minQuantity: string;
  maxQuantity: string;
  quantityIncrement: string;
  countries: string;
}

export interface LimitsView {
  rows: LimitRowView[];
  groups: { id: string; name: string }[];
  form: LimitFormView | null;
  /** Validation issues from `@mannon/order-limits`, not from a second copy of
   *  the rules living in the page. */
  issues: LimitIssue[];
  currencyCode: string;
  /** The example the empty state uses, with the store's own currency. */
  exampleMinimum: string;
  posBypassesLimits: boolean;
  /** False when the plan does not include limits — the editor is read-only. */
  entitled: boolean;
  /** The plan that would unlock it, for the upgrade link. */
  requiredPlan: string;
  /** Set when a save reached Shopify, so the page can say the limit is live. */
  publishedAt: string | null;
  /** A preview message, rendered by the same module the checkout uses. */
  preview: { heading: string; message: string } | null;
}

/* -------------------------------------------------------------------------- */
/* Net terms                                                                   */
/* -------------------------------------------------------------------------- */

export type AgingBucketKey = "current" | "days_1_15" | "days_16_30" | "days_30_plus";

export interface BucketView {
  bucket: AgingBucketKey;
  /** Already-formatted money. */
  outstanding: string;
  invoiceCount: number;
}

export interface LedgerRowView {
  /** Our own order row id — what the payment form posts. */
  id: string;
  name: string;
  adminUrl: string;
  buyer: string;
  buyerHref: string | null;
  /** Already-translated, e.g. "Net 30". Null when the order carries no terms. */
  terms: string | null;
  /** Already-translated: "Due in 12 days" or "9 days overdue". */
  dueLabel: string;
  overdue: boolean;
  /** Formatted money still owed. */
  balance: string;
  /** The same number as a bare decimal, for the payment field's placeholder. */
  balanceRaw: string;
  /** Already-translated part-payment note, or null when nothing is paid. */
  paid: string | null;
  currencyCode: string;
  /** Already-translated "Reminded 3 days ago", or null. */
  remindedLabel: string | null;
  /** False while a reminder is too recent to send another. */
  canRemind: boolean;
  /** A failed payment entry, shown beside the field that caused it. */
  error: string | null;
}

export interface LedgerView {
  rows: LedgerRowView[];
  buckets: BucketView[];
  /** Formatted total still owed across every bucket. */
  outstanding: string;
  page: number;
  pageCount: number;
  /** Tells "nobody is on terms" from "everybody has paid". */
  anyBuyerHasTerms: boolean;
  entitled: boolean;
  requiredPlan: string;
  /** Null until the settings have reached Shopify. */
  publishedAt: string | null;
  settings: {
    methodName: string;
    showDaysInName: boolean;
    overdueBlocks: boolean;
    /** What the button will say, built the way the Function builds it. */
    preview: string;
  };
  settingsError: boolean;
}
