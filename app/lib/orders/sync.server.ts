import { parseMoney, type Money } from "@mannon/pricing-engine";
import { OrderSource, type Prisma } from "@prisma/client";

import { db } from "~/db.server";
import { normalizeTags } from "~/lib/customers/tagging";
import type { OrderNode } from "~/lib/orders/admin-graphql.server";
import { tenant } from "~/lib/tenant/shop-context.server";

/**
 * Mirroring Shopify's orders into our own table.
 *
 * Two doors lead in, as with customers: a webhook payload (REST-shaped,
 * snake_case) and a GraphQL node from the backfill. Both are narrowed here so
 * nothing downstream has to know which one a row came through.
 *
 * The mirror exists so the wholesale list can sort by "overdue first" and total
 * a period without a hundred API calls. Shopify stays the source of truth: when
 * its `updatedAt` moves past ours the row is flagged for resync rather than
 * quietly shown as if it were current.
 */

/** The note attribute Mannon's own storefront surfaces write. */
export const SOURCE_ATTRIBUTE = "_mannon_source";

export interface OrderFacts {
  orderId: string;
  name: string;
  customerId: string | null;
  email: string | null;
  company: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  total: Money;
  subtotal: Money;
  refunded: Money;
  totalQuantity: number;
  source: OrderSource;
  sourceName: string | null;
  tags: string[];
  processedAt: Date;
  cancelledAt: Date | null;
  shopifyUpdatedAt: Date | null;
}

const trimmed = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
};

function readDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Money on the wire is a decimal string; a bad one must not lose the order. */
function readMoney(amount: unknown, currencyCode: string): Money {
  const text = typeof amount === "string" ? amount : String(amount ?? "0");
  try {
    return parseMoney(text.trim() || "0", currencyCode);
  } catch {
    return parseMoney("0", currencyCode);
  }
}

