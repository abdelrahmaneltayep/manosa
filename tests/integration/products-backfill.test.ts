import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { backfillProducts } from "~/lib/jobs/handlers/backfill-products.server";
import { ensureShopRecord } from "~/lib/shop/ensure-shop.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { PRODUCT_COLLECTIONS_KEY } from "~/lib/pricing/product-collections.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";

/**
 * Publishing an existing catalogue's collection membership to checkout.
 *
 * The checkout Function's input query is fixed at deploy time, so it cannot ask
 * which collections a product is in — the only channel is a metafield this app
 * writes. Before this job the only writers were the `products/update` and
 * `collections/update` webhooks, which fire on *change*: a store installing
 * Mannon with an existing catalogue sent every product to checkout with no
 * collections at all.
 *
 * The direction that costs money is the exclusion. "20% off everything except
 * Sale" is the canonical wholesale rule, and with no membership it excludes
 * nothing — the discount lands on exactly the products the merchant protected.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";

const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);

interface Call {
  query: string;
  variables?: Record<string, unknown>;
}

interface ProductsPage {
  nodes: { id: string; collections: string[]; more?: boolean }[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/**
 * These calls cannot be exercised without a real store, so the fake pins the
 * request we send rather than a response we control.
 */
function fakeAdmin(pages: ProductsPage[]): AdminGraphql & { calls: Call[] } {
  const calls: Call[] = [];
  let page = 0;

  return {
    calls,
    graphql: vi.fn(
      async (query: string, options?: { variables?: Record<string, unknown> }) => {
        calls.push({ query, variables: options?.variables });

        if (query.includes("MannonProductsPage")) {
          const current = pages[Math.min(page, pages.length - 1)]!;
          page += 1;
          return {
            json: async () => ({
              data: {
                products: {
                  nodes: current.nodes.map((node) => ({
                    id: node.id,
                    collections: {
                      nodes: node.collections.map((id) => ({ id })),
                      pageInfo: { hasNextPage: node.more ?? false },
                    },
                  })),
                  pageInfo: {
                    hasNextPage: current.hasNextPage,
                    endCursor: current.endCursor,
                  },
                },
              },
            }),
          };
        }

        if (query.includes("MannonProductCollections")) {
          return {
            json: async () => ({
              data: {
                product: {
                  id: "gid://shopify/Product/big",
                  collections: {
                    nodes: [{ id: "gid://shopify/Collection/a" }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            }),
          };
        }

        return {
          json: async () => ({
            data: { metafieldsSet: { metafields: [], userErrors: [] } },
          }),
        };
      },
    ),
  };
}

const installShop = (shop: string) =>
  shopScope.run(shop, () => db.shop.create({ data: { ...tenant() } }));

const metafieldCalls = (admin: { calls: Call[] }) =>
  admin.calls.filter((call) => call.query.includes("MannonSetProductCollections"));

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

describe("publishing an existing catalogue to checkout", () => {
  it("writes each product's collections into the metafield the Function reads", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin([
      {
        nodes: [
          {
            id: "gid://shopify/Product/1",
            collections: [
              "gid://shopify/Collection/sale",
              "gid://shopify/Collection/mugs",
            ],
          },
          { id: "gid://shopify/Product/2", collections: [] },
        ],
        hasNextPage: false,
        endCursor: null,
      },
    ]);

    const result = await inAlpha(() => backfillProducts(async () => admin));
    expect(result).toMatchObject({ done: true, productsPublished: 2 });

    // One write for the page, not one per product.
    const writes = metafieldCalls(admin);
    expect(writes).toHaveLength(1);

    const metafields = writes[0]!.variables!.metafields as Record<string, unknown>[];
    expect(metafields).toHaveLength(2);
    expect(metafields[0]).toMatchObject({
      ownerId: "gid://shopify/Product/1",
      namespace: "$app:mannon",
      key: PRODUCT_COLLECTIONS_KEY,
      type: "json",
    });
    // Sorted, so an unchanged product never looks changed — byte-identical to
    // what the webhook writer produces for the same product.
    expect(JSON.parse(metafields[0]!.value as string)).toEqual([
      "gid://shopify/Collection/mugs",
      "gid://shopify/Collection/sale",
    ]);
    // A product in no collections is still published: "we know, and it is
    // none" is a different answer from "we have never looked".
    expect(JSON.parse(metafields[1]!.value as string)).toEqual([]);
  });

  it("pages through the catalogue and queues itself for the next page", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin([
      {
        nodes: [{ id: "gid://shopify/Product/1", collections: [] }],
        hasNextPage: true,
        endCursor: "cursor-1",
      },
      {
        nodes: [{ id: "gid://shopify/Product/2", collections: [] }],
        hasNextPage: false,
        endCursor: null,
      },
    ]);

    await inAlpha(async () => {
      const first = await backfillProducts(async () => admin);
      expect(first).toMatchObject({ done: false, productsPublished: 1 });

      const shop = await db.shop.findUnique({ where: { shop: ALPHA } });
      expect(shop!.productsBackfillCursor).toBe("cursor-1");
      expect(shop!.productsBackfilledAt).toBeNull();

      const queued = await db.scheduledJob.findMany({
        where: { kind: "products.backfill" },
      });
      expect(queued).toHaveLength(1);

      const second = await backfillProducts(async () => admin);
      expect(second).toMatchObject({ done: true, productsPublished: 2 });
    });

    // The second page picked up where the first stopped.
    const pageCalls = admin.calls.filter((call) =>
      call.query.includes("MannonProductsPage"),
    );
    expect(pageCalls[0]!.variables!.after).toBeNull();
    expect(pageCalls[1]!.variables!.after).toBe("cursor-1");

    const shop = await inAlpha(() => db.shop.findUnique({ where: { shop: ALPHA } }));
    expect(shop!.productsBackfilledAt).not.toBeNull();
    expect(shop!.productsBackfillCursor).toBeNull();
    expect(shop!.productsPublished).toBe(2);
  });

  it("gives a product in more collections than one read returns its own pass", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin([
      {
        nodes: [
          {
            id: "gid://shopify/Product/big",
            collections: ["gid://shopify/Collection/a"],
            more: true,
          },
          { id: "gid://shopify/Product/2", collections: [] },
        ],
        hasNextPage: false,
        endCursor: null,
      },
    ]);

    await inAlpha(() => backfillProducts(async () => admin));

    // A truncated list is a rule that silently stops applying to that product,
    // so it is re-read by the paginating writer rather than published short.
    expect(
      admin.calls.some((call) => call.query.includes("MannonProductCollections")),
    ).toBe(true);

    const writes = metafieldCalls(admin);
    // One for the paginated product, one for the rest of the page.
    expect(writes).toHaveLength(2);
    const bulk = writes[1]!.variables!.metafields as Record<string, unknown>[];
    expect(bulk).toHaveLength(1);
    expect(bulk[0]).toMatchObject({ ownerId: "gid://shopify/Product/2" });
  });

  it("does nothing for a shop that has uninstalled", async () => {
    await installShop(ALPHA);
    await inAlpha(() =>
      db.shop.update({ where: { shop: ALPHA }, data: { uninstalledAt: new Date() } }),
    );

    const admin = fakeAdmin([{ nodes: [], hasNextPage: false, endCursor: null }]);
    const result = await inAlpha(() => backfillProducts(async () => admin));

    expect(result).toEqual({ skipped: "uninstalled" });
    expect(admin.calls).toHaveLength(0);
  });

  it("counts only its own shop's progress", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    const admin = fakeAdmin([
      {
        nodes: [{ id: "gid://shopify/Product/1", collections: [] }],
        hasNextPage: false,
        endCursor: null,
      },
    ]);
    await inAlpha(() => backfillProducts(async () => admin));

    const beta = await shopScope.run(BETA, () =>
      db.shop.findUnique({ where: { shop: BETA } }),
    );
    expect(beta!.productsPublished).toBe(0);
    expect(beta!.productsBackfilledAt).toBeNull();
  });
});

