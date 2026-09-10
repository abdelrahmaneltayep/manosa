import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { FeatureLockedError } from "~/lib/billing/gate.server";
import { backfillOrders } from "~/lib/jobs/handlers/backfill-orders.server";
import {
  deleteLimit,
  LimitValidationError,
  listLimits,
  publishLimits,
  saveLimit,
  type LimitInput,
} from "~/lib/orders/limits.server";
import { listOrders, paymentState, daysUntilDue } from "~/lib/orders/orders.server";
import { factsFromWebhook, upsertOrder, markNeedsResync } from "~/lib/orders/sync.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { handleOrdersCancelled } from "~/lib/webhooks/handlers/orders-cancelled.server";
import { handleOrdersEdited } from "~/lib/webhooks/handlers/orders-edited.server";
import { handleOrdersUpsert } from "~/lib/webhooks/handlers/orders-upsert.server";
import { resetDatabase } from "../support/db";

/**
 * The order mirror, the limits, and the boundary between two shops.
 *
 * Everything here runs against a real database inside a real tenant scope, so a
 * query that forgot its shop fails rather than passing quietly.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const NOW = new Date("2026-09-10T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const daysAhead = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

const actor = { type: "STAFF" as const, id: "staff-1" };

interface AdminCall {
  query: string;
  variables: Record<string, unknown>;
}

function fakeAdmin(
  pages: { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null }[] = [],
) {
  const calls: AdminCall[] = [];
  let pageIndex = 0;

  const admin: AdminGraphql & { calls: AdminCall[] } = {
    calls,
    graphql: vi.fn(
      async (query: string, options?: { variables?: Record<string, unknown> }) => {
        calls.push({ query, variables: options?.variables ?? {} });

        if (query.includes("MannonOrdersPage")) {
          const page = pages[pageIndex++] ?? {
            nodes: [],
            hasNextPage: false,
            endCursor: null,
          };
          return {
            json: async () => ({
              data: {
                orders: {
                  nodes: page.nodes,
                  pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
                },
              },
            }),
          };
        }

        const data = query.includes("MannonShopId")
          ? { shop: { id: "gid://shopify/Shop/42" } }
          : query.includes("MannonOrderTagsAdd")
            ? { tagsAdd: { userErrors: [] } }
            : { metafieldsSet: { metafields: [{ id: "gid://mf/1" }], userErrors: [] } };

        return { json: async () => ({ data }) };
      },
    ),
  };

  return admin;
}

const queried = (admin: { calls: AdminCall[] }, name: string) =>
  admin.calls.filter((call) => call.query.includes(name));

async function installShop(shop: string, planKey = "pro") {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        planKey,
        billingStatus: "ACTIVE",
        currencyCode: "USD",
        ordersBackfilledAt: NOW,
      },
    }),
  );
}

const webhookOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 5001,
  admin_graphql_api_id: "gid://shopify/Order/5001",
  name: "#1001",
  email: "buyer@acme.test",
  currency: "USD",
  financial_status: "paid",
  source_name: "web",
  tags: "",
  current_total_price: "1200.50",
  current_subtotal_price: "1150.00",
  processed_at: daysAgo(2).toISOString(),
  updated_at: daysAgo(1).toISOString(),
  customer: { id: 77, default_address: { company: "Acme Ltd" } },
  line_items: [{ quantity: 12 }],
  ...overrides,
});

const seedBuyer = (tags: string[] = ["wholesale"]) =>
  db.customer.create({
    data: {
      ...tenant(),
      customerId: "gid://shopify/Customer/77",
      email: "buyer@acme.test",
      company: "Acme Ltd",
      tags,
      currencyCode: "USD",
    },
  });

const seedOrder = (overrides: Record<string, unknown> = {}) =>
  db.order.create({
    data: {
      ...tenant(),
      orderId: `gid://shopify/Order/${Math.random().toString(36).slice(2)}`,
      name: "#1001",
      customerId: "gid://shopify/Customer/77",
      company: "Acme Ltd",
      financialStatus: "paid",
      totalPrice: 120050,
      subtotalPrice: 115000,
      currencyCode: "USD",
      totalQuantity: 12,
      isWholesale: true,
      processedAt: daysAgo(2),
      ...overrides,
    },
  });

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */
/* The mirror                                                                  */
/* -------------------------------------------------------------------------- */

