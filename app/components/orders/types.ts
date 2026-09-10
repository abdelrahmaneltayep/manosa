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

/* -------------------------------------------------------------------------- */
/* Quotes                                                                      */
/* -------------------------------------------------------------------------- */

export type QuoteStatusKey =
  "NEW" | "DRAFTED" | "SENT" | "ACCEPTED" | "DECLINED" | "EXPIRED";

export interface QuoteRowView {
  id: string;
  number: string;
  buyer: string;
  buyerHref: string | null;
  status: QuoteStatusKey;
  /** Already-translated chip text and tone. */
  statusLabel: string;
  statusTone: PaymentChipTone;
  /** Formatted money. Empty string before it has been priced. */
  total: string;
  lineCount: number;
  /** Already-translated, e.g. "Expires in 3 days" or "Expired 2 days ago". */
  expiryLabel: string | null;
  /** ✦ Where it came from — the Buyer Agent chip. */
  source: "MERCHANT" | "STOREFRONT" | "BUYER_AGENT";
  createdAt: string;
}

export interface QuoteListView {
  rows: QuoteRowView[];
  total: number;
  totalUnfiltered: number;
  page: number;
  pageCount: number;
  filters: { search: string; status: string };
  entitled: boolean;
  requiredPlan: string;
}

export interface QuoteLineView {
  id: string;
  variantId: string;
  title: string;
  sku: string | null;
  quantity: number;
  /** Formatted, locked. */
  unitPrice: string;
  /** Decimal, for the editable field. */
  unitPriceRaw: string;
  listPrice: string;
  lineTotal: string;
  /** Which rules made this price, already composed. Null when none applied. */
  ruleSummary: string | null;
  /**
   * What the store would charge today. Set only once a quote is locked and the
   * two differ — the locked-price chip the checklist asks for.
   */
  currentPrice: string | null;
}

export interface QuoteDetailView {
  id: string;
  number: string;
  status: QuoteStatusKey;
  statusLabel: string;
  statusTone: PaymentChipTone;
  source: "MERCHANT" | "STOREFRONT" | "BUYER_AGENT";
  buyer: {
    name: string;
    email: string | null;
    href: string | null;
    /** Already-translated tier and history, the "buyer context" card. */
    context: string | null;
  };
  /** The buyer's own words, when the request came from outside. */
  requestNote: string | null;
  message: string;
  internalNote: string;
  lines: QuoteLineView[];
  subtotal: string;
  currencyCode: string;
  /** Already-translated. Null before it is sent. */
  expiryLabel: string | null;
  lockedLabel: string | null;
  /** The buyer's link, shown once it has been sent. */
  publicUrl: string | null;
  draftOrder: { name: string; href: string } | null;
  /** Which buttons this state allows — from the shared state machine. */
  actions: {
    draft: boolean;
    send: boolean;
    withdraw: boolean;
    reopen: boolean;
  };
  /** True when any line's locked price now differs from the live one. */
  hasDrift: boolean;
  /** ✦ The margin-floor check needs the AI layer (4.x). */
  aiAvailable: boolean;
  entitled: boolean;
  requiredPlan: string;
  /** A refused action, said next to what caused it. */
  error: string | null;
  /** The catalogue search box: what was typed, and what came back. */
  search: {
    query: string;
    results: { variantId: string; title: string; sku: string | null; price: string }[];
    /** True once a search ran and matched nothing. */
    searched: boolean;
  };
}

/* -------------------------------------------------------------------------- */
/* ✦ PO-to-order                                                               */
/* -------------------------------------------------------------------------- */

export interface PoLineView {
  index: number;
  /** What the document asked for, in the buyer's own words. */
  requested: string;
  quantity: number;
  confidence: "exact" | "likely" | "ambiguous" | "none";
  /** The matched product, when there is one. */
  matched: string | null;
  sku: string | null;
  /** The contract price, from the engine. Formatted, or null. */
  unitPrice: string | null;
  lineTotal: string | null;
  /** What the document claimed, and by how much it differs. */
  statedPrice: string | null;
  priceDelta: string | null;
  /** Which rule set this price. */
  ruleSummary: string | null;
  /** For an ambiguous line: what the merchant picks between. */
  candidates: { id: string; label: string; sku: string | null }[];
}

export interface PurchaseOrderView {
  /** False with no key, or on a plan without PO-to-order. */
  available: boolean;
  /** The reason the composer is off, when it is. */
  locked: "no_key" | "plan" | null;
  /** What the merchant pasted, echoed back. */
  text: string;
  /** Set when a file could not be read as text — the checklist's fallback. */
  fileError: "unreadable" | "too_large" | null;
  failure:
    | "no_key"
    | "timeout"
    | "rate_limited"
    | "refused"
    | "invalid_output"
    | "error"
    | "empty"
    | null;
  /** The buyer this is being priced for. Null until one is chosen. */
  buyer: { id: string; label: string } | null;
  buyers: { id: string; label: string }[];
  lines: PoLineView[];
  /** Recomputed from Mannon rules, never from the document. */
  subtotal: string | null;
  /** The buyer's own PO number, for the draft order's note. */
  reference: string | null;
  notes: string | null;
  /** Lines that are not an exact match. Approving needs them dealt with. */
  needsAttention: number;
  /** Carried back on every round trip. */
  payload: string;
  /** Set once a draft order exists. */
  created: { name: string; invoiceUrl: string | null } | null;
}
