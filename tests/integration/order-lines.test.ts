import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "~/db.server";
import type { OrderFacts } from "~/lib/orders/sync.server";
import { factsFromWebhook, upsertOrder } from "~/lib/orders/sync.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * Writing an order's lines into the mirror.
 *
 * The property that matters is that the mirror never *disagrees* with Shopify
 * in a direction that flatters the merchant: no ghost lines from an edit, no
 * duplicates from a redelivered webhook, and no other shop's rows.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const line = (id: number, overrides: Record<string, unknown> = {}) => ({
  admin_graphql_api_id: `gid://shopify/LineItem/${id}`,
  title: `Item ${id}`,
  sku: `SKU-${id}`,
  product_id: id,
  variant_id: id * 10,
  quantity: 10,
  price: "10.00",
  discount_allocations: [{ amount: "35.00", discount_application_index: 0 }],
  ...overrides,
});

const payload = (overrides: Record<string, unknown> = {}) => ({
  admin_graphql_api_id: "gid://shopify/Order/5001",
  name: "#1001",
  currency: "USD",
  processed_at: "2026-09-01T10:00:00Z",
  current_total_price: "130.00",
  discount_applications: [{ title: "Wholesale 35%" }],
  line_items: [line(1), line(2)],
  ...overrides,
});

const facts = (overrides: Record<string, unknown> = {}): OrderFacts =>
  factsFromWebhook(payload(overrides))!;

const installShop = (shop: string) =>
  shopScope.run(shop, () =>
    db.shop.create({ data: { ...tenant(), currencyCode: "USD" } }),
  );

beforeEach(resetDatabase);
afterAll(resetDatabase);

/* -------------------------------------------------------------------------- */

describe("mirroring an order's lines", () => {
  it("writes them alongside the order", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await upsertOrder(facts(), true);

      const lines = await db.orderLine.findMany({ orderBy: { sku: "asc" } });
      expect(lines).toHaveLength(2);
      expect(lines[0]?.sku).toBe("SKU-1");
      expect(lines[0]?.quantity).toBe(10);
      expect(lines[0]?.originalTotal).toBe(10_000);
      expect(lines[0]?.discountedTotal).toBe(6_500);
      expect(lines[0]?.discounts).toEqual([{ title: "Wholesale 35%", amount: 3_500 }]);
    });
  });

  it("is idempotent — a redelivered webhook does not duplicate a line", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await upsertOrder(facts(), true);
      await upsertOrder(facts(), true);

      // Webhooks are delivered at least once, so this is the ordinary case,
      // not the unlucky one.
      expect(await db.orderLine.count()).toBe(2);
      expect(await db.order.count()).toBe(1);
    });
  });

  it("leaves no ghost line when an order is edited down", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await upsertOrder(facts(), true);
      await upsertOrder(facts({ line_items: [line(1)] }), true);

      const lines = await db.orderLine.findMany();
      // A line removed in Shopify that survives here is revenue on a chart for
      // a product the merchant never sold.
      expect(lines).toHaveLength(1);
      expect(lines[0]?.sku).toBe("SKU-1");
    });
  });

  it("keeps the lines it has when a payload carries none", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await upsertOrder(facts(), true);
      // A fulfilment or cancellation webhook arrives without `line_items`;
      // reading that as "the order has no lines" would empty the table one
      // event at a time.
      await upsertOrder(facts({ line_items: [] }), true);

      expect(await db.orderLine.count()).toBe(2);
    });
  });

  it("flags an order whose lines did not all come through", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      // Shopify says 400 units; two lines of ten arrived.
      await upsertOrder({ ...facts(), totalQuantity: 400 }, true);

      const order = await db.order.findFirst();
      expect(order?.linesTruncated).toBe(true);
    });
  });

  it("does not flag a complete order, and a line-less payload cannot flag one", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await upsertOrder(facts(), true);
      expect((await db.order.findFirst())?.linesTruncated).toBe(false);

      // The trap: this payload has no lines and a non-zero quantity, which
      // read naively is "incomplete" — but it says nothing about the lines
      // already mirrored.
      await upsertOrder({ ...facts({ line_items: [] }), totalQuantity: 20 }, true);
      expect((await db.order.findFirst())?.linesTruncated).toBe(false);
    });
  });

  it("goes with the order when the order goes", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const order = await upsertOrder(facts(), true);
      await db.order.delete({ where: { id: order.id } });

      expect(await db.orderLine.count()).toBe(0);
    });
  });

  it("is another shop's business", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(async () => {
      await upsertOrder(facts(), true);
    });

    await inAlpha(async () => {
      expect(await db.orderLine.count()).toBe(0);
      await upsertOrder(facts({ line_items: [line(9)] }), true);

      const lines = await db.orderLine.findMany();
      expect(lines).toHaveLength(1);
      expect(lines[0]?.sku).toBe("SKU-9");
    });

    // Two shops, the same Shopify order id, and neither has touched the other.
    await inBeta(async () => {
      expect(await db.orderLine.count()).toBe(2);
    });
  });
});
