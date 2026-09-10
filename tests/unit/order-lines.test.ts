import { describe, expect, it } from "vitest";

import type { OrderLineNode } from "~/lib/orders/admin-graphql.server";
import {
  currentTotalOf,
  factsFromNode,
  factsFromWebhook,
  linesFromNode,
  linesFromWebhook,
  UNNAMED_DISCOUNT,
  WEBHOOK_LINE_CAP,
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
  quantity: 7,
  currentQuantity: 7,
  product: { id: "gid://shopify/Product/1" },
  variant: { id: "gid://shopify/ProductVariant/1" },
  // Deliberately not a round number times a round quantity. The first version
  // of the "both doors agree" test used 10.00 × 10, which is the one shape
  // where a multiplying reader and a reading one cannot possibly disagree.
  originalUnitPriceSet: { shopMoney: { amount: "3.33", currencyCode: "USD" } },
  originalTotalSet: { shopMoney: { amount: "23.31", currencyCode: "USD" } },
  discountedTotalSet: { shopMoney: { amount: "15.16", currencyCode: "USD" } },
  discountAllocations: [
    {
      allocatedAmountSet: { shopMoney: { amount: "8.15", currencyCode: "USD" } },
      discountApplication: { title: "Wholesale 35%" },
    },
  ],
  ...overrides,
});

/* -------------------------------------------------------------------------- */