describe("orders/create", () => {
  it("mirrors a wholesale buyer's order and tags it in Shopify", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await seedBuyer();
      await handleOrdersUpsert(
        {
          shop: ALPHA,
          topic: "orders/create",
          webhookId: "w1",
          payload: webhookOrder(),
        },
        async () => admin,
      );

      const order = await db.order.findFirstOrThrow();
      expect(order.name).toBe("#1001");
      expect(order.isWholesale).toBe(true);
      expect(order.totalPrice).toBe(120050);
    });

    const tagged = queried(admin, "MannonOrderTagsAdd");
    expect(tagged).toHaveLength(1);
    expect(tagged[0]?.variables.tags).toEqual(["wholesale"]);
  });

  it("mirrors a retail order but does not tag it", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      // No mirrored buyer at all: an ordinary shopper.
      await handleOrdersUpsert(
        {
          shop: ALPHA,
          topic: "orders/create",
          webhookId: "w1",
          payload: webhookOrder(),
        },
        async () => admin,
      );

      const order = await db.order.findFirstOrThrow();
      expect(order.isWholesale).toBe(false);
    });

    expect(queried(admin, "MannonOrderTagsAdd")).toHaveLength(0);
  });

  it("is idempotent — the same delivery twice is one row", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();
    const ctx = {
      shop: ALPHA,
      topic: "orders/create",
      webhookId: "w1",
      payload: webhookOrder(),
    };

    await inAlpha(async () => {
      await seedBuyer();
      await handleOrdersUpsert(ctx, async () => admin);
      await handleOrdersUpsert(ctx, async () => admin);
      expect(await db.order.count()).toBe(1);
    });

    // And the tag is written once, not on every redelivery.
    expect(queried(admin, "MannonOrderTagsAdd")).toHaveLength(1);
  });

  it("keeps the order when tagging Shopify fails", async () => {
    await installShop(ALPHA);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await inAlpha(async () => {
      await seedBuyer();
      await handleOrdersUpsert(
        {
          shop: ALPHA,
          topic: "orders/create",
          webhookId: "w1",
          payload: webhookOrder(),
        },
        async () => {
          throw new Error("Shopify said no");
        },
      );

      // Shopify would otherwise redeliver this order for two days over a label.
      expect(await db.order.count()).toBe(1);
    });

    expect(warn).toHaveBeenCalled();
  });

  it("does nothing but warn when the payload has no order id", async () => {
    await installShop(ALPHA);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await inAlpha(async () => {
      await handleOrdersUpsert(
        { shop: ALPHA, topic: "orders/create", webhookId: "w1", payload: {} },
        async () => fakeAdmin(),
      );
      expect(await db.order.count()).toBe(0);
    });

    expect(warn).toHaveBeenCalled();
  });
});

describe("orders/updated", () => {
  it("reflects a refund on the existing row", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await seedBuyer();
      await handleOrdersUpsert(
        {
          shop: ALPHA,
          topic: "orders/create",
          webhookId: "w1",
          payload: webhookOrder(),
        },
        async () => admin,
      );

      await handleOrdersUpsert(
        {
          shop: ALPHA,
          topic: "orders/updated",
          webhookId: "w2",
          payload: webhookOrder({
            financial_status: "partially_refunded",
            current_total_price: "1160.50",
            refunds: [{ transactions: [{ amount: "40.00", kind: "refund" }] }],
          }),
        },
        async () => admin,
      );

      const order = await db.order.findFirstOrThrow();
      expect(order.financialStatus).toBe("partially_refunded");
      expect(order.refundedAmount).toBe(4000);
      expect(order.totalPrice).toBe(116050);
    });
  });

  it("does not turn an old retail order wholesale when the buyer is approved later", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      // Ordered as a retail shopper...
      await handleOrdersUpsert(
        {
          shop: ALPHA,
          topic: "orders/create",
          webhookId: "w1",
          payload: webhookOrder(),
        },
        async () => admin,
      );

      // ...and approved for wholesale afterwards.
      await seedBuyer();

      await handleOrdersUpsert(
        {
          shop: ALPHA,
          topic: "orders/updated",
          webhookId: "w2",
          payload: webhookOrder({ financial_status: "refunded" }),
        },
        async () => admin,
      );

      const order = await db.order.findFirstOrThrow();
      // Rewriting this would silently change last month's revenue figure.
      expect(order.isWholesale).toBe(false);
    });
  });
});

