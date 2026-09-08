import { publishProductCollections } from "~/lib/pricing/product-facts.server";
import type { WebhookContext } from "~/lib/webhooks/registry";
import { unauthenticated } from "~/shopify.server";

const COLLECTION_PRODUCTS = `#graphql
  query MannonCollectionProducts($id: ID!, $after: String) {
    collection(id: $id) {
      products(first: 100, after: $after) {
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
 * A collection changed, so every product in it may have gained or lost
 * membership.
 *
 * Only products currently in the collection are refreshed. A product removed
 * from it also fires `products/update`, which covers the other direction — and
 * re-reading a whole catalogue on every collection edit would be far more
 * expensive than the case it fixes.
 */
interface CollectionPayload {
  admin_graphql_api_id?: string;
  id?: number;
}

export async function handleCollectionsUpdate({ shop, payload }: WebhookContext) {
  const collection = payload as CollectionPayload;
  const collectionId =
    collection.admin_graphql_api_id ??
    (collection.id ? `gid://shopify/Collection/${collection.id}` : null);

  if (!collectionId) {
    console.warn(`[mannon] collections webhook for ${shop} had no collection id`);
    return;
  }

  const { admin } = await unauthenticated.admin(shop);
  let after: string | null = null;

  do {
    const response = await admin.graphql(COLLECTION_PRODUCTS, {
      variables: { id: collectionId, after },
    });
    const body = (await response.json()) as {
      data?: {
        collection?: {
          products: {
            nodes: { id: string }[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      };
    };

    const page = body.data?.collection?.products;
    if (!page) break;

    for (const product of page.nodes) {
      await publishProductCollections(admin, product.id);
    }

    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
}
