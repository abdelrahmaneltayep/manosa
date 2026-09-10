import { parseMoney, type MarginCandidate, type Targeting } from "@mannon/pricing-engine";

import { runQuery, type AdminGraphql } from "~/lib/pricing/admin-graphql.server";

/**
 * The catalogue, as the pricing screens need to see it.
 *
 * Two readers live here because they ask Shopify the same kind of question:
 * the ✦ draft needs collection *names* (Claude is given names, never ids — it
 * cannot know a `gid://`), and the margin guard needs prices and costs for the
 * variants a rule would touch.
 *
 * Everything is capped. A store with 40,000 variants must not turn "check this
 * rule" into a five-minute API crawl, so the guard prices a sample and the
 * report says it sampled — see `docs/adr/0019`.
 */

/** How many collections the model is told about. Shopify's page maximum. */
export const COLLECTION_LIMIT = 250;

/** How many products the guard prices when a rule targets more than that. */
export const MARGIN_SAMPLE_PRODUCTS = 50;

/** `nodes(ids:)` takes at most this many. */
const NODE_BATCH = 100;

export interface CollectionSummary {
  id: string;
  title: string;
  handle: string;
}

const COLLECTIONS = `#graphql
  query MannonCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      nodes {
        id
        title
        handle
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

/** Every collection in the shop, up to `COLLECTION_LIMIT`. */
export async function fetchCollections(
  admin: AdminGraphql,
  limit = COLLECTION_LIMIT,
): Promise<CollectionSummary[]> {
  const collections: CollectionSummary[] = [];
  let after: string | null = null;

  do {
    const data: {
      collections: {
        nodes: CollectionSummary[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await runQuery(admin, "collections", COLLECTIONS, {
      first: Math.min(250, limit - collections.length),
      after,
    });

    collections.push(...data.collections.nodes);
    after = data.collections.pageInfo.hasNextPage
      ? data.collections.pageInfo.endCursor
      : null;
  } while (after && collections.length < limit);

  return collections.slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Prices and costs, for the margin guard                                      */
/* -------------------------------------------------------------------------- */

const VARIANT_FIELDS = `
  id
  sku
  title
  price
  inventoryItem {
    unitCost {
      amount
      currencyCode
    }
  }`;

const PRODUCT_FIELDS = `
  id
  title
  collections(first: 50) {
    nodes {
      id
    }
  }
  variants(first: 100) {
    nodes {${VARIANT_FIELDS}
    }
  }`;

const VARIANTS_BY_ID = `#graphql
  query MannonVariantCosts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {${VARIANT_FIELDS}
        product {
          id
          title
          collections(first: 50) {
            nodes {
              id
            }
          }
        }
      }
    }
  }`;

const PRODUCTS_BY_ID = `#graphql
  query MannonProductCosts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {${PRODUCT_FIELDS}
      }
    }
  }`;

const COLLECTION_PRODUCTS = `#graphql
  query MannonCollectionCosts($id: ID!, $first: Int!) {
    collection(id: $id) {
      products(first: $first) {
        nodes {${PRODUCT_FIELDS}
        }
      }
    }
  }`;

const CATALOG_PRODUCTS = `#graphql
  query MannonCatalogCosts($first: Int!) {
    products(first: $first) {
      nodes {${PRODUCT_FIELDS}
      }
    }
  }`;

interface VariantNode {
  id: string;
  sku: string | null;
  title: string;
  price: string;
  inventoryItem?: { unitCost?: { amount: string; currencyCode: string } | null } | null;
}

interface ProductNode {
  id: string;
  title: string;
  collections: { nodes: { id: string }[] };
  variants: { nodes: VariantNode[] };
}

export interface CandidateSample {
  candidates: MarginCandidate[];
  /** True when the rule targets more than the guard priced. */
  sampled: boolean;
}

/**
 * `Money` is a decimal string in the Admin API; the engine wants minor units.
 *
 * This is the third place in this app where an amount has arrived as a decimal
 * string, and the first two both shipped a ×100 that is wrong in KWD and in
 * JPY. `parseMoney` is the only thing allowed to do this conversion.
 */
function toMoney(amount: string | null | undefined, currencyCode: string) {
  if (amount === null || amount === undefined || amount === "") return null;
  try {
    return parseMoney(amount, currencyCode);
  } catch {
    return null;
  }
}

function candidateFrom(
  variant: VariantNode,
  product: { id: string; title: string; collectionIds: string[] },
  currencyCode: string,
): MarginCandidate | null {
  const price = toMoney(variant.price, currencyCode);
  if (!price) return null;

  const cost = variant.inventoryItem?.unitCost;
  return {
    variantId: variant.id,
    productId: product.id,
    sku: variant.sku || null,
    // "Blue / Large" on its own names nothing a merchant can act on.
    title:
      variant.title && variant.title !== "Default Title"
        ? `${product.title} — ${variant.title}`
        : product.title,
    collectionIds: product.collectionIds,
    price,
    cost: cost ? toMoney(cost.amount, cost.currencyCode) : null,
  };
}

function fromProducts(products: ProductNode[], currencyCode: string): MarginCandidate[] {
  return products.flatMap((product) =>
    product.variants.nodes.flatMap((variant) => {
      const candidate = candidateFrom(
        variant,
        {
          id: product.id,
          title: product.title,
          collectionIds: product.collections.nodes.map((node) => node.id),
        },
        currencyCode,
      );
      return candidate ? [candidate] : [];
    }),
  );
}

/**
 * The variants this rule would price, with their costs.
 *
 * Exclusions are not filtered here: the engine decides what a rule applies to,
 * and the guard counts an excluded variant as "not applicable" rather than as
 * "checked". Two implementations of "does this rule apply" is exactly the
 * disagreement invariant 1 exists to prevent.
 */
export async function fetchMarginCandidates(
  admin: AdminGraphql,
  targets: Targeting,
  currencyCode: string,
  limit = MARGIN_SAMPLE_PRODUCTS,
): Promise<CandidateSample> {
  switch (targets.mode) {
    case "variants": {
      const ids = (targets.variantIds ?? []).slice(0, NODE_BATCH);
      if (ids.length === 0) return { candidates: [], sampled: false };

      const data: { nodes: (VariantNode & { product: ProductNode | null })[] } =
        await runQuery(admin, "variant costs", VARIANTS_BY_ID, { ids });

      const candidates = data.nodes.flatMap((node) => {
        // A variant deleted in Shopify comes back as null in the array.
        if (!node?.product) return [];
        const candidate = candidateFrom(
          node,
          {
            id: node.product.id,
            title: node.product.title,
            collectionIds: node.product.collections.nodes.map((one) => one.id),
          },
          currencyCode,
        );
        return candidate ? [candidate] : [];
      });

      return {
        candidates,
        sampled: (targets.variantIds ?? []).length > ids.length,
      };
    }

    case "products": {
      const ids = (targets.productIds ?? []).slice(0, limit);
      if (ids.length === 0) return { candidates: [], sampled: false };

      const data: { nodes: (ProductNode | null)[] } = await runQuery(
        admin,
        "product costs",
        PRODUCTS_BY_ID,
        { ids },
      );

      return {
        candidates: fromProducts(
          data.nodes.filter((node): node is ProductNode => Boolean(node)),
          currencyCode,
        ),
        sampled: (targets.productIds ?? []).length > ids.length,
      };
    }

    case "collections": {
      const ids = targets.collectionIds ?? [];
      if (ids.length === 0) return { candidates: [], sampled: false };

      // Spread the budget across the collections rather than spending it all
      // on the first one: a rule covering three collections should be checked
      // against all three.
      const perCollection = Math.max(1, Math.floor(limit / ids.length));
      const candidates: MarginCandidate[] = [];
      let sampled = false;

      for (const id of ids) {
        const data: { collection: { products: { nodes: ProductNode[] } } | null } =
          await runQuery(admin, "collection costs", COLLECTION_PRODUCTS, {
            id,
            first: perCollection,
          });

        const nodes = data.collection?.products.nodes ?? [];
        if (nodes.length === perCollection) sampled = true;
        candidates.push(...fromProducts(nodes, currencyCode));
      }

      return { candidates, sampled };
    }

    case "all":
    default: {
      const data: { products: { nodes: ProductNode[] } } = await runQuery(
        admin,
        "catalog costs",
        CATALOG_PRODUCTS,
        { first: limit },
      );

      return {
        candidates: fromProducts(data.products.nodes, currencyCode),
        // A store with exactly `limit` products is reported as sampled, which
        // overstates the doubt rather than understating it.
        sampled: data.products.nodes.length >= limit,
      };
    }
  }
}
