import { money, parseMoney, type Money } from "@mannon/pricing-engine";

import { db } from "~/db.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import {
  PRODUCT_COLLECTIONS_FIELD,
  productCollectionIds,
  type ProductCollectionsMetafield,
} from "~/lib/pricing/product-collections.server";
import { activeEngineRules } from "~/lib/pricing/rules.server";
import { formatCurrency } from "~/lib/money";
import { priceLine, type BuyerForPricing } from "~/lib/quotes/pricing.server";
import type { PasteLine } from "~/lib/storefront/paste-list";

/**
 * Turning a pasted list into priced cart lines.
 *
 * Two steps, and neither is done in Liquid. The SKU lookup needs the Admin API,
 * and the price has to come from `packages/pricing-engine` — the same module
 * the checkout Function runs, so what the buyer is shown here is what they will
 * be charged. A price composed in a theme would be a second implementation and
 * would drift the first time a rule kind was added.
 */

const VARIANTS_BY_SKU = `#graphql
  query MannonVariantsBySku($query: String!, $first: Int!) {
    productVariants(first: $first, query: $query) {
      nodes {
        id
        sku
        title
        price
        availableForSale
        inventoryQuantity
        inventoryPolicy
        product {
          id
          title
          handle
          status
          ${PRODUCT_COLLECTIONS_FIELD}
        }
      }
    }
  }`;

export interface VariantNode {
  id: string;
  sku: string | null;
  title: string | null;
  price: string | null;
  availableForSale: boolean | null;
  inventoryQuantity: number | null;
  inventoryPolicy: string | null;
  product:
    | ({
        id: string;
        title: string | null;
        handle: string | null;
        status: string | null;
      } & ProductCollectionsMetafield)
    | null;
}

export type StockState = "in_stock" | "low" | "backorder" | "out_of_stock";

export interface ResolvedLine {
  lineNumber: number;
  sku: string;
  quantity: number;
  variantId: string;
  productId: string;
  /** "Blue Mug — Large". */
  title: string;
  /** The storefront path, for the no-JS fallback link. */
  href: string | null;
  /** Formatted at the buyer's own price. */
  unitPrice: string;
  lineTotal: string;
  /** The price with no wholesale rule, when it differs. Null when it does not. */
  wasPrice: string | null;
  /** Which rules produced the price — deciding shows its working. */
  ruleSummary: string | null;
  stock: StockState;
  /** Only when the merchant tracks it and it is running out. */
  stockCount: number | null;
}

export interface UnresolvedLine {
  lineNumber: number;
  sku: string;
  quantity: number;
  reason: "not_found" | "unavailable";
}

export interface QuickOrderResult {
  /** Display only — Shopify still decides what is charged. */
  taxDisplay: "excl" | "incl";
  lines: ResolvedLine[];
  unresolved: UnresolvedLine[];
  subtotal: string;
  /** Minor units, for anything that needs to compare rather than display. */
  subtotalAmount: number;
  currencyCode: string;
}

/** Below this many in stock, a buyer is told the number rather than "in stock". */
export const LOW_STOCK_AT = 20;

/** Shopify's page cap, and as many SKUs as one paste can carry. */
const LOOKUP_BATCH = 100;

function stockOf(node: VariantNode, quantity: number): StockState {
  if (node.availableForSale === false) return "out_of_stock";
  // Continue-selling means the merchant will backorder; that is not "out of
  // stock" to a wholesale buyer, and saying so would lose a real order.
  if (node.inventoryPolicy?.toUpperCase() === "CONTINUE") {
    return (node.inventoryQuantity ?? 0) <= 0 ? "backorder" : "in_stock";
  }
  const onHand = node.inventoryQuantity;
  if (onHand === null || onHand === undefined) return "in_stock";
  if (onHand <= 0) return "out_of_stock";
  if (onHand < quantity || onHand <= LOW_STOCK_AT) return "low";
  return "in_stock";
}

/**
 * Look up variants by SKU.
 *
 * One query for the whole paste rather than one per line: forty round trips
 * against a rate limit shared with pricing and publishing would make the form
 * feel broken on exactly the orders that matter most.
 */