function readQuantity(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

/**
 * Where an order was placed.
 *
 * Two signals, in this order:
 *
 * 1. The `_mannon_source` note attribute, which Mannon's own storefront surfaces
 *    set. This is the only way to know a cart came from the quick-order block
 *    or the Buyer Agent — Shopify has no idea which app extension built a cart,
 *    and reports every one of them as the storefront.
 * 2. Shopify's `sourceName`, which distinguishes a draft order and POS.
 *
 * Anything else is `OTHER`, never a guess. `sourceName` is stored raw alongside,
 * because our reading of it is an interpretation and the original is not.
 */
export function classifySource(
  sourceName: string | null,
  attribute: string | null,
): OrderSource {
  switch (attribute?.trim().toLowerCase()) {
    case "quick_order":
      return OrderSource.QUICK_ORDER;
    case "buyer_agent":
      return OrderSource.BUYER_AGENT;
    default:
      break;
  }

  const name = sourceName?.trim().toLowerCase() ?? "";
  switch (name) {
    case "web":
      return OrderSource.STOREFRONT;
    // A draft order — including an accepted quote — is created through the
    // draft API, which Shopify reports under this name.
    case "shopify_draft_order":
      return OrderSource.DRAFT;
    case "pos":
      return OrderSource.POS;
    default:
      // An order created by another app reports that app's client id here.
      // That is not a storefront and not worth guessing at.
      return name ? OrderSource.OTHER : OrderSource.STOREFRONT;
  }
}

export function factsFromNode(node: OrderNode, fallbackCurrency = "USD"): OrderFacts {
  const currencyCode =
    node.currentTotalPriceSet?.shopMoney?.currencyCode ?? fallbackCurrency;
  const attribute =
    node.customAttributes?.find((entry) => entry.key === SOURCE_ATTRIBUTE)?.value ?? null;

  return {
    orderId: node.id,
    name: trimmed(node.name) ?? node.id,
    customerId: trimmed(node.customer?.id),
    email: trimmed(node.email),
    company: trimmed(node.customer?.defaultAddress?.company),
    financialStatus: trimmed(node.displayFinancialStatus)?.toLowerCase() ?? null,
    fulfillmentStatus: trimmed(node.displayFulfillmentStatus)?.toLowerCase() ?? null,
    total: readMoney(node.currentTotalPriceSet?.shopMoney?.amount, currencyCode),
    subtotal: readMoney(node.currentSubtotalPriceSet?.shopMoney?.amount, currencyCode),
    refunded: readMoney(node.totalRefundedSet?.shopMoney?.amount, currencyCode),
    totalQuantity: readQuantity(node.currentSubtotalLineItemsQuantity),
    source: classifySource(node.sourceName, attribute),
    sourceName: trimmed(node.sourceName),
    tags: normalizeTags(node.tags ?? []),
    // An order without a processed date is not a thing Shopify sends, but a
    // missing one must not become "now" and sort to the top of the list.
    processedAt: readDate(node.processedAt) ?? readDate(node.createdAt) ?? new Date(0),
    cancelledAt: readDate(node.cancelledAt),
    shopifyUpdatedAt: readDate(node.updatedAt),
  };
}

interface WebhookOrder {
  id?: number | string;
  admin_graphql_api_id?: string;
  name?: string | null;
  email?: string | null;
  currency?: string | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  source_name?: string | null;
  tags?: string | string[] | null;
  current_total_price?: string | null;
  total_price?: string | null;
  current_subtotal_price?: string | null;
  subtotal_price?: string | null;
  current_total_discounts?: string | null;
  total_refunded?: string | null;
  processed_at?: string | null;
  created_at?: string | null;
  cancelled_at?: string | null;
  updated_at?: string | null;
  customer?: {
    id?: number | string;
    default_address?: { company?: string | null } | null;
  } | null;
  note_attributes?: { name?: string | null; value?: string | null }[] | null;
  line_items?: { quantity?: number | null }[] | null;
  refunds?:
    { transactions?: { amount?: string | null; kind?: string | null }[] | null }[] | null;
}

/** The GID for a webhook payload, or null when it carries no id at all. */
export function orderIdFromPayload(payload: unknown): string | null {
  const order = payload as WebhookOrder;
  if (order.admin_graphql_api_id) return order.admin_graphql_api_id;
  if (order.id !== undefined && order.id !== null) {
    return `gid://shopify/Order/${order.id}`;
  }
  return null;
}

/**
 * What has actually been refunded.
 *
 * The order webhook has no `total_refunded` field; it carries the refunds
 * themselves. Summing their transactions is the only honest number, and a
 * refund total we cannot read stays zero rather than becoming a guess that
 * shows the merchant money back they never gave.
 */
function refundedFromWebhook(order: WebhookOrder, currencyCode: string): Money {
  if (typeof order.total_refunded === "string") {
    return readMoney(order.total_refunded, currencyCode);
  }

  let minorUnits = 0;
  for (const refund of order.refunds ?? []) {
    for (const transaction of refund.transactions ?? []) {
      if (transaction.kind !== "refund") continue;
      minorUnits += readMoney(transaction.amount, currencyCode).amount;
    }
  }
  return { amount: minorUnits, currencyCode };
}

export function factsFromWebhook(
  payload: unknown,
  fallbackCurrency = "USD",
): OrderFacts | null {
  const order = payload as WebhookOrder;
  const orderId = orderIdFromPayload(payload);
  if (!orderId) return null;

  const currencyCode = trimmed(order.currency) ?? fallbackCurrency;
  const tags =
    typeof order.tags === "string"
      ? order.tags.split(",")
      : Array.isArray(order.tags)
        ? order.tags
        : [];

  const attribute =
    order.note_attributes?.find((entry) => entry.name === SOURCE_ATTRIBUTE)?.value ??
    null;

  const customerId =
    order.customer?.id !== undefined && order.customer?.id !== null
      ? `gid://shopify/Customer/${order.customer.id}`
      : null;

  return {
    orderId,
    name: trimmed(order.name) ?? orderId,
    customerId,
    email: trimmed(order.email),
    company: trimmed(order.customer?.default_address?.company),
    financialStatus: trimmed(order.financial_status)?.toLowerCase() ?? null,
    fulfillmentStatus: trimmed(order.fulfillment_status)?.toLowerCase() ?? null,
    // "current_" is the total after edits and refunds — the number the merchant
    // is owed today, which is what a wholesale list is for.
    total: readMoney(order.current_total_price ?? order.total_price, currencyCode),
    subtotal: readMoney(
      order.current_subtotal_price ?? order.subtotal_price,
      currencyCode,
    ),
    refunded: refundedFromWebhook(order, currencyCode),
    totalQuantity: (order.line_items ?? []).reduce(
      (sum, line) => sum + readQuantity(line.quantity),
      0,
    ),
    source: classifySource(order.source_name ?? null, attribute),
    sourceName: trimmed(order.source_name),
    tags: normalizeTags(tags),
    processedAt:
      readDate(order.processed_at) ?? readDate(order.created_at) ?? new Date(0),
    cancelledAt: readDate(order.cancelled_at),
    shopifyUpdatedAt: readDate(order.updated_at),
  };
}

function rowData(
  facts: OrderFacts,
  isWholesale: boolean,
): Prisma.OrderUncheckedCreateInput {
  return {
    ...tenant(),
    orderId: facts.orderId,
    name: facts.name,
    customerId: facts.customerId,
    email: facts.email,
    company: facts.company,
    financialStatus: facts.financialStatus,
    fulfillmentStatus: facts.fulfillmentStatus,
    totalPrice: facts.total.amount,
    subtotalPrice: facts.subtotal.amount,
    refundedAmount: facts.refunded.amount,
    currencyCode: facts.total.currencyCode,
    totalQuantity: facts.totalQuantity,
    source: facts.source,
    sourceName: facts.sourceName,
    tags: facts.tags,
    isWholesale,
    processedAt: facts.processedAt,
    cancelledAt: facts.cancelledAt,
    shopifyUpdatedAt: facts.shopifyUpdatedAt,
    syncedAt: new Date(),
    needsResync: false,
  };
}

/**
 * Was this order placed by a wholesale buyer?
 *
 * Decided from the buyer as they were at the time, not from the order: an order
 * placed before someone was approved is not a wholesale order, and re-deciding
 * it later would rewrite history in the merchant's revenue figures.
 */
export async function isWholesaleOrder(
  facts: OrderFacts,
  wholesaleTag: string,
): Promise<boolean> {
  const tag = wholesaleTag.trim().toLowerCase();
  if (facts.tags.some((entry) => entry.toLowerCase() === tag)) return true;
  if (!facts.customerId) return false;

  const buyer = await db.customer.findFirst({
    where: { customerId: facts.customerId },
    select: { groupId: true, tags: true },
  });

  if (!buyer) return false;
  return (
    buyer.groupId !== null || buyer.tags.some((entry) => entry.toLowerCase() === tag)
  );
}

/**
 * Write one order into the mirror.
 *
 * Idempotent, because webhooks are delivered at least once and the backfill can
 * overlap them.
 */
export async function upsertOrder(
  facts: OrderFacts,
  isWholesale: boolean,
  overrides: Partial<Prisma.OrderUncheckedCreateInput> = {},
) {
  const data = { ...rowData(facts, isWholesale), ...overrides };
  const { shop: _shop, orderId: _orderId, ...updatable } = data;

  return db.order.upsert({
    where: { shop_orderId: { shop: data.shop, orderId: facts.orderId } },
    create: data,
    update: updatable,
  });
}

/**
 * Note that Shopify's copy of an order has moved past ours.
 *
 * Called when we know an order changed but not what it now says — an edit in
 * Shopify's admin, for instance. The row keeps the totals it has and the list
 * shows a resync badge, which is honest; overwriting them with nothing would
 * not be.
 */
export async function markNeedsResync(orderId: string, updatedAt: Date | null) {
  const { count } = await db.order.updateMany({
    where: { orderId },
    data: { needsResync: true, ...(updatedAt ? { shopifyUpdatedAt: updatedAt } : {}) },
  });
  return count;
}
