import { createHmac } from "node:crypto";

import type { PricingRule } from "@mannon/pricing-engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { createRule } from "~/lib/pricing/rules.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { parsePasteList } from "~/lib/storefront/paste-list";
import { signablePayload, withProxy } from "~/lib/storefront/proxy.server";
import {
  buyerFacts,
  findVariantsBySku,
  LOW_STOCK_AT,
  priceQuickOrder,
} from "~/lib/storefront/quick-order.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * The storefront blocks, from the signed request in to the priced list out.
 *
 * The two things being proved: a buyer sees the price the checkout Function
 * will charge, and a signed request for one shop cannot reach another's rows.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const NOW = new Date("2026-09-10T12:00:00Z");
const actor = { type: "STAFF" as const, id: "staff-1" };

function signedRequest(params: Record<string, string>) {
  const search = new URLSearchParams(params);
  search.set(
    "signature",
    createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "test-api-secret")
      .update(signablePayload(search))
      .digest("hex"),
  );
  return new Request(`https://mannon.test/proxy/quick-order?${search.toString()}`);
}

interface VariantSeed {
  id: string;
  sku: string;
  title?: string | null;
  price: string;
  availableForSale?: boolean;
  inventoryQuantity?: number | null;
  inventoryPolicy?: string;
  productStatus?: string;
  productTitle?: string;
  handle?: string;
}

function fakeAdmin(variants: VariantSeed[] = []) {
  const calls: string[] = [];
  const admin: AdminGraphql & { calls: string[] } = {
    calls,
    graphql: vi.fn(async (query: string) => {
      calls.push(query);

      if (query.includes("MannonVariantsBySku")) {
        return {
          json: async () => ({
            data: {
              productVariants: {
                nodes: variants.map((variant) => ({
                  id: variant.id,
                  sku: variant.sku,
                  title: variant.title ?? "Large",
                  price: variant.price,
                  availableForSale: variant.availableForSale ?? true,
                  inventoryQuantity: variant.inventoryQuantity ?? 500,
                  inventoryPolicy: variant.inventoryPolicy ?? "DENY",
                  product: {
                    id: "gid://shopify/Product/1",
                    title: variant.productTitle ?? "Blue Mug",
                    handle: variant.handle ?? "blue-mug",
                    status: variant.productStatus ?? "ACTIVE",
                  },
                })),
              },
            },
          }),
        };
      }
      if (query.includes("MannonDiscountFunction")) {
        return {
          json: async () => ({
            data: {
              shopifyFunctions: { nodes: [{ id: "gid://fn/1", title: "Mannon" }] },
            },
          }),
        };
      }
      if (query.includes("discountAutomaticAppCreate")) {
        return {
          json: async () => ({
            data: {
              discountAutomaticAppCreate: {
                automaticAppDiscount: { discountId: "gid://discount/1" },
                userErrors: [],
              },
            },
          }),
        };
      }
      return {
        json: async () => ({
          data: { metafieldsSet: { metafields: [{ id: "gid://mf/1" }], userErrors: [] } },
        }),
      };
    }),
  };
  return admin;
}

async function installShop(
  shop: string,
  planKey = "pro",
  extra: Record<string, unknown> = {},
) {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        planKey,
        billingStatus: "ACTIVE",
        currencyCode: "USD",
        ...extra,
      },
    }),
  );
}

const wholesaleRule = (percentage: number): PricingRule =>
  ({
    id: "new",
    name: `Wholesale ${percentage}%`,
    status: "active",
    priority: 100,
    combinable: false,
    kind: "percentage",
    value: { percentage },
    targets: { mode: "all" },
    audience: { mode: "tags", tags: ["wholesale"] },
    markets: { mode: "all", marketIds: [] },
    schedule: { startsAt: null, endsAt: null },
    createdAt: new Date("2026-01-01T00:00:00Z"),
  }) as PricingRule;

const seedBuyer = () =>
  db.customer.create({
    data: {
      ...tenant(),
      customerId: "gid://shopify/Customer/77",
      email: "buyer@acme.test",
      tags: ["wholesale"],
      currencyCode: "USD",
    },
  });