export async function findVariantsBySku(
  admin: AdminGraphql,
  skus: string[],
): Promise<Map<string, VariantNode>> {
  const wanted = [...new Set(skus.map((sku) => sku.trim()).filter(Boolean))].slice(
    0,
    LOOKUP_BATCH,
  );
  if (wanted.length === 0) return new Map();

  // Quoted, so a SKU containing a space or a colon cannot change the query.
  const query = wanted.map((sku) => `sku:"${sku.replace(/["\\]/g, "")}"`).join(" OR ");

  const response = await admin.graphql(VARIANTS_BY_SKU, {
    variables: { query, first: LOOKUP_BATCH },
  });
  const body = (await response.json()) as {
    data?: { productVariants?: { nodes: VariantNode[] } };
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    throw new Error(
      `SKU lookup failed: ${body.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const nodes = body.data?.productVariants?.nodes ?? [];
  const found = new Map<string, VariantNode>();
  for (const node of nodes) {
    if (node.sku) found.set(node.sku.trim().toLowerCase(), node);
  }
  return found;
}

/**
 * Price a pasted list for one buyer.
 *
 * A SKU we cannot find, or a product that is not published, comes back in
 * `unresolved` with a reason. Nothing is dropped — a buyer whose forty-line
 * paste becomes a thirty-nine-line cart has been failed quietly.
 */
export async function priceQuickOrder(
  admin: AdminGraphql,
  lines: PasteLine[],
  buyer: BuyerForPricing,
  {
    now,
    currencyCode,
    locale,
    // Settings: "Off if your trade buyers should never see the retail price."
    // This block used to send the struck-through price regardless, so that
    // setting promised something it never did.
    showCompareAt = true,
    taxDisplay = "excl",
  }: {
    now: Date;
    currencyCode: string;
    locale?: string;
    showCompareAt?: boolean;
    taxDisplay?: "excl" | "incl";
  },
): Promise<QuickOrderResult> {
  const [variants, { rules }] = await Promise.all([
    findVariantsBySku(
      admin,
      lines.map((line) => line.sku),
    ),
    activeEngineRules(),
  ]);

  const resolved: ResolvedLine[] = [];
  const unresolved: UnresolvedLine[] = [];
  let subtotal = 0;

  for (const line of lines) {
    const node = variants.get(line.sku.trim().toLowerCase());

    if (!node) {
      unresolved.push({ ...line, reason: "not_found" });
      continue;
    }
    if (node.product?.status && node.product.status.toUpperCase() !== "ACTIVE") {
      // A draft or archived product is not something a buyer can order, and
      // "not found" would send them looking for a typo that is not there.
      unresolved.push({ ...line, reason: "unavailable" });
      continue;
    }

    const listPrice = toMoney(node.price, currencyCode);
    const priced = priceLine(
      {
        variantId: node.id,
        productId: node.product?.id ?? null,
        title: variantTitle(node),
        sku: node.sku,
        quantity: line.quantity,
        listPrice,
        // The same metafield the checkout Function reads, so what this block
        // shows and what checkout charges cannot disagree.
        collectionIds: productCollectionIds(node.product),
      },
      buyer,
      rules,
      { now, currencyCode },
    );

    const total = priced.unitPrice.amount * line.quantity;
    subtotal += total;

    resolved.push({
      lineNumber: line.lineNumber,
      sku: node.sku ?? line.sku,
      quantity: line.quantity,
      variantId: node.id,
      productId: node.product?.id ?? node.id,
      title: variantTitle(node),
      href: node.product?.handle ? `/products/${node.product.handle}` : null,
      unitPrice: formatCurrency(priced.unitPrice, locale),
      lineTotal: formatCurrency(money(total, currencyCode), locale),
      wasPrice:
        !showCompareAt || priced.unitPrice.amount === listPrice.amount
          ? null
          : formatCurrency(listPrice, locale),
      ruleSummary: priced.ruleSummary,
      stock: stockOf(node, line.quantity),
      stockCount:
        node.inventoryQuantity !== null && node.inventoryQuantity <= LOW_STOCK_AT
          ? node.inventoryQuantity
          : null,
    });
  }

  return {
    lines: resolved,
    unresolved,
    taxDisplay,
    subtotal: formatCurrency(money(subtotal, currencyCode), locale),
    subtotalAmount: subtotal,
    currencyCode,
  };
}

/** The buyer's pricing facts, from the mirror. A guest has none. */
export async function buyerFacts(customerId: string | null): Promise<BuyerForPricing> {
  if (!customerId) return { customerId: null, tags: [], groupIds: [] };

  const buyer = await db.customer.findFirst({ where: { customerId } });
  return {
    customerId,
    tags: buyer?.tags ?? [],
    groupIds: buyer?.groupId ? [buyer.groupId] : [],
  };
}

export function variantTitle(node: VariantNode): string {
  const product = node.product?.title?.trim();
  const variant = node.title?.trim();
  // Shopify calls a single-variant product's only variant "Default Title",
  // which is not a thing to show a buyer.
  if (!variant || variant.toLowerCase() === "default title") {
    return product || node.sku || node.id;
  }
  return [product, variant].filter(Boolean).join(" — ");
}

/**
 * Shopify sends a variant price as a decimal string.
 *
 * Through `parseMoney`, which knows each currency's exponent — "12.500" is
 * 12500 fils in KWD and 1250 cents would be wrong. A price we cannot read
 * becomes zero, which is visible rather than silently ten times out.
 */
export function toMoney(price: string | null, currencyCode: string): Money {
  try {
    return parseMoney((price ?? "0").trim() || "0", currencyCode);
  } catch {
    return money(0, currencyCode);
  }
}
