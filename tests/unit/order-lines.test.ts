import { describe, expect, it } from "vitest";

import type { OrderLineNode } from "~/lib/orders/admin-graphql.server";
import {
  factsFromNode,
  factsFromWebhook,
  linesFromNode,
  linesFromWebhook,
  linesTruncated,
  UNNAMED_DISCOUNT,
  type OrderFacts,
} from "~/lib/orders/sync.server";

/**
 * Reading an order's lines, from both doors.
 *
 * The webhook and the GraphQL node describe the same line in different shapes,
 * and one of them is a trap: the payload carries a *per-unit* price and names
 * its discounts by index into an array that lives on the order, not the line.
 * A chart built on a misreading of either is a chart that is confidently wrong
 * about what a merchant earned.
 */

const node = (overrides: Partial<OrderLineNode> = {}): OrderLineNode => ({
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
  ...overrides,
});

/* -------------------------------------------------------------------------- */

describe("lines from a GraphQL node", () => {
  it("reads the money Shopify reported rather than computing any", () => {
    const [line] = linesFromNode([node()], "USD");

    expect(line?.unitPrice.amount).toBe(1000);
    expect(line?.originalTotal.amount).toBe(10_000);
    expect(line?.discountedTotal.amount).toBe(6_500);
    expect(line?.quantity).toBe(10);
  });

  it("keeps the rule name the buyer saw at checkout", () => {
    // The Function sets the winning rule's name as the discount message, and
    // this is the only place rule performance can be read from afterwards.
    const [line] = linesFromNode([node()], "USD");
    expect(line?.discounts).toEqual([
      { title: "Wholesale 35%", amount: { amount: 3_500, currencyCode: "USD" } },
    ]);
  });

  it("falls back to a discount code when there is no title", () => {
    const [line] = linesFromNode(
      [
        node({
          discountAllocations: [
            {
              allocatedAmountSet: { shopMoney: { amount: "5.00", currencyCode: "USD" } },
              discountApplication: { code: "TRADE10" },
            },
          ],
        }),
      ],
      "USD",
    );
    expect(line?.discounts[0]?.title).toBe("TRADE10");
  });

  it("names a discount Shopify named neither way, rather than losing the money", () => {
    const [line] = linesFromNode(
      [
        node({
          discountAllocations: [
            {
              allocatedAmountSet: { shopMoney: { amount: "5.00", currencyCode: "USD" } },
              discountApplication: null,
            },
          ],
        }),
      ],
      "USD",
    );

    // Dropping it would make the discounts on a line stop adding up to the
    // difference between its two totals, which is what every chart here uses.
    expect(line?.discounts[0]).toEqual({
      title: UNNAMED_DISCOUNT,
      amount: { amount: 500, currencyCode: "USD" },
    });
  });

  it("still names a line whose product Shopify has forgotten", () => {
    const [line] = linesFromNode(
      [node({ title: null, product: null, variant: null, sku: null })],
      "USD",
    );

    expect(line?.title).toBe("Untitled item");
    expect(line?.productId).toBeNull();
    // A product deleted in Shopify still sold, and a chart that forgets it
    // under-reports the past.
    expect(line?.discountedTotal.amount).toBe(6_500);
  });

  it("survives a line with no money on it at all", () => {
    const [line] = linesFromNode(
      [
        node({
          originalUnitPriceSet: null,
          originalTotalSet: null,
          discountedTotalSet: null,
          discountAllocations: null,
          quantity: null,
        }),
      ],
      "USD",
    );

    expect(line?.unitPrice.amount).toBe(0);
    expect(line?.quantity).toBe(0);
    expect(line?.discounts).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

const payload = (overrides: Record<string, unknown> = {}) => ({
  admin_graphql_api_id: "gid://shopify/Order/5001",
  name: "#1001",
  currency: "USD",
  processed_at: "2026-09-01T10:00:00Z",
  current_total_price: "65.00",
  current_subtotal_price: "65.00",
  discount_applications: [{ title: "Wholesale 35%" }, { code: "FREESHIP" }],
  line_items: [
    {
      admin_graphql_api_id: "gid://shopify/LineItem/1",
      title: "Blue Mug",
      variant_title: "Large",
      sku: "MUG-BL-L",
      product_id: 1,
      variant_id: 11,
      quantity: 10,
      price: "10.00",
      discount_allocations: [{ amount: "35.00", discount_application_index: 0 }],
    },
  ],
  ...overrides,
});

describe("lines from a webhook payload", () => {
  it("multiplies the per-unit price, because the payload has no line total", () => {
    const [line] = linesFromWebhook(payload(), "USD");

    expect(line?.unitPrice.amount).toBe(1000);
    expect(line?.originalTotal.amount).toBe(10_000);
    expect(line?.discountedTotal.amount).toBe(6_500);
  });

  it("resolves a discount name through the order-level index", () => {
    const [line] = linesFromWebhook(payload(), "USD");
    expect(line?.discounts[0]?.title).toBe("Wholesale 35%");
  });

  it("reads the second application when the index points at it", () => {
    const [line] = linesFromWebhook(
      payload({
        line_items: [
          {
            admin_graphql_api_id: "gid://shopify/LineItem/1",
            quantity: 1,
            price: "10.00",
            discount_allocations: [{ amount: "2.00", discount_application_index: 1 }],
          },
        ],
      }),
      "USD",
    );
    expect(line?.discounts[0]?.title).toBe("FREESHIP");
  });

  it("does not lose a discount whose index points nowhere", () => {
    const [line] = linesFromWebhook(
      payload({
        discount_applications: [],
        line_items: [
          {
            admin_graphql_api_id: "gid://shopify/LineItem/1",
            quantity: 1,
            price: "10.00",
            discount_allocations: [{ amount: "2.00", discount_application_index: 7 }],
          },
        ],
      }),
      "USD",
    );

    expect(line?.discounts[0]?.title).toBe(UNNAMED_DISCOUNT);
    expect(line?.discountedTotal.amount).toBe(800);
  });

  it("never reports a line as negative revenue", () => {
    // A payload whose allocations exceed the line is one we have misread. A
    // negative line total would appear on a chart as money going backwards.
    const [line] = linesFromWebhook(
      payload({
        line_items: [
          {
            admin_graphql_api_id: "gid://shopify/LineItem/1",
            quantity: 1,
            price: "10.00",
            discount_allocations: [{ amount: "99.00", discount_application_index: 0 }],
          },
        ],
      }),
      "USD",
    );

    expect(line?.discountedTotal.amount).toBe(0);
  });

  it("builds the GID for a payload that only carries a numeric id", () => {
    const [line] = linesFromWebhook(
      payload({
        line_items: [
          { id: 42, quantity: 1, price: "1.00", product_id: 7, variant_id: 9 },
        ],
      }),
      "USD",
    );

    expect(line?.lineItemId).toBe("gid://shopify/LineItem/42");
    expect(line?.productId).toBe("gid://shopify/Product/7");
    expect(line?.variantId).toBe("gid://shopify/ProductVariant/9");
  });

  it("drops a line with no id at all, rather than mirroring it twice", () => {
    const facts = factsFromWebhook(
      payload({ line_items: [{ quantity: 1, price: "1.00" }] }),
    )!;
    expect(facts.lines).toEqual([]);
  });

  it("reads the same line the same way as the GraphQL node does", () => {
    const fromHook = factsFromWebhook(payload())!.lines[0]!;
    const fromNode = linesFromNode([node()], "USD")[0]!;

    expect(fromHook.lineItemId).toBe(fromNode.lineItemId);
    expect(fromHook.quantity).toBe(fromNode.quantity);
    expect(fromHook.unitPrice).toEqual(fromNode.unitPrice);
    expect(fromHook.originalTotal).toEqual(fromNode.originalTotal);
    expect(fromHook.discountedTotal).toEqual(fromNode.discountedTotal);
    expect(fromHook.discounts).toEqual(fromNode.discounts);
  });
});

/* -------------------------------------------------------------------------- */

describe("knowing when the lines are incomplete", () => {
  const facts = (overrides: Partial<OrderFacts>): OrderFacts =>
    ({
      ...factsFromNode({
        id: "gid://shopify/Order/1",
        name: "#1",
        email: null,
        createdAt: null,
        processedAt: null,
        cancelledAt: null,
        updatedAt: null,
        displayFinancialStatus: null,
        displayFulfillmentStatus: null,
        sourceName: null,
        tags: null,
        currentSubtotalLineItemsQuantity: 10,
        customer: null,
        customAttributes: null,
        currentTotalPriceSet: null,
        currentSubtotalPriceSet: null,
        totalRefundedSet: null,
        lineItems: { nodes: [node()] },
      }),
      ...overrides,
    }) as OrderFacts;

  it("is content when the quantities add up", () => {
    expect(linesTruncated(facts({}))).toBe(false);
  });

  it("knows an order whose lines were capped", () => {
    // The merchant's biggest orders have the most lines, so silent truncation
    // would under-report exactly the ones that matter most.
    expect(linesTruncated(facts({ totalQuantity: 400 }))).toBe(true);
  });

  it("knows an order that arrived with no lines but sold something", () => {
    expect(linesTruncated(facts({ lines: [] }))).toBe(true);
    expect(linesTruncated(facts({ lines: [], totalQuantity: 0 }))).toBe(false);
  });
});
