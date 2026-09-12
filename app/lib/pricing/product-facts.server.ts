import {
  runMutation,
  runQuery,
  type AdminGraphql,
} from "~/lib/pricing/admin-graphql.server";
import { PRODUCT_COLLECTIONS_KEY } from "~/lib/pricing/product-collections.server";
import { MANNON_NAMESPACE } from "~/lib/pricing/ruleset.server";

const SET_METAFIELDS = `#graphql
  mutation MannonSetProductCollections($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

const PRODUCT_COLLECTIONS = `#graphql
  query MannonProductCollections($id: ID!, $after: String) {
    product(id: $id) {
      id
      collections(first: 250, after: $after) {
        nodes {
          id
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }`;

/**
 * Publish a product's collection membership so checkout can evaluate
 * collection-targeted rules.
 *
 * The Function's input query is fixed at deploy time, so
 * `Product.inAnyCollection` cannot be handed a merchant's collection list.
 * Without this metafield a collection rule shows as applying in the admin and
 * silently does not apply at checkout — the one disagreement this app exists
 * to prevent.
 */
export async function publishProductCollections(
  admin: AdminGraphql,
  productId: string,
): Promise<string[]> {
  const collectionIds: string[] = [];
  let after: string | null = null;

  // A product can sit in more than 250 collections; paginating matters because
  // a truncated list silently drops rules for that product.
  do {
    const response = await admin.graphql(PRODUCT_COLLECTIONS, {
      variables: { id: productId, after },
    });
    const body = (await response.json()) as {
      data?: {
        product?: {
          collections: {
            nodes: { id: string }[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      };
    };

    const page = body.data?.product?.collections;
    if (!page) break;

    collectionIds.push(...page.nodes.map((node) => node.id));
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  await runMutation<void>(
    admin,
    "metafieldsSet(collections)",
    SET_METAFIELDS,
    {
      metafields: [
        {
          ownerId: productId,
          namespace: MANNON_NAMESPACE,
          key: PRODUCT_COLLECTIONS_KEY,
          type: "json",
          // Sorted so an unchanged product always produces an identical value.
          value: JSON.stringify([...collectionIds].sort()),
        },
      ],
    },
    (data) => {
      const payload = data.metafieldsSet as { userErrors: { message: string }[] };
      return { result: undefined, userErrors: payload.userErrors };
    },
  );

  return collectionIds;
}

/* -------------------------------------------------------------------------- */
/* The one-off backfill                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Shopify's `metafieldsSet` takes at most 25 metafields in one call, so a page
 * is 25 products: one read and one write per page, rather than two calls per
 * product.
 */
export const PRODUCT_PAGE_SIZE = 25;

/**
 * How many collections one product is read with before it needs its own
 * paginated pass. Well past what any real product has; a product beyond it is
 * re-read by `publishProductCollections`, which pages properly.
 */
const COLLECTIONS_PER_PRODUCT = 250;

const PRODUCTS_PAGE = `#graphql
  query MannonProductsPage($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        id
        collections(first: ${COLLECTIONS_PER_PRODUCT}) {
          nodes {
            id
          }
          pageInfo {
            hasNextPage
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

export interface ProductCollectionsNode {
  id: string;
  collectionIds: string[];
  /** In more collections than one read returns; it needs its own pass. */
  truncated: boolean;
}

export interface ProductCollectionsPage {
  nodes: ProductCollectionsNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** One page of products, each with the collections it belongs to. */
export async function fetchProductCollectionsPage(
  admin: AdminGraphql,
  after: string | null,
): Promise<ProductCollectionsPage> {
  const data = await runQuery<{
    products?: {
      nodes: {
        id: string;
        collections: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean } };
      }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(admin, "products(collections)", PRODUCTS_PAGE, {
    first: PRODUCT_PAGE_SIZE,
    after,
  });

  const page = data.products;
  return {
    nodes: (page?.nodes ?? []).map((node) => ({
      id: node.id,
      collectionIds: node.collections.nodes.map((one) => one.id),
      truncated: node.collections.pageInfo.hasNextPage,
    })),
    hasNextPage: page?.pageInfo.hasNextPage ?? false,
    endCursor: page?.pageInfo.endCursor ?? null,
  };
}

/**
 * Publish a page of products' collection membership in one call.
 *
 * The same value `publishProductCollections` writes for one product, so a
 * product reached by the backfill and a product reached by a webhook carry
 * byte-identical metafields — sorted, so an unchanged product never looks
 * changed.
 */
export async function publishProductCollectionsBulk(
  admin: AdminGraphql,
  products: readonly { id: string; collectionIds: string[] }[],
): Promise<number> {
  if (products.length === 0) return 0;

  await runMutation<void>(
    admin,
    "metafieldsSet(collections, bulk)",
    SET_METAFIELDS,
    {
      metafields: products.map((product) => ({
        ownerId: product.id,
        namespace: MANNON_NAMESPACE,
        key: PRODUCT_COLLECTIONS_KEY,
        type: "json",
        value: JSON.stringify([...product.collectionIds].sort()),
      })),
    },
    (data) => {
      const payload = data.metafieldsSet as { userErrors: { message: string }[] };
      return { result: undefined, userErrors: payload.userErrors };
    },
  );

  return products.length;
}