describe("lines from a GraphQL node", () => {
  it("reads the money Shopify reported rather than computing any", () => {
    const [line] = linesFromNode([node()], "USD");

    expect(line?.unitPrice.amount).toBe(333);
    expect(line?.originalTotal.amount).toBe(2_331);
    expect(line?.discountedTotal.amount).toBe(1_516);
    expect(line?.quantity).toBe(7);
  });

  it("keeps what is left of a line after a return", () => {
    // Shopify's `quantity` is *before* returns and removals. A five-unit line
    // refunded in full stayed five units of revenue on every product and rule
    // chart, while the parent order row — written from the `current_*` fields
    // — said the money had gone back.
    const [line] = linesFromNode([node({ quantity: 10, currentQuantity: 4 })], "USD");

    expect(line?.quantity).toBe(10);
    expect(line?.currentQuantity).toBe(4);
    // 15.16 apportioned to four tenths, rounded down.
    expect(line?.currentTotal.amount).toBe(606);
  });

  it("reads a line with no current quantity as unreturned", () => {
    const [line] = linesFromNode([node({ currentQuantity: null })], "USD");

    expect(line?.currentQuantity).toBe(7);
    expect(line?.currentTotal).toEqual(line?.discountedTotal);
  });

  it("keeps the rule name the buyer saw at checkout", () => {
    // The Function sets the winning rule's name as the discount message, and
    // this is the only place rule performance can be read from afterwards.
    const [line] = linesFromNode([node()], "USD");
    expect(line?.discounts).toEqual([
      { title: "Wholesale 35%", amount: { amount: 815, currencyCode: "USD" } },
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
    expect(line?.discountedTotal.amount).toBe(1_516);
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
      quantity: 7,
      current_quantity: 7,
      price: "3.33",
      discount_allocations: [{ amount: "8.15", discount_application_index: 0 }],
    },
  ],
  ...overrides,
});

describe("lines from a webhook payload", () => {
  it("multiplies the per-unit price, because the payload has no line total", () => {
    const [line] = linesFromWebhook(payload(), "USD");

    expect(line?.unitPrice.amount).toBe(333);
    expect(line?.originalTotal.amount).toBe(2_331);
    expect(line?.discountedTotal.amount).toBe(1_516);
  });

  it("keeps what is left after a return", () => {
    const [line] = linesFromWebhook(
      payload({
        line_items: [
          {
            admin_graphql_api_id: "gid://shopify/LineItem/1",
            quantity: 10,
            current_quantity: 4,
            price: "1.00",
          },
        ],
      }),
      "USD",
    );

    expect(line?.currentQuantity).toBe(4);
    expect(line?.currentTotal.amount).toBe(400);
  });

  it("keeps a discount that arrived with no allocation entry", () => {
    // A draft order's discount — which is how an accepted quote arrives —
    // lands in `total_discount` with nothing in `discount_allocations`. The
    // line mirrored at full price, so a quote's own discount showed as revenue
    // the merchant never took.
    const [line] = linesFromWebhook(
      payload({
        discount_applications: [],
        line_items: [
          {
            admin_graphql_api_id: "gid://shopify/LineItem/1",
            quantity: 10,
            price: "10.00",
            total_discount: "25.00",
          },
        ],
      }),
      "USD",
    );

    expect(line?.discounts).toEqual([
      { title: UNNAMED_DISCOUNT, amount: { amount: 2_500, currencyCode: "USD" } },
    ]);
    expect(line?.discountedTotal.amount).toBe(7_500);
  });

  it("resolves a discount name through the order-level index", () => {
    const [line] = linesFromWebhook(payload(), "USD");
    expect(line?.discounts[0]?.title).toBe("Wholesale 35%");
  });

  it("reads a zero-decimal currency Shopify wrote with decimals", () => {
    // Shopify sends "5000.00" for JPY. The strict parser rejects that, and the
    // caller used to swallow the error and record zero — a ¥5,000 line
    // mirrored as ¥0, on every chart, with nothing to explain it.
    const [line] = linesFromWebhook(
      payload({
        currency: "JPY",
        line_items: [
          {
            admin_graphql_api_id: "gid://shopify/LineItem/1",
            quantity: 1,
            price: "5000.00",
          },
        ],
      }),
      "JPY",
    );

    expect(line?.unitPrice).toEqual({ amount: 5000, currencyCode: "JPY" });
    expect(line?.discountedTotal.amount).toBe(5000);
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
    expect(line?.currentTotal.amount).toBe(0);
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
    expect(fromHook.currentQuantity).toBe(fromNode.currentQuantity);
    expect(fromHook.unitPrice).toEqual(fromNode.unitPrice);
    expect(fromHook.originalTotal).toEqual(fromNode.originalTotal);
    expect(fromHook.discountedTotal).toEqual(fromNode.discountedTotal);
    expect(fromHook.currentTotal).toEqual(fromNode.currentTotal);
    expect(fromHook.discounts).toEqual(fromNode.discounts);
  });
});

/* -------------------------------------------------------------------------- */

describe("knowing when the lines are incomplete", () => {
  it("takes Shopify's own word for it through the GraphQL door", () => {
    const withPage = (hasNextPage: boolean) =>
      factsFromNode({
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
        currentSubtotalLineItemsQuantity: 7,
        customer: null,
        customAttributes: null,
        currentTotalPriceSet: null,
        currentSubtotalPriceSet: null,
        totalRefundedSet: null,
        lineItems: { pageInfo: { hasNextPage }, nodes: [node()] },
      }).linesTruncated;

    // The version this replaced compared summed quantities against the
    // order's own — which is post-refund while the lines' is not, so it was
    // wrong here and *structurally impossible* through the webhook door,
    // where both sides came from the same array.
    expect(withPage(true)).toBe(true);
    expect(withPage(false)).toBe(false);
  });

  it("treats a webhook at the line cap as unknown, not as complete", () => {
    const line = (id: number) => ({
      admin_graphql_api_id: `gid://shopify/LineItem/${id}`,
      quantity: 1,
      price: "1.00",
    });

    const capped = factsFromWebhook({
      admin_graphql_api_id: "gid://shopify/Order/1",
      currency: "USD",
      line_items: Array.from({ length: WEBHOOK_LINE_CAP }, (_, index) => line(index)),
    })!;
    const short = factsFromWebhook({
      admin_graphql_api_id: "gid://shopify/Order/1",
      currency: "USD",
      line_items: [line(1), line(2)],
    })!;

    // A payload sitting exactly on the cap may or may not be the whole order,
    // and reading it as complete let a webhook clear a flag the backfill had
    // set correctly on a 150-line order.
    expect(capped.linesTruncated).toBe(true);
    expect(short.linesTruncated).toBe(false);
  });
});

describe("what is left of a line", () => {
  const usd = (amount: number) => ({ amount, currencyCode: "USD" });

  it("is all of it when nothing was returned", () => {
    expect(currentTotalOf(usd(1_000), 10, 10)).toEqual(usd(1_000));
  });

  it("is none of it when the whole line went back", () => {
    expect(currentTotalOf(usd(1_000), 10, 0)).toEqual(usd(0));
  });

  it("apportions a partial return, and never rounds up", () => {
    // 1000 × 3 / 7 is 428.57…; rounding up would let the apportioned totals of
    // an order exceed the money the merchant actually kept.
    expect(currentTotalOf(usd(1_000), 7, 3)).toEqual(usd(428));
  });

  it("cannot exceed the line it came from", () => {
    // A payload claiming more units remain than were ordered is one we have
    // misread, and inflating revenue is the wrong way to be wrong.
    expect(currentTotalOf(usd(1_000), 5, 99)).toEqual(usd(1_000));
    expect(currentTotalOf(usd(1_000), 0, 5)).toEqual(usd(0));
  });
});
