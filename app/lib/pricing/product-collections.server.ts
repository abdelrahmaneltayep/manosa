import type { PricingRule } from "@mannon/pricing-engine";

import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { MANNON_NAMESPACE } from "~/lib/pricing/ruleset.server";

/** The metafield key both the writer and every reader use. Defined once. */
export const PRODUCT_COLLECTIONS_KEY = "collections";

/**
 * The one place anything outside checkout learns which collections a product
 * is in.
 *
 * Every surface that is not the checkout Function used to hand the engine
 * `collectionIds: []` — hardcoded, in the single function that prices quick
 * order, quotes, the Buyer Agent and PO-to-order. With the most ordinary
 * wholesale rule there is, _"20% off everything except Sale"_, the quick-order
 * block showed a sale item at $8.00 and checkout charged $10.00. A quote,
 * which is a promise, locked the wrong number permanently.
 *
 * The fix is not "fetch the collections" — that would be a second source of
 * truth, and it would disagree the moment one of them lagged. It is to read
 * **the same metafield the Function reads**, so the two cannot say different
 * things about the same product: if the metafield is stale both are stale
 * together, and the backfill that fills it fixes both at once.
 *
 * `MANNON_NAMESPACE` is app-reserved, so only this app can read or write it.
 */

/**
 * The metafield selection, for a query that already has a `product { … }`.
 *
 * A string rather than a GraphQL fragment because these queries are sent as
 * plain text and a fragment would have to be spread into each of them by hand
 * — which is the registration step this repo keeps finding.
 */
export const PRODUCT_COLLECTIONS_FIELD = `collections: metafield(namespace: "${MANNON_NAMESPACE}", key: "${PRODUCT_COLLECTIONS_KEY}") {
          jsonValue
        }`;

/** The shape the field above adds to a product node. */
export interface ProductCollectionsMetafield {
  collections?: { jsonValue?: unknown } | null;
}

/**
 * Read the published list off a product node.
 *
 * An unwritten metafield and a product in no collections are both `[]` here,
 * and they are genuinely different things — one is "we do not know yet". That
 * difference is not this function's to report: `productsBackfilledAt` on the
 * shop says whether the store has been published at all, and the Pricing page
 * shows it. Returning `[]` is what the Function does with the same value, and
 * agreeing with checkout is the whole point.
 */
export function productCollectionIds(
  product: ProductCollectionsMetafield | null | undefined,
): string[] {
  const value = product?.collections?.jsonValue;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/* -------------------------------------------------------------------------- */

const PRODUCTS_COLLECTIONS = `#graphql
  query MannonProductsCollections($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        ${PRODUCT_COLLECTIONS_FIELD}
      }
    }
  }`;

/**
 * Read the published membership for a handful of products at once.
 *
 * For the one surface that is handed product ids and nothing else: the theme's
 * variants table posts the ids and list prices it already rendered, so there is
 * no product node to read the field off. One batched query for the page's
 * distinct products rather than one per variant.
 *
 * Failure is an empty map, not a throw. A buyer standing on a product page gets
 * the theme's own prices back, which is what they were already looking at —
 * and the alternative, pricing them as if they were in no collection, is the
 * bug this whole module exists to close.
 */
export async function fetchProductCollections(
  admin: AdminGraphql,
  productIds: readonly string[],
): Promise<Map<string, string[]>> {
  const ids = [...new Set(productIds.filter(Boolean))];
  const found = new Map<string, string[]>();
  if (ids.length === 0) return found;

  try {
    const response = await admin.graphql(PRODUCTS_COLLECTIONS, { variables: { ids } });
    const body = (await response.json()) as {
      data?: { nodes?: ({ id?: string } & ProductCollectionsMetafield)[] };
      errors?: { message: string }[];
    };

    if (body.errors?.length) {
      console.warn(
        `[mannon] product collections lookup failed: ${body.errors
          .map((error) => error.message)
          .join("; ")}`,
      );
      return found;
    }

    for (const node of body.data?.nodes ?? []) {
      if (node?.id) found.set(node.id, productCollectionIds(node));
    }
  } catch (error) {
    console.warn(
      `[mannon] product collections lookup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return found;
}

/**
 * Does this rule's answer depend on which collections a product is in?
 *
 * Both directions count, and the second is the expensive one: a rule that
 * *excludes* a collection excludes nothing when the membership is unknown, so
 * it discounts exactly the products the merchant protected.
 */
export const ruleUsesCollections = (rule: PricingRule): boolean =>
  rule.targets.mode === "collections" ||
  (rule.targets.excludeCollectionIds?.length ?? 0) > 0;
