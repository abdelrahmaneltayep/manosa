import { money, type Money } from "@mannon/pricing-engine";
import { OrderSource, type Prisma } from "@prisma/client";

import { db } from "~/db.server";
import { parseShopifyMoney } from "~/lib/money";
import { normalizeTags } from "~/lib/customers/tagging";
import type { OrderLineNode, OrderNode } from "~/lib/orders/admin-graphql.server";
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

/**
 * What one discount took off one line.
 *
 * `title` is the name the buyer saw at checkout. Mannon's own Function sets the
 * winning rule's name as the discount message, which is the only reason rule
 * performance is measurable — and also why renaming a rule does not rewrite
 * what it earned last quarter.
 */
export interface LineDiscount {
  title: string;
  amount: Money;
}

export interface OrderLineFacts {
  lineItemId: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  productId: string | null;
  variantId: string | null;
  /** As ordered — Shopify's `quantity`, which is before returns. */
  quantity: number;
  /** After returns and order edits. What revenue is attributed on. */
  currentQuantity: number;
  unitPrice: Money;
  originalTotal: Money;
  discountedTotal: Money;
  /** `discountedTotal` apportioned to `currentQuantity`. See `currentTotal`. */
  currentTotal: Money;
  discounts: LineDiscount[];
}

/**
 * What is left of a line after returns and removals.
 *
 * Shopify exposes no post-refund line total, so this is the only honest thing
 * available: the discounted total apportioned by how much of the line the
 * merchant still has. Rounded down to whole minor units, so an apportioned
 * total can never exceed the real one.
 *
 * Without it, a five-unit line the merchant refunded in full was still five
 * units of revenue on every product and rule chart — the parent order row is
 * written from Shopify's `current_*` fields, so the lines and the order
 * disagreed.
 */
export function currentTotalOf(
  discountedTotal: Money,
  quantity: number,
  currentQuantity: number,
): Money {
  if (quantity <= 0 || currentQuantity <= 0) {
    return money(0, discountedTotal.currencyCode);
  }
  if (currentQuantity >= quantity) return discountedTotal;

  return money(
    Math.floor((discountedTotal.amount * currentQuantity) / quantity),
    discountedTotal.currencyCode,
  );
}

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
  /** The order's lines, as far as Shopify gave them to us. */
  lines: OrderLineFacts[];
  /**
   * True when these are not all of them.
   *
   * From Shopify's `pageInfo.hasNextPage` through the GraphQL door, and from
   * the payload sitting at the webhook's own line cap through the other. Never
   * inferred from quantities: the order's total quantity is post-refund and
   * the lines' is not, so comparing them was wrong in both doors and
   * structurally impossible in one.
   */
  linesTruncated: boolean;
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

/**
 * Money on the wire is a decimal string; a bad one must not lose the order.
 *
 * Through the shared Shopify boundary, which trims the insignificant trailing
 * zeros Shopify sends for zero-decimal currencies — `"5000.00"` for JPY, which
 * the strict parser rejects — and **logs** anything it still cannot read. The
 * version of this that swallowed the error mirrored a ¥5,000 line as ¥0, on
 * every chart, with nothing to explain it.
 */
const readMoney = (amount: unknown, currencyCode: string): Money =>
  parseShopifyMoney(amount, currencyCode, "order sync");

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

/**
 * The lines of one order, from a GraphQL node.
 *
 * Shopify gives the three money figures directly, so nothing here multiplies:
 * a line total this app computed from a unit price would disagree with the
 * order's own total the first time a line carried a fractional discount.
 */
export function linesFromNode(
  nodes: readonly OrderLineNode[],
  currencyCode: string,
): OrderLineFacts[] {
  return nodes.map((node) => {
    const quantity = readQuantity(node.quantity);
    const unitPrice = readMoney(
      node.originalUnitPriceSet?.shopMoney?.amount,
      currencyCode,
    );
    const originalTotal = readMoney(
      node.originalTotalSet?.shopMoney?.amount,
      currencyCode,
    );
    const discountedTotal = readMoney(
      node.discountedTotalSet?.shopMoney?.amount,
      currencyCode,
    );

    // `currentQuantity` is absent on older API versions; falling back to
    // `quantity` reads as "nothing was returned", which is the state of the
    // large majority of lines and the only safe assumption when unsaid.
    const currentQuantity =
      node.currentQuantity === undefined || node.currentQuantity === null
        ? quantity
        : readQuantity(node.currentQuantity);

    return {
      lineItemId: node.id,
      // A line always has a name on the merchant's screen, even when Shopify
      // has forgotten the product it came from.
      title: trimmed(node.title) ?? "Untitled item",
      variantTitle: trimmed(node.variantTitle),
      sku: trimmed(node.sku),
      productId: trimmed(node.product?.id),
      variantId: trimmed(node.variant?.id),
      quantity,
      currentQuantity,
      unitPrice,
      originalTotal,
      discountedTotal,
      currentTotal: currentTotalOf(discountedTotal, quantity, currentQuantity),
      discounts: (node.discountAllocations ?? []).map((allocation) => ({
        title:
          trimmed(allocation.discountApplication?.title) ??
          trimmed(allocation.discountApplication?.code) ??
          UNNAMED_DISCOUNT,
        amount: readMoney(allocation.allocatedAmountSet?.shopMoney?.amount, currencyCode),
      })),
    };
  });
}