describe("who queues it", () => {
  it("is queued at install, beside the customers and orders backfills", async () => {
    // A store installs Mannon with a catalogue it already has. Nothing else
    // would ever publish those products, because the webhooks fire on change.
    await inAlpha(() => ensureShopRecord());

    const queued = await inAlpha(() =>
      db.scheduledJob.findMany({ where: { kind: "products.backfill" } }),
    );
    expect(queued).toHaveLength(1);
  });

  it("is queued again on a reinstall, because the metafields are now stale", async () => {
    await installShop(ALPHA);
    await inAlpha(() =>
      db.shop.update({
        where: { shop: ALPHA },
        data: {
          uninstalledAt: new Date(),
          productsBackfilledAt: new Date("2026-01-01T00:00:00Z"),
          productsPublished: 4000,
        },
      }),
    );

    await inAlpha(() => ensureShopRecord());

    const shop = await inAlpha(() => db.shop.findUnique({ where: { shop: ALPHA } }));
    // A stale metafield reads to checkout exactly like a correct one, so the
    // previous run is forgotten rather than trusted.
    expect(shop!.productsBackfilledAt).toBeNull();
    expect(shop!.productsPublished).toBe(0);

    const queued = await inAlpha(() =>
      db.scheduledJob.findMany({ where: { kind: "products.backfill" } }),
    );
    expect(queued).toHaveLength(1);
  });
});
