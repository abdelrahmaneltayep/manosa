import { describe, expect, it } from "vitest";

import {
  classifySource,
  factsFromNode,
  factsFromWebhook,
  orderIdFromPayload,
  SOURCE_ATTRIBUTE,
} from "~/lib/orders/sync.server";
import type { OrderNode } from "~/lib/orders/admin-graphql.server";

/**
 * Narrowing Shopify's two shapes into one.
 *
 * The webhook payload and the GraphQL node disagree on almost every field name,
 * and the mirror is only as good as this. A total read as zero because a field
 * moved is a wholesale list showing a merchant the wrong revenue.
 */

const webhook = (overrides: Record<string, unknown> = {}) => ({
  id: 5001,
  name: "#1001",
  email: "buyer@acme.test",
  currency: "USD",
  financial_status: "paid",
  fulfillment_status: null,
  source_name: "web",
  tags: "wholesale, rush",
  current_total_price: "1200.50",
  current_subtotal_price: "1150.00",
  processed_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-02T10:00:00Z",
  customer: { id: 77, default_address: { company: "Acme Ltd" } },
  line_items: [{ quantity: 12 }, { quantity: 3 }],
  ...overrides,
});

describe("order ids", () => {
  it("prefers the GID Shopify already sent", () => {
    expect(
      orderIdFromPayload({ id: 5001, admin_graphql_api_id: "gid://shopify/Order/5001" }),
    ).toBe("gid://shopify/Order/5001");
  });

  it("builds one from the numeric id when there is no GID", () => {
    expect(orderIdFromPayload({ id: 5001 })).toBe("gid://shopify/Order/5001");
  });

  it("returns null rather than inventing an id", () => {
    expect(orderIdFromPayload({})).toBeNull();
    expect(factsFromWebhook({})).toBeNull();
  });
});

describe("classifySource", () => {
  it("reads Mannon's own note attribute first", () => {
    // Shopify reports every app extension's cart as the storefront, so this is
    // the only signal that tells a quick order from a normal one.
    expect(classifySource("web", "quick_order")).toBe("QUICK_ORDER");
    expect(classifySource("web", "buyer_agent")).toBe("BUYER_AGENT");
  });

  it("falls back to Shopify's source name", () => {
    expect(classifySource("web", null)).toBe("STOREFRONT");
    expect(classifySource("pos", null)).toBe("POS");
    expect(classifySource("shopify_draft_order", null)).toBe("DRAFT");
  });

  it("calls an unrecognised source other, never a guess", () => {
    expect(classifySource("1234567", null)).toBe("OTHER");
    expect(classifySource("android", null)).toBe("OTHER");
  });

  it("treats a missing source as the storefront", () => {
    expect(classifySource(null, null)).toBe("STOREFRONT");
  });

  it("ignores an attribute it does not recognise", () => {
    expect(classifySource("pos", "something_else")).toBe("POS");
  });
});

describe("factsFromWebhook", () => {
  it("reads the whole order", () => {
    const facts = factsFromWebhook(webhook())!;

    expect(facts.orderId).toBe("gid://shopify/Order/5001");
    expect(facts.name).toBe("#1001");
    expect(facts.customerId).toBe("gid://shopify/Customer/77");
    expect(facts.company).toBe("Acme Ltd");
    expect(facts.total).toEqual({ amount: 120050, currencyCode: "USD" });
    expect(facts.subtotal).toEqual({ amount: 115000, currencyCode: "USD" });
    expect(facts.totalQuantity).toBe(15);
    expect(facts.source).toBe("STOREFRONT");
    expect(facts.tags).toEqual(["rush", "wholesale"]);
  });

  it("prefers the current total, which is the number after edits and refunds", () => {
    const facts = factsFromWebhook(
      webhook({ current_total_price: "900.00", total_price: "1200.50" }),
    )!;
    expect(facts.total.amount).toBe(90000);
  });

  it("sums refund transactions rather than assuming a field", () => {
    const facts = factsFromWebhook(
      webhook({
        refunds: [
          { transactions: [{ amount: "40.00", kind: "refund" }] },
          {
            transactions: [
              { amount: "10.00", kind: "refund" },
              // A capture is not a refund. Counting it would show the merchant
              // money back they never gave.
              { amount: "500.00", kind: "capture" },
            ],
          },
        ],
      }),
    )!;
    expect(facts.refunded.amount).toBe(5000);
  });

  it("keeps a total it cannot parse at zero rather than losing the order", () => {
    const facts = factsFromWebhook(webhook({ current_total_price: "not a number" }))!;
    expect(facts.total.amount).toBe(0);
    expect(facts.orderId).toBe("gid://shopify/Order/5001");
  });

  it("reads the source from a note attribute", () => {
    const facts = factsFromWebhook(
      webhook({ note_attributes: [{ name: SOURCE_ATTRIBUTE, value: "buyer_agent" }] }),
    )!;
    expect(facts.source).toBe("BUYER_AGENT");
    // The raw name is kept: our reading of it is an interpretation.
    expect(facts.sourceName).toBe("web");
  });

  it("never dates an order to now when Shopify sent no date", () => {
    const facts = factsFromWebhook(webhook({ processed_at: null, created_at: null }))!;
    expect(facts.processedAt.getTime()).toBe(0);
  });

  it("falls back to the shop currency when the payload has none", () => {
    const facts = factsFromWebhook(webhook({ currency: null }), "SAR")!;
    expect(facts.total.currencyCode).toBe("SAR");
  });

  it("handles a guest order with no customer", () => {
    const facts = factsFromWebhook(webhook({ customer: null }))!;
    expect(facts.customerId).toBeNull();
    expect(facts.company).toBeNull();
  });
});

