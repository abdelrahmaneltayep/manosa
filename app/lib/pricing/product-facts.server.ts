import { runMutation, type AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { MANNON_NAMESPACE } from "~/lib/pricing/ruleset.server";

export const PRODUCT_COLLECTIONS_KEY = "collections";

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
