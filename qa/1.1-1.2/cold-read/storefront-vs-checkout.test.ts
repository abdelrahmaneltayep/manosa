/**
 * Cold-read probe: does the price a buyer is SHOWN (quick order block, quote,
 * Buyer Agent — all of which go through `priceLine`) match the price the
 * checkout Function charges?
 *
 * Run: npx vitest run --config qa/1.1-1.2/cold-read/vitest.config.ts
 */
import { describe, expect, it } from "vitest";
import { parseMoney, serializeRuleset, type PricingRule } from "@mannon/pricing-engine";

import { priceLine } from "~/lib/quotes/pricing.server";
import { cartLinesDiscountsGenerateRun } from "../../../extensions/mannon-discount/src/cart_lines_discounts_generate_run";
import type { CartLine, FunctionInput } from "../../../extensions/mannon-discount/src/api";

const SALE = "gid://shopify/Collection/sale";

/** "20% off everything except the Sale collection" — a rule any merchant writes. */
const exceptSale: PricingRule = {
  id: "not-sale",
  name: "Wholesale 20% (not sale items)",
  status: "active",
  priority: 100,
  combinable: false,
  kind: "percentage",
  value: { percentage: 20 },
  targets: { mode: "all", excludeCollectionIds: [SALE] },
  audience: { mode: "tags", tags: ["wholesale"] },
  markets: { mode: "all", marketIds: [] },
  schedule: { startsAt: null, endsAt: null },
  createdAt: new Date("2026-01-01T00:00:00Z"),
} as PricingRule;

const functionInput = (collections: string[]): FunctionInput => ({
  cart: {
    cost: { subtotalAmount: { amount: "10.00", currencyCode: "USD" } },
    buyerIdentity: {
      customer: {
        id: "gid://shopify/Customer/1",
        buyer: { jsonValue: { tags: ["wholesale"], groupIds: [] } },
      },
    },
    lines: [
      {
        id: "gid://shopify/CartLine/1",
        quantity: 1,
        cost: { amountPerQuantity: { amount: "10.00", currencyCode: "USD" } },
        merchandise: {
          __typename: "ProductVariant",
          id: "gid://shopify/ProductVariant/1",
          product: {
            id: "gid://shopify/Product/1",
            collections: { jsonValue: collections },
          },
        },
      } as CartLine,
    ],
  },
  discount: {
    discountClasses: ["PRODUCT"],
    ruleset: { jsonValue: serializeRuleset([exceptSale]) },
  },
  localization: { country: { isoCode: "US" } },
});

describe("a sale item, for a wholesale buyer", () => {
  it("is shown and charged the same price", () => {
    // What the quick-order block / quote / Buyer Agent shows:
    const shown = priceLine(
      {
        variantId: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        title: "Sale mug",
        sku: "MUG-SALE",
        quantity: 1,
        listPrice: parseMoney("10.00", "USD"),
        // FIXED: `priceLine` hardcoded `collectionIds: []`. Every caller now
        // reads the same `$app:mannon.collections` metafield the Function
        // reads, and the field is required so none of them can forget.
        collectionIds: [SALE],
      },
      { customerId: "gid://shopify/Customer/1", tags: ["wholesale"], groupIds: [] },
      [exceptSale],
      { now: new Date("2026-06-15T12:00:00Z"), currencyCode: "USD" },
    );

    // What checkout charges (the product IS in the Sale collection):
    const result = cartLinesDiscountsGenerateRun(functionInput([SALE]));
    const off = Number(
      result.operations[0]?.productDiscountsAdd.candidates[0]?.value.fixedAmount.amount ??
        "0",
    );
    const charged = 1000 - Math.round(off * 100);

    expect({ shown: shown.unitPrice.amount, charged }).toEqual({
      shown: charged,
      charged,
    });
  });
});

describe("a product whose $app:mannon.collections metafield was never written", () => {
  /**
   * This one cannot be fixed inside the Function, and that is the finding.
   *
   * The Function's input query is fixed at deploy time, so it genuinely cannot
   * know what is in a collection — an unwritten metafield reads exactly like
   * "in no collections". The fix is upstream: `products.backfill` publishes
   * every existing product at install, and the Pricing page says so while it
   * runs. `tests/integration/products-backfill.test.ts` is where that is
   * proved; this stays as the record of why the job exists.
   */
  it("is still excluded from a rule that excludes its collection", () => {
    // Nothing backfilled this metafield before `products.backfill` existed:
    // only products/update and collections/update wrote it. Every product in
    // an existing catalogue therefore arrived at checkout with no collection
    // membership at all.
    const result = cartLinesDiscountsGenerateRun(functionInput([]));
    const missingMetafield: FunctionInput = {
      ...functionInput([]),
      cart: {
        ...functionInput([]).cart,
        lines: [
          {
            id: "gid://shopify/CartLine/1",
            quantity: 1,
            cost: { amountPerQuantity: { amount: "10.00", currencyCode: "USD" } },
            merchandise: {
              __typename: "ProductVariant",
              id: "gid://shopify/ProductVariant/1",
              product: { id: "gid://shopify/Product/1", collections: null },
            },
          } as CartLine,
        ],
      },
    };
    void result;
    const candidates =
      cartLinesDiscountsGenerateRun(missingMetafield).operations[0]?.productDiscountsAdd
        .candidates ?? [];
    // The item IS in Sale; the merchant excluded Sale. Checkout cannot know —
    // so something has to have told it, which is what the backfill does.
    expect(candidates).not.toEqual([]);
  });
});