describe("factsFromNode", () => {
  const node = (overrides: Partial<OrderNode> = {}): OrderNode => ({
    id: "gid://shopify/Order/5001",
    name: "#1001",
    email: "buyer@acme.test",
    createdAt: "2026-09-01T09:00:00Z",
    processedAt: "2026-09-01T10:00:00Z",
    cancelledAt: null,
    updatedAt: "2026-09-02T10:00:00Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    sourceName: "web",
    tags: ["Wholesale"],
    currentSubtotalLineItemsQuantity: 15,
    customer: {
      id: "gid://shopify/Customer/77",
      defaultAddress: { company: "Acme Ltd" },
    },
    customAttributes: [],
    currentTotalPriceSet: { shopMoney: { amount: "1200.50", currencyCode: "USD" } },
    currentSubtotalPriceSet: { shopMoney: { amount: "1150.00", currencyCode: "USD" } },
    totalRefundedSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Blue Mug",
          variantTitle: "Large",
          sku: "MUG-BL-L",
          quantity: 10,
          product: { id: "gid://shopify/Product/1" },
          variant: { id: "gid://shopify/ProductVariant/1" },
          originalUnitPriceSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } },
          originalTotalSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
          discountedTotalSet: { shopMoney: { amount: "65.00", currencyCode: "USD" } },
          discountAllocations: [
            {
              allocatedAmountSet: { shopMoney: { amount: "35.00", currencyCode: "USD" } },
              discountApplication: { title: "Wholesale 35%" },
            },
          ],
        },
      ],
    },
    ...overrides,
  });

  it("reads the same order to the same facts as the webhook does", () => {
    const fromNode = factsFromNode(node());
    const fromHook = factsFromWebhook(webhook())!;

    expect(fromNode.orderId).toBe(fromHook.orderId);
    expect(fromNode.total).toEqual(fromHook.total);
    expect(fromNode.totalQuantity).toBe(fromHook.totalQuantity);
    expect(fromNode.customerId).toBe(fromHook.customerId);
    expect(fromNode.source).toBe(fromHook.source);
  });

  it("lowercases Shopify's shouting statuses", () => {
    const facts = factsFromNode(node());
    expect(facts.financialStatus).toBe("paid");
    expect(facts.fulfillmentStatus).toBe("fulfilled");
  });

  it("reads the source from a custom attribute", () => {
    const facts = factsFromNode(
      node({ customAttributes: [{ key: SOURCE_ATTRIBUTE, value: "quick_order" }] }),
    );
    expect(facts.source).toBe("QUICK_ORDER");
  });

  it("survives an order with every optional field missing", () => {
    const facts = factsFromNode({
      id: "gid://shopify/Order/9",
      name: null,
      email: null,
      createdAt: null,
      processedAt: null,
      cancelledAt: null,
      updatedAt: null,
      displayFinancialStatus: null,
      displayFulfillmentStatus: null,
      lineItems: null,
      sourceName: null,
      tags: null,
      currentSubtotalLineItemsQuantity: null,
      customer: null,
      customAttributes: null,
      currentTotalPriceSet: null,
      currentSubtotalPriceSet: null,
      totalRefundedSet: null,
    });

    expect(facts.name).toBe("gid://shopify/Order/9");
    expect(facts.total).toEqual({ amount: 0, currencyCode: "USD" });
    expect(facts.totalQuantity).toBe(0);
    expect(facts.tags).toEqual([]);
  });
});
