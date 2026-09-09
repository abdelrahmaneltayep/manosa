import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";

/**
 * Resolve SKUs to variant ids.
 *
 * Merchants think in SKUs; the engine targets variant ids. Resolving up front
 * means an unknown SKU becomes a listed error on the dry-run report rather than
 * a rule that quietly targets nothing.
 */

const LOOKUP = `#graphql
  query MannonVariantsBySku($query: String!) {
    productVariants(first: 250, query: $query) {
      nodes {
        id
        sku
      }
    }
  }`;

/** Shopify's search syntax needs quoting; SKUs contain spaces and colons. */
function skuQuery(skus: string[]): string {
  return skus.map((sku) => `sku:'${sku.replace(/'/g, "\\'")}'`).join(" OR ");
}

/** Batched so one big file is a handful of round trips, not hundreds. */
const BATCH_SIZE = 40;

export async function resolveSkus(
  admin: AdminGraphql,
  skus: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (skus.length === 0) return found;

  for (let index = 0; index < skus.length; index += BATCH_SIZE) {
    const batch = skus.slice(index, index + BATCH_SIZE);
    const response = await admin.graphql(LOOKUP, {
      variables: { query: skuQuery(batch) },
    });
    const body = (await response.json()) as {
      data?: { productVariants?: { nodes?: { id: string; sku: string | null }[] } };
    };

    for (const node of body.data?.productVariants?.nodes ?? []) {
      // Shopify's search is fuzzy at the edges, so only exact matches count —
      // pricing the wrong variant is worse than reporting an unknown SKU.
      if (node.sku && batch.includes(node.sku)) found.set(node.sku, node.id);
    }
  }

  return found;
}
