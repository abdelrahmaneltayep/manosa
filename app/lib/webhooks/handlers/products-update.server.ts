import { publishProductCollections } from "~/lib/pricing/product-facts.server";
import type { WebhookContext } from "~/lib/webhooks/registry";
import { unauthenticated } from "~/shopify.server";

interface ProductPayload {
  admin_graphql_api_id?: string;
  id?: number;
}

/**
 * Keep a product's published collection membership current.
 *
 * `products/update` fires when a product changes, including when it is added
 * to or removed from a collection through the product. It does **not** fire
 * when a collection's own rules change and sweep products in or out — that
 * gap is covered by `collections/update`.
 */
export async function handleProductsUpdate({ shop, payload }: WebhookContext) {
  const product = payload as ProductPayload;
  const productId =
    product.admin_graphql_api_id ??
    (product.id ? `gid://shopify/Product/${product.id}` : null);

  if (!productId) {
    console.warn(`[mannon] products webhook for ${shop} had no product id`);
    return;
  }

  const { admin } = await unauthenticated.admin(shop);
  await publishProductCollections(admin, productId);
}