/**
 * A discount Shopify named neither by title nor by code.
 *
 * Kept as its own constant so the analytics page can say "an unnamed discount"
 * rather than dropping the money out of the totals, which is the version of
 * this that makes a chart wrong.
 */
export const UNNAMED_DISCOUNT = "(unnamed discount)";

/**
 * How many line items a Shopify order webhook carries before it stops.
 *
 * A payload at exactly the cap may or may not be the whole order — Shopify
 * does not say — so it is treated as "we do not know", which is the honest
 * reading and the one that cannot clear a flag the backfill set correctly.
 */
export const WEBHOOK_LINE_CAP = 100;

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
    lines: linesFromNode(node.lineItems?.nodes ?? [], currencyCode),
    // Shopify's own answer to "is that all of them". The version of this that
    // compared summed quantities against the order's own could never be true
    // through the webhook door — both sides were derived from the same array —
    // and was wrong through the GraphQL door too, because the order's quantity
    // is post-refund while the lines' is not.
    linesTruncated: node.lineItems?.pageInfo?.hasNextPage === true,
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
  line_items?: WebhookLine[] | null;
  /// Order-level discount applications. A line's allocations point at these by
  /// position, which is the only place their names live.
  discount_applications?: { title?: string | null; code?: string | null }[] | null;
  refunds?:
    { transactions?: { amount?: string | null; kind?: string | null }[] | null }[] | null;
}

interface WebhookLine {
  id?: number | string;
  admin_graphql_api_id?: string;
  title?: string | null;
  name?: string | null;
  variant_title?: string | null;
  sku?: string | null;
  product_id?: number | string | null;
  variant_id?: number | string | null;
  quantity?: number | null;
  /// After returns and order edits. Shopify sends this alongside `quantity`.
  current_quantity?: number | null;
  price?: string | null;
  /// What came off this line in total. The only signal when a discount was
  /// applied without an allocation entry — a draft order's, most often.
  total_discount?: string | null;
  discount_allocations?:
    { amount?: string | null; discount_application_index?: number | null }[] | null;
}

/**
 * The lines of one order, from a webhook payload.
 *
 * Two differences from the GraphQL shape, both of them traps. The payload
 * carries a *per-unit* price and no line totals, so the original total is
 * `price × quantity` and the discounted total is that minus the allocations —
 * there is no field to read either from. And a line's allocations name their
 * discount by **index into the order's** `discount_applications`, so a name
 * only exists if that array came through.
 */
export function linesFromWebhook(
  order: WebhookOrder,
  currencyCode: string,
): OrderLineFacts[] {
  const applications = order.discount_applications ?? [];

  return (order.line_items ?? []).map((line) => {
    const quantity = readQuantity(line.quantity);
    const currentQuantity =
      line.current_quantity === undefined || line.current_quantity === null
        ? quantity
        : readQuantity(line.current_quantity);
    const unitPrice = readMoney(line.price, currencyCode);
    const originalTotal = money(unitPrice.amount * quantity, currencyCode);

    const discounts: LineDiscount[] = (line.discount_allocations ?? []).map(
      (allocation) => {
        const index = allocation.discount_application_index;
        const application = typeof index === "number" ? applications[index] : undefined;

        return {
          title:
            trimmed(application?.title) ?? trimmed(application?.code) ?? UNNAMED_DISCOUNT,
          amount: readMoney(allocation.amount, currencyCode),
        };
      },
    );

    let allocated = discounts.reduce((sum, discount) => sum + discount.amount.amount, 0);

    // A line can carry a discount with no allocation entry — a draft order's,
    // which is how an accepted quote arrives. Without this the line mirrored
    // at full price with no discount on it, so a quote's own discount showed
    // as revenue the merchant never took.
    const totalDiscount = readMoney(line.total_discount ?? "0", currencyCode).amount;
    if (allocated === 0 && totalDiscount > 0) {
      discounts.push({
        title: UNNAMED_DISCOUNT,
        amount: money(totalDiscount, currencyCode),
      });
      allocated = totalDiscount;
    }

    // Never below zero: a payload whose allocations exceed the line is a
    // payload we have misread, and a negative line total would be reported as
    // negative revenue on a chart.
    const discountedTotal = money(
      Math.max(0, originalTotal.amount - allocated),
      currencyCode,
    );

    return {
      lineItemId:
        line.admin_graphql_api_id ??
        (line.id === undefined || line.id === null
          ? ""
          : `gid://shopify/LineItem/${line.id}`),
      title: trimmed(line.title) ?? trimmed(line.name) ?? "Untitled item",
      variantTitle: trimmed(line.variant_title),
      sku: trimmed(line.sku),
      productId: gid("Product", line.product_id),
      variantId: gid("ProductVariant", line.variant_id),
      quantity,
      currentQuantity,
      unitPrice,
      originalTotal,
      discountedTotal,
      currentTotal: currentTotalOf(discountedTotal, quantity, currentQuantity),
      discounts,
    };
  });
}