const priceList = (
  admin: AdminGraphql,
  text: string,
  buyer: Awaited<ReturnType<typeof buyerFacts>>,
) =>
  priceQuickOrder(admin, parsePasteList(text).lines, buyer, {
    now: NOW,
    currencyCode: "USD",
  });

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */
/* The signed request                                                          */
/* -------------------------------------------------------------------------- */

describe("withProxy", () => {
  it("opens the shop's scope before anything queries", async () => {
    await installShop(ALPHA);

    const seen = await withProxy(signedRequest({ shop: ALPHA }), async () => {
      // Inside the handler, the scoped client answers for this shop and no
      // other. That is the guard, and it is opened in one place.
      return db.shop.findFirstOrThrow();
    });

    expect(seen.shop).toBe(ALPHA);
  });

  it("404s for a shop that never installed the app", async () => {
    await expect(
      withProxy(signedRequest({ shop: "stranger.myshopify.com" }), async () => "reached"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("404s for a shop that uninstalled", async () => {
    await installShop(ALPHA, "pro", { uninstalledAt: NOW });
    await expect(
      withProxy(signedRequest({ shop: ALPHA }), async () => "reached"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("goes quiet while the merchant has the app paused", async () => {
    // Pausing means "stop applying my rules". Pricing from a stale idea of
    // them would be the app arguing with the person using it.
    await installShop(ALPHA, "pro", { pausedAt: NOW });
    await expect(
      withProxy(signedRequest({ shop: ALPHA }), async () => "reached"),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("records that this shop's storefront called us, at most hourly", async () => {
    await installShop(ALPHA);

    await withProxy(signedRequest({ shop: ALPHA }), async () => "ok");
    const first = await shopScope.run(ALPHA, () =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    // This is the setup checklist's only honest evidence that the app embed is
    // live: a proxy request can only come from a theme rendering our blocks.
    expect(first.storefrontSeenAt).toBeInstanceOf(Date);

    await withProxy(signedRequest({ shop: ALPHA }), async () => "ok");
    const second = await shopScope.run(ALPHA, () =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    // Not rewritten on every storefront request: the checklist wants to know
    // whether, not how often, and a write per page view has no reader.
    expect(second.storefrontSeenAt?.getTime()).toBe(first.storefrontSeenAt?.getTime());
  });

  it("401s before it looks up any shop at all", async () => {
    const request = new Request(`https://mannon.test/proxy/quick-order?shop=${ALPHA}`);
    await expect(withProxy(request, async () => "reached")).rejects.toMatchObject({
      status: 401,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Pricing a pasted list                                                       */
/* -------------------------------------------------------------------------- */

describe("priceQuickOrder", () => {
  it("prices at the buyer's wholesale price, not the list price", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await createRule(wholesaleRule(35), { admin: fakeAdmin(), actor });

      const admin = fakeAdmin([
        { id: "gid://shopify/ProductVariant/1", sku: "MUG-BL-L", price: "10.00" },
      ]);
      const result = await priceList(
        admin,
        "MUG-BL-L, 100",
        await buyerFacts("gid://shopify/Customer/77"),
      );

      expect(result.lines[0]).toMatchObject({
        sku: "MUG-BL-L",
        quantity: 100,
        unitPrice: "$6.50",
        wasPrice: "$10.00",
        // The same price the checkout Function will charge, because it is the
        // same module that produced it.
        ruleSummary: "Wholesale 35%",
      });
      expect(result.subtotal).toBe("$650.00");
    });
  });

  it("prices a signed-out visitor at list price rather than refusing", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await createRule(wholesaleRule(35), { admin: fakeAdmin(), actor });
      const admin = fakeAdmin([
        { id: "gid://shopify/ProductVariant/1", sku: "MUG-BL-L", price: "10.00" },
      ]);

      const result = await priceList(admin, "MUG-BL-L, 100", await buyerFacts(null));
      expect(result.lines[0]).toMatchObject({ unitPrice: "$10.00", wasPrice: null });
    });
  });

  it("reads a three-decimal currency without losing a factor of ten", async () => {
    await installShop(ALPHA, "pro", { currencyCode: "KWD" });

    await inAlpha(async () => {
      const admin = fakeAdmin([
        { id: "gid://shopify/ProductVariant/1", sku: "MUG", price: "12.500" },
      ]);
      const result = await priceQuickOrder(
        admin,
        parsePasteList("MUG, 2").lines,
        await buyerFacts(null),
        { now: NOW, currencyCode: "KWD" },
      );

      // 12.500 KWD is 12500 fils, not 1250. Half this app's market.
      expect(result.subtotalAmount).toBe(25000);
    });
  });

  it("says which SKUs it could not find, rather than dropping them", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const admin = fakeAdmin([
        { id: "gid://shopify/ProductVariant/1", sku: "MUG-BL-L", price: "10.00" },
      ]);
      const result = await priceList(
        admin,
        "MUG-BL-L, 10\nNOPE-999, 5",
        await buyerFacts(null),
      );

      expect(result.lines).toHaveLength(1);
      expect(result.unresolved).toMatchObject([
        { lineNumber: 2, sku: "NOPE-999", quantity: 5, reason: "not_found" },
      ]);
    });
  });

  it("tells an unpublished product apart from a typo", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const admin = fakeAdmin([
        {
          id: "gid://shopify/ProductVariant/1",
          sku: "MUG-BL-L",
          price: "10.00",
          productStatus: "DRAFT",
        },
      ]);
      const result = await priceList(admin, "MUG-BL-L, 10", await buyerFacts(null));

      // "Not found" would send a buyer looking for a typo that is not there.
      expect(result.unresolved[0]?.reason).toBe("unavailable");
    });
  });

  it("looks every SKU up in one query, not one per line", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const admin = fakeAdmin([
        { id: "gid://shopify/ProductVariant/1", sku: "A", price: "1.00" },
        { id: "gid://shopify/ProductVariant/2", sku: "B", price: "2.00" },
        { id: "gid://shopify/ProductVariant/3", sku: "C", price: "3.00" },
      ]);
      await priceList(admin, "A,1\nB,2\nC,3", await buyerFacts(null));

      const lookups = admin.calls.filter((query) =>
        query.includes("MannonVariantsBySku"),
      );
      expect(lookups).toHaveLength(1);
    });
  });

  it("matches a SKU whatever case the buyer pasted it in", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const admin = fakeAdmin([
        { id: "gid://shopify/ProductVariant/1", sku: "MUG-BL-L", price: "10.00" },
      ]);
      const result = await priceList(admin, "mug-bl-l, 10", await buyerFacts(null));
      expect(result.lines).toHaveLength(1);
    });
  });

  it("reports stock the way a wholesale buyer needs it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const admin = fakeAdmin([
        {
          id: "gid://shopify/ProductVariant/1",
          sku: "PLENTY",
          price: "1.00",
          inventoryQuantity: 5000,
        },
        {
          id: "gid://shopify/ProductVariant/2",
          sku: "LOW",
          price: "1.00",
          inventoryQuantity: LOW_STOCK_AT - 1,
        },
        {
          id: "gid://shopify/ProductVariant/3",
          sku: "GONE",
          price: "1.00",
          availableForSale: false,
        },
        {
          id: "gid://shopify/ProductVariant/4",
          sku: "BACK",
          price: "1.00",
          inventoryQuantity: 0,
          inventoryPolicy: "CONTINUE",
        },
      ]);

      const result = await priceList(
        admin,
        "PLENTY,1\nLOW,1\nGONE,1\nBACK,1",
        await buyerFacts(null),
      );

      const byStock = Object.fromEntries(
        result.lines.map((line) => [line.sku, line.stock]),
      );
      expect(byStock).toEqual({
        PLENTY: "in_stock",
        LOW: "low",
        GONE: "out_of_stock",
        // Continue-selling is a backorder, not "out of stock" — saying the
        // latter would lose a real wholesale order.
        BACK: "backorder",
      });
    });
  });

  it("calls a line low when there is less on hand than they asked for", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const admin = fakeAdmin([
        {
          id: "gid://shopify/ProductVariant/1",
          sku: "MUG",
          price: "1.00",
          inventoryQuantity: 5000,
        },
      ]);
      const result = await priceList(admin, "MUG, 9000", await buyerFacts(null));
      expect(result.lines[0]?.stock).toBe("low");
    });
  });

  it("drops 'Default Title' rather than showing it to a buyer", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const admin = fakeAdmin([
        {
          id: "gid://shopify/ProductVariant/1",
          sku: "MUG",
          price: "1.00",
          title: "Default Title",
          productTitle: "Blue Mug",
        },
      ]);
      const result = await priceList(admin, "MUG,1", await buyerFacts(null));
      expect(result.lines[0]?.title).toBe("Blue Mug");
    });
  });

  it("carries a link back to the product page for the no-JS fallback", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const admin = fakeAdmin([
        { id: "gid://shopify/ProductVariant/1", sku: "MUG", price: "1.00" },
      ]);
      const result = await priceList(admin, "MUG,1", await buyerFacts(null));
      expect(result.lines[0]?.href).toBe("/products/blue-mug");
    });
  });
});

