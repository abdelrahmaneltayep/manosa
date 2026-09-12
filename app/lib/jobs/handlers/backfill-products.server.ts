import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import {
  fetchProductCollectionsPage,
  PRODUCT_PAGE_SIZE,
  publishProductCollections,
  publishProductCollectionsBulk,
} from "~/lib/pricing/product-facts.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { unauthenticated } from "~/shopify.server";

/**
 * Publish every existing product's collection membership to checkout.
 *
 * The checkout Function cannot ask which collections a product is in — its
 * input query is fixed at deploy time — so the only channel is a metafield this
 * app writes. Until this job existed the only writers were the
 * `products/update` and `collections/update` webhooks, which fire on *change*.
 * A store installing Mannon with ten thousand existing products therefore sent
 * every one of them to checkout with no collections at all, and stayed that way
 * until somebody happened to edit them in Shopify admin.
 *
 * That is not a cosmetic gap. It breaks the most ordinary wholesale rule there
 * is — _"20% off everything except Sale"_ — in the direction that costs the
 * merchant money: with no membership the exclusion excludes nothing, so the
 * discount lands on exactly the products they protected.
 *
 * One page per run, then it re-queues itself with the cursor. Same reason as
 * the customers and orders backfills: a request-triggered runner has a timeout,
 * and a job that tries to page a whole catalogue in one go finishes none of it.
 */
export type AdminForShop = (shop: string) => Promise<AdminGraphql>;

const offlineAdmin: AdminForShop = async (shop) => {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
};

export async function backfillProducts(adminFor: AdminForShop = offlineAdmin) {
  const shop = shopScope.require("backfillProducts");
  const record = await db.shop.findUnique({ where: { shop } });

  if (!record) return { skipped: "no install record" as const };
  if (record.uninstalledAt) return { skipped: "uninstalled" as const };

  const admin = await adminFor(shop);
  const page = await fetchProductCollectionsPage(admin, record.productsBackfillCursor);

  // A product in more collections than one read returns gets its own paginated
  // pass rather than a truncated list — a silently short list is a rule that
  // silently stops applying to that product.
  const truncated = page.nodes.filter((node) => node.truncated);
  for (const node of truncated) {
    await publishProductCollections(admin, node.id);
  }

  const published = await publishProductCollectionsBulk(
    admin,
    page.nodes.filter((node) => !node.truncated),
  );

  const productsPublished = record.productsPublished + published + truncated.length;

  if (page.hasNextPage && page.endCursor) {
    await db.shop.update({
      where: { shop },
      data: { productsBackfillCursor: page.endCursor, productsPublished },
    });
    // Immediately: the next page is due now, not on some interval.
    await enqueueJob({ kind: "products.backfill", runAt: new Date() });
    return { published: published + truncated.length, done: false, productsPublished };
  }

  await db.shop.update({
    where: { shop },
    data: {
      productsBackfillCursor: null,
      productsBackfilledAt: new Date(),
      productsPublished,
    },
  });

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "pricing.products_published",
    summary: `Published collection membership for ${productsPublished} products, so collection rules apply at checkout.`,
    subject: { type: "Shop", id: shop },
    metadata: { productsPublished },
  });

  return { published: published + truncated.length, done: true, productsPublished };
}

/** How many products one run reads. Exported for the tests to assert on. */
export const BACKFILL_PAGE_SIZE = PRODUCT_PAGE_SIZE;