/** A numeric REST id as the GID everything else in this app speaks. */
function gid(kind: string, id: number | string | null | undefined): string | null {
  return id === undefined || id === null ? null : `gid://shopify/${kind}/${id}`;
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
    // `current_quantity`, to match the `current_*` totals beside it and the
    // node door's `currentSubtotalLineItemsQuantity`. Summing the ordered
    // quantity here made the order's own quantity disagree with its own money.
    totalQuantity: (order.line_items ?? []).reduce(
      (sum, line) =>
        sum +
        readQuantity(
          line.current_quantity === undefined || line.current_quantity === null
            ? line.quantity
            : line.current_quantity,
        ),
      0,
    ),
    source: classifySource(order.source_name ?? null, attribute),
    sourceName: trimmed(order.source_name),
    tags: normalizeTags(tags),
    processedAt:
      readDate(order.processed_at) ?? readDate(order.created_at) ?? new Date(0),
    cancelledAt: readDate(order.cancelled_at),
    shopifyUpdatedAt: readDate(order.updated_at),
    // A line with no id at all cannot be written or de-duplicated, and one
    // arrived is one we would otherwise silently mirror twice.
    lines: linesFromWebhook(order, currencyCode).filter((line) => line.lineItemId !== ""),
    // A webhook cannot be paginated, so the only signal is the cap itself.
    linesTruncated: (order.line_items ?? []).length >= WEBHOOK_LINE_CAP,
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

  // A payload that carried no lines says nothing about the lines we already
  // hold — some order webhooks (a fulfilment, a cancellation) arrive without
  // `line_items`, and letting one of those set this flag would mark a
  // perfectly mirrored order as incomplete. On a *new* order there is nothing
  // to preserve, so what arrived is what we have.
  const truncated = facts.linesTruncated;
  const withLines =
    facts.lines.length > 0 ? { ...updatable, linesTruncated: truncated } : updatable;

  return db.$transaction(async (tx) => {
    const order = await tx.order.upsert({
      where: { shop_orderId: { shop: data.shop, orderId: facts.orderId } },
      create: { ...data, linesTruncated: truncated },
      update: withLines,
    });

    await replaceLines(tx, order.id, facts.lines);
    return order;
  });
}

/** Anything that can write lines — the client, or a transaction. */
type LineWriter = Pick<typeof db, "orderLine">;

/**
 * The order's lines, as they are now.
 *
 * Deleted and rewritten rather than reconciled by id. An order edited in
 * Shopify loses lines as well as gaining them, and an upsert-only pass leaves
 * the removed ones behind — as revenue, on a chart, for a product the merchant
 * never sold. Both halves are in the caller's transaction, so an order never
 * exists with half its lines.
 *
 * A payload that carried no lines at all leaves the ones we have alone: some
 * order webhooks (a fulfilment, a cancellation) arrive without `line_items`,
 * and treating "not mentioned" as "deleted" would empty the table an event at
 * a time.
 */
async function replaceLines(
  tx: LineWriter,
  orderRowId: string,
  lines: readonly OrderLineFacts[],
): Promise<void> {
  if (lines.length === 0) return;

  await tx.orderLine.deleteMany({ where: { orderId: orderRowId } });
  await tx.orderLine.createMany({
    // A payload that repeats a line item id would otherwise hit the unique
    // index, roll the whole order back, and 500 the webhook — which Shopify
    // then redelivers, to fail the same way. A duplicate is a line we already
    // have.
    skipDuplicates: true,
    data: lines.map((line) => ({
      ...tenant(),
      orderId: orderRowId,
      lineItemId: line.lineItemId,
      title: line.title,
      variantTitle: line.variantTitle,
      sku: line.sku,
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity,
      currentQuantity: line.currentQuantity,
      unitPrice: line.unitPrice.amount,
      originalTotal: line.originalTotal.amount,
      discountedTotal: line.discountedTotal.amount,
      currentTotal: line.currentTotal.amount,
      discounts: line.discounts.map((discount) => ({
        title: discount.title,
        amount: discount.amount.amount,
      })),
    })),
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