describe("orders/cancelled", () => {
  it("records the cancellation and keeps the row", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await handleOrdersUpsert(
        {
          shop: ALPHA,
          topic: "orders/create",
          webhookId: "w1",
          payload: webhookOrder(),
        },
        async () => fakeAdmin(),
      );

      await handleOrdersCancelled({
        shop: ALPHA,
        topic: "orders/cancelled",
        webhookId: "w2",
        payload: webhookOrder({ cancelled_at: daysAgo(1).toISOString() }),
      });

      const order = await db.order.findFirstOrThrow();
      expect(order.cancelledAt).not.toBeNull();
      expect(order.isWholesale).toBe(true);
    });
  });

  it("does not un-cancel an order that arrives without the date", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await handleOrdersCancelled({
        shop: ALPHA,
        topic: "orders/cancelled",
        webhookId: "w1",
        payload: webhookOrder({ cancelled_at: null }),
      });

      const order = await db.order.findFirstOrThrow();
      expect(order.cancelledAt).not.toBeNull();
    });
  });
});

describe("orders/edited", () => {
  it("flags the row instead of rewriting a total from a partial payload", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedOrder({ orderId: "gid://shopify/Order/5001" });
      await handleOrdersEdited({
        shop: ALPHA,
        topic: "orders/edited",
        webhookId: "w1",
        // The edit payload is a diff — no totals in it at all.
        payload: { order_edit: { order_id: 5001, line_items: { additions: [] } } },
      });

      const order = await db.order.findFirstOrThrow();
      expect(order.needsResync).toBe(true);
      // The total we had is still the total we show, and the badge says it is
      // out of date.
      expect(order.totalPrice).toBe(120050);
    });
  });

  it("is cleared by the full order that follows the edit", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await seedOrder({ orderId: "gid://shopify/Order/5001" });
      await handleOrdersEdited({
        shop: ALPHA,
        topic: "orders/edited",
        webhookId: "w1",
        payload: { order_edit: { order_id: 5001 } },
      });

      await handleOrdersUpsert(
        {
          shop: ALPHA,
          topic: "orders/updated",
          webhookId: "w2",
          payload: webhookOrder({ current_total_price: "900.00" }),
        },
        async () => fakeAdmin(),
      );

      const order = await db.order.findFirstOrThrow();
      expect(order.needsResync).toBe(false);
      expect(order.totalPrice).toBe(90000);
    });
  });

  it("does nothing but say so for an order it never mirrored", async () => {
    await installShop(ALPHA);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await inAlpha(async () => {
      await handleOrdersEdited({
        shop: ALPHA,
        topic: "orders/edited",
        webhookId: "w1",
        payload: { order_edit: { order_id: 999 } },
      });
      expect(await db.order.count()).toBe(0);
    });

    expect(info).toHaveBeenCalled();
  });

  it("warns rather than throwing when the payload has no order id", async () => {
    await installShop(ALPHA);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await inAlpha(async () => {
      await handleOrdersEdited({
        shop: ALPHA,
        topic: "orders/edited",
        webhookId: "w1",
        payload: {},
      });
    });

    expect(warn).toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* The backfill                                                                */
/* -------------------------------------------------------------------------- */

describe("backfillOrders", () => {
  const node = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: `#${id.slice(-4)}`,
    email: "buyer@acme.test",
    createdAt: daysAgo(5).toISOString(),
    processedAt: daysAgo(5).toISOString(),
    cancelledAt: null,
    updatedAt: daysAgo(5).toISOString(),
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    sourceName: "web",
    tags: [],
    currentSubtotalLineItemsQuantity: 10,
    customer: {
      id: "gid://shopify/Customer/77",
      defaultAddress: { company: "Acme Ltd" },
    },
    customAttributes: [],
    currentTotalPriceSet: { shopMoney: { amount: "500.00", currencyCode: "USD" } },
    currentSubtotalPriceSet: { shopMoney: { amount: "500.00", currencyCode: "USD" } },
    totalRefundedSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    ...overrides,
  });

  it("pages, and queues itself for the next page", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin([
      { nodes: [node("gid://shopify/Order/1")], hasNextPage: true, endCursor: "c1" },
    ]);

    await inAlpha(async () => {
      await seedBuyer();
      const result = await backfillOrders(async () => admin);

      expect(result).toMatchObject({ synced: 1, wholesale: 1, done: false });
      const shop = await db.shop.findFirstOrThrow();
      expect(shop.ordersBackfillCursor).toBe("c1");
      expect(await db.scheduledJob.count({ where: { kind: "orders.backfill" } })).toBe(1);
    });
  });

  it("does not tag historical orders in Shopify", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin([
      { nodes: [node("gid://shopify/Order/1")], hasNextPage: false, endCursor: null },
    ]);

    await inAlpha(async () => {
      await seedBuyer();
      await backfillOrders(async () => admin);
    });

    // Writing a tag onto hundreds of old orders on install is noise nobody
    // asked for.
    expect(queried(admin, "MannonOrderTagsAdd")).toHaveLength(0);
  });

  it("skips an uninstalled shop", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await db.shop.updateMany({ data: { uninstalledAt: NOW } });
      expect(await backfillOrders(async () => fakeAdmin())).toEqual({
        skipped: "uninstalled",
      });
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The list                                                                    */
/* -------------------------------------------------------------------------- */

describe("paymentState", () => {
  const order = (overrides: Record<string, unknown> = {}) =>
    ({
      cancelledAt: null,
      financialStatus: null,
      paidAt: null,
      netTermsDueAt: null,
      ...overrides,
    }) as Parameters<typeof paymentState>[0];

  it("reads Shopify's status first", () => {
    expect(paymentState(order({ financialStatus: "paid" }), NOW)).toBe("paid");
    expect(paymentState(order({ financialStatus: "refunded" }), NOW)).toBe("refunded");
    expect(paymentState(order({ financialStatus: "partially_refunded" }), NOW)).toBe(
      "partially_refunded",
    );
  });

  it("distinguishes terms not yet due from terms overdue", () => {
    expect(paymentState(order({ netTermsDueAt: daysAhead(5) }), NOW)).toBe("due");
    expect(paymentState(order({ netTermsDueAt: daysAgo(5) }), NOW)).toBe("overdue");
  });

  it("calls an order awaiting a card pending, not overdue", () => {
    expect(paymentState(order(), NOW)).toBe("pending");
  });

  it("puts a cancellation ahead of everything else", () => {
    expect(
      paymentState(order({ cancelledAt: daysAgo(1), financialStatus: "paid" }), NOW),
    ).toBe("cancelled");
  });

  it("counts the days to the due date", () => {
    expect(daysUntilDue(order({ netTermsDueAt: daysAhead(3) }), NOW)).toBe(3);
    expect(daysUntilDue(order({ netTermsDueAt: daysAgo(3) }), NOW)).toBe(-3);
    expect(daysUntilDue(order(), NOW)).toBeNull();
  });
});

describe("listOrders", () => {
  it("floats overdue rows to the top, oldest debt first", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedOrder({
        name: "#recent",
        orderId: "gid://shopify/Order/1",
        processedAt: daysAgo(1),
      });
      await seedOrder({
        name: "#overdue-30",
        orderId: "gid://shopify/Order/2",
        financialStatus: "pending",
        processedAt: daysAgo(40),
        netTermsDueAt: daysAgo(10),
      });
      await seedOrder({
        name: "#overdue-60",
        orderId: "gid://shopify/Order/3",
        financialStatus: "pending",
        processedAt: daysAgo(70),
        netTermsDueAt: daysAgo(40),
      });

      const page = await listOrders(
        { search: "", source: "", payment: "" },
        { now: NOW },
      );
      expect(page.rows.map((row) => row.name)).toEqual([
        "#overdue-60",
        "#overdue-30",
        "#recent",
      ]);
    });
  });

  it("shows only wholesale orders", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedOrder({ orderId: "gid://shopify/Order/1" });
      await seedOrder({ orderId: "gid://shopify/Order/2", isWholesale: false });

      const page = await listOrders(
        { search: "", source: "", payment: "" },
        { now: NOW },
      );
      expect(page.total).toBe(1);
      expect(page.totalUnfiltered).toBe(1);
    });
  });

  it("filters by source and by payment", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedOrder({ orderId: "gid://shopify/Order/1", source: "QUICK_ORDER" });
      await seedOrder({
        orderId: "gid://shopify/Order/2",
        source: "STOREFRONT",
        financialStatus: "pending",
        netTermsDueAt: daysAgo(3),
      });

      const quick = await listOrders(
        { search: "", source: "quick_order", payment: "" },
        { now: NOW },
      );
      expect(quick.total).toBe(1);
      expect(quick.rows[0]?.source).toBe("QUICK_ORDER");

      const overdue = await listOrders(
        { search: "", source: "", payment: "overdue" },
        { now: NOW },
      );
      expect(overdue.total).toBe(1);
      expect(overdue.rows[0]?.orderId).toBe("gid://shopify/Order/2");

      // A filter that matched nothing still knows the list is not empty.
      expect(overdue.totalUnfiltered).toBe(2);
    });
  });

  it("searches order number, email and company", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedOrder({ orderId: "gid://shopify/Order/1", company: "Café Aroma" });
      await seedOrder({ orderId: "gid://shopify/Order/2", company: "Acme Ltd" });

      const found = await listOrders(
        { search: "aroma", source: "", payment: "" },
        { now: NOW },
      );
      expect(found.total).toBe(1);
      expect(found.rows[0]?.company).toBe("Café Aroma");
    });
  });

  it("paginates across the overdue band and the rest", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      for (let index = 0; index < 3; index += 1) {
        await seedOrder({
          orderId: `gid://shopify/Order/od-${index}`,
          name: `#od-${index}`,
          financialStatus: "pending",
          netTermsDueAt: daysAgo(30 - index),
        });
      }
      for (let index = 0; index < 3; index += 1) {
        await seedOrder({
          orderId: `gid://shopify/Order/ok-${index}`,
          name: `#ok-${index}`,
          processedAt: daysAgo(index + 1),
        });
      }

      const first = await listOrders(
        { search: "", source: "", payment: "" },
        { page: 1, pageSize: 4, now: NOW },
      );
      const second = await listOrders(
        { search: "", source: "", payment: "" },
        { page: 2, pageSize: 4, now: NOW },
      );

      expect(first.rows).toHaveLength(4);
      expect(second.rows).toHaveLength(2);
      // No row appears on both pages.
      const names = [...first.rows, ...second.rows].map((row) => row.name);
      expect(new Set(names).size).toBe(6);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

const limitInput = (overrides: Partial<LimitInput> = {}): LimitInput => ({
  groupId: null,
  enabled: true,
  minSubtotal: 20000,
  maxSubtotal: null,
  minQuantity: null,
  maxQuantity: null,
  quantityIncrement: null,
  countries: [],
  ...overrides,
});

describe("saveLimit", () => {
  it("stores the limit and publishes it to Shopify", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await saveLimit(limitInput(), { admin, actor });

      const rows = await listLimits();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.minSubtotal).toBe(20000);

      const shop = await db.shop.findFirstOrThrow();
      expect(shop.limitsPublishedAt).not.toBeNull();
      // The metafield's owner is Shopify's shop GID, read from the API — our
      // own row id would write to nothing.
      expect(shop.shopGid).toBe("gid://shopify/Shop/42");
    });

    const published = queried(admin, "MannonSetLimits");
    expect(published).toHaveLength(1);
    const metafields = published[0]?.variables.metafields as { ownerId: string }[];
    expect(metafields?.[0]?.ownerId).toBe("gid://shopify/Shop/42");
  });

  it("does not republish an unchanged set", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await saveLimit(limitInput(), { admin, actor });
      await publishLimits(admin);
      expect(await publishLimits(admin)).toEqual({ published: false, limitCount: 1 });
    });

    expect(queried(admin, "MannonSetLimits")).toHaveLength(1);
  });

  it("refuses a minimum above the maximum, inline", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await expect(
        saveLimit(limitInput({ minSubtotal: 50000, maxSubtotal: 20000 }), {
          admin,
          actor,
        }),
      ).rejects.toBeInstanceOf(LimitValidationError);

      expect(await db.orderLimit.count()).toBe(0);
    });
  });

  it("upserts rather than adding a second limit for the same group", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const group = await db.customerGroup.create({
        data: { ...tenant(), name: "Silver", handle: "silver", tag: "silver" },
      });

      await saveLimit(limitInput({ groupId: group.id }), { admin, actor });
      await saveLimit(limitInput({ groupId: group.id, minSubtotal: 30000 }), {
        admin,
        actor,
      });

      const rows = await listLimits();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.minSubtotal).toBe(30000);
    });
  });

  it("is gated on the plan, server-side", async () => {
    await installShop(ALPHA, "free");
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await expect(saveLimit(limitInput(), { admin, actor })).rejects.toBeInstanceOf(
        FeatureLockedError,
      );
      expect(await db.orderLimit.count()).toBe(0);
    });
  });

  it("republishes when a limit is removed", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const saved = await saveLimit(limitInput(), { admin, actor });
      await deleteLimit(saved.id, { admin, actor });
      expect(await listLimits()).toHaveLength(0);
    });

    // Twice: once on save, once on delete. A store left holding a limit the
    // merchant deleted is the worst outcome here.
    expect(queried(admin, "MannonSetLimits")).toHaveLength(2);
  });

  it("404s on a limit that is not this shop's", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const admin = fakeAdmin();

    const saved = await inAlpha(() => saveLimit(limitInput(), { admin, actor }));

    await inBeta(async () => {
      await expect(deleteLimit(saved.id, { admin, actor })).rejects.toMatchObject({
        status: 404,
      });
    });

    // And it is still there.
    await inAlpha(async () => expect(await listLimits()).toHaveLength(1));
  });
});