describe("findVariantsBySku", () => {
  it("asks for nothing when there is nothing to ask about", async () => {
    const admin = fakeAdmin([]);
    expect(await findVariantsBySku(admin, [])).toEqual(new Map());
    expect(admin.calls).toHaveLength(0);
  });

  it("raises a Shopify error rather than pretending nothing matched", async () => {
    const admin: AdminGraphql = {
      graphql: vi.fn(async () => ({
        json: async () => ({ errors: [{ message: "Throttled" }] }),
      })),
    };
    // Silently returning no matches would tell a buyer their SKUs do not
    // exist, which is a different and much worse answer.
    await expect(findVariantsBySku(admin, ["MUG"])).rejects.toThrow(/Throttled/);
  });
});

/* -------------------------------------------------------------------------- */
/* The tenant boundary                                                         */
/* -------------------------------------------------------------------------- */

describe("tenant boundary", () => {
  it("prices with the asking shop's rules, never another's", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    // Alpha discounts by 35%; Beta by 10%. Same buyer tag, same SKU.
    await inAlpha(() => createRule(wholesaleRule(35), { admin: fakeAdmin(), actor }));
    await shopScope.run(BETA, () =>
      createRule(wholesaleRule(10), { admin: fakeAdmin(), actor }),
    );
    await shopScope.run(BETA, () => seedBuyer());
    await inAlpha(() => seedBuyer());

    const admin = fakeAdmin([
      { id: "gid://shopify/ProductVariant/1", sku: "MUG", price: "10.00" },
    ]);

    const alphaPrice = await withProxy(
      signedRequest({ shop: ALPHA, logged_in_customer_id: "77" }),
      async (context) => priceList(admin, "MUG,1", await buyerFacts(context.customerId)),
    );
    const betaPrice = await withProxy(
      signedRequest({ shop: BETA, logged_in_customer_id: "77" }),
      async (context) => priceList(admin, "MUG,1", await buyerFacts(context.customerId)),
    );

    expect(alphaPrice.lines[0]?.unitPrice).toBe("$6.50");
    expect(betaPrice.lines[0]?.unitPrice).toBe("$9.00");
  });

  it("does not see a buyer who belongs to another shop", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    await inAlpha(() => seedBuyer());

    const facts = await shopScope.run(BETA, () =>
      buyerFacts("gid://shopify/Customer/77"),
    );

    // The same Shopify customer id, and Beta knows nothing about them — so
    // they are priced as a guest rather than at Alpha's tier.
    expect(facts).toEqual({
      customerId: "gid://shopify/Customer/77",
      tags: [],
      groupIds: [],
    });
  });
});