describe("concurrent edits", () => {
  it("two saves for the same group land as one limit, not two that disagree", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const group = await db.customerGroup.create({
        data: { ...tenant(), name: "Silver", handle: "silver", tag: "silver" },
      });

      // Two staff on the same page, saving at the same moment. The unique
      // constraint on (shop, groupId) is what makes this safe — the read in
      // saveLimit is not.
      const results = await Promise.allSettled([
        saveLimit(limitInput({ groupId: group.id, minSubtotal: 20000 }), {
          admin,
          actor,
        }),
        saveLimit(limitInput({ groupId: group.id, minSubtotal: 30000 }), {
          admin,
          actor,
        }),
      ]);

      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      expect(await db.orderLimit.count({ where: { groupId: group.id } })).toBe(1);
    });
  });

  it("two orders webhooks for the same order land as one row", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();
    const ctx = (webhookId: string) => ({
      shop: ALPHA,
      topic: "orders/updated",
      webhookId,
      payload: webhookOrder(),
    });

    await inAlpha(async () => {
      await seedBuyer();
      const results = await Promise.allSettled([
        handleOrdersUpsert(ctx("w1"), async () => admin),
        handleOrdersUpsert(ctx("w2"), async () => admin),
      ]);

      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      expect(await db.order.count()).toBe(1);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The tenant boundary                                                         */
/* -------------------------------------------------------------------------- */

describe("tenant boundary", () => {
  it("never shows one shop's orders to another", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inAlpha(() => seedOrder({ orderId: "gid://shopify/Order/alpha" }));

    await inBeta(async () => {
      const page = await listOrders(
        { search: "", source: "", payment: "" },
        { now: NOW },
      );
      expect(page.rows).toHaveLength(0);
      expect(page.totalUnfiltered).toBe(0);
      // Looking it up by id directly fails closed too.
      expect(
        await db.order.findFirst({ where: { orderId: "gid://shopify/Order/alpha" } }),
      ).toBeNull();
    });
  });

  it("does not let one shop's webhook write into another's mirror", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    const facts = factsFromWebhook(webhookOrder())!;
    await inAlpha(() => upsertOrder(facts, true));

    await inBeta(async () => {
      expect(await db.order.count()).toBe(0);
    });
    await inAlpha(async () => {
      expect(await db.order.count()).toBe(1);
    });
  });

  it("does not let one shop resync another's order", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inAlpha(() => seedOrder({ orderId: "gid://shopify/Order/alpha" }));

    await inBeta(async () => {
      expect(await markNeedsResync("gid://shopify/Order/alpha", NOW)).toBe(0);
    });
    await inAlpha(async () => {
      const order = await db.order.findFirstOrThrow();
      expect(order.needsResync).toBe(false);
    });
  });
});
