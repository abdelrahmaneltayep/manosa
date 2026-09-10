import { money, type PricingRule } from "@mannon/pricing-engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import type { PoLine } from "~/lib/ai/prompts/purchase-order.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { createRule } from "~/lib/pricing/rules.server";
import { matchPurchaseOrder, orderableLines } from "~/lib/orders/purchase-order.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * PO-to-order's matching and pricing, against a real database.
 *
 * This is the module that decides what goes on a merchant's draft order and at
 * what price, from a document a stranger emailed them. Two checklist rules are
 * asserted here rather than read off the screen: **totals are always recomputed
 * from Mannon rules**, and **unmatched lines are listed, never dropped**.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const NOW = new Date("2026-09-10T12:00:00Z");
const actor = { type: "STAFF" as const, id: "staff-1" };

const BUYER = {
  customerId: "gid://shopify/Customer/77",
  tags: ["wholesale"],
  groupIds: [] as string[],
};

const variant = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/ProductVariant/1",
  title: "Large",
  sku: "MUG-BL-L",
  price: "10.00",
  product: { id: "gid://shopify/Product/1", title: "Blue Mug" },
  ...overrides,
});

const poLine = (overrides: Partial<PoLine> = {}): PoLine => ({
  sku: "MUG-BL-L",
  description: "Blue mug, large",
  quantity: 200,
  statedPrice: null,
  ...overrides,
});

/**
 * A catalogue that answers every search with the same nodes — or fails.
 *
 * `failing` is the case that matters most: Shopify throttling looks exactly
 * like "nothing in your catalogue matched", and the two must not print the
 * same sentence.
 */
function fakeAdmin(nodes: unknown[], options: { failing?: boolean } = {}) {
  return {
    graphql: vi.fn(async (query: string) => {
      if (query.includes("MannonQuoteVariants")) {
        return {
          json: async () =>
            options.failing
              ? { errors: [{ message: "Throttled" }] }
              : { data: { productVariants: { nodes } } },
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
          data: { metafieldsSet: { metafields: [], userErrors: [] } },
        }),
      };
    }),
  } satisfies AdminGraphql;
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

async function installShop(shop: string) {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        planKey: "agentic",
        billingStatus: "ACTIVE",
        currencyCode: "USD",
      },
    }),
  );
}

const match = (admin: AdminGraphql, lines: PoLine[], chosen?: Record<string, string>) =>
  matchPurchaseOrder(admin, lines, {
    buyer: BUYER,
    currencyCode: "USD",
    now: NOW,
    chosen,
  });

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */

describe("matching a purchase order", () => {
  it("prices an exact SKU from the engine, not from the document", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await createRule(wholesaleRule(35), { admin: fakeAdmin([]), actor });

      const matched = await match(fakeAdmin([variant()]), [
        // The document says $4.00. The contract says $6.50. Neither the
        // merchant nor the buyer gets to decide that from a PDF.
        poLine({ statedPrice: "4.00" }),
      ]);

      const line = matched.lines[0]!;
      expect(line.confidence).toBe("exact");
      expect(line.unitPrice).toEqual(money(650, "USD"));
      // The number the merchant sees, and the one regression that would be
      // invisible on a one-unit line: total is unit × quantity.
      expect(line.lineTotal).toEqual(money(130_000, "USD"));
      expect(line.statedPrice).toEqual(money(400, "USD"));
      expect(line.priceDelta).toEqual(money(250, "USD"));
      expect(line.ruleSummary).toContain("Wholesale 35%");
      expect(matched.subtotal).toEqual(money(130_000, "USD"));
      expect(matched.needsAttention).toBe(0);
    });
  });

  it("charges list price when no rule reaches this buyer", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const matched = await match(fakeAdmin([variant()]), [poLine({ quantity: 3 })]);

      expect(matched.lines[0]?.unitPrice).toEqual(money(1000, "USD"));
      expect(matched.lines[0]?.lineTotal).toEqual(money(3000, "USD"));
      expect(matched.lines[0]?.ruleSummary).toBeNull();
    });
  });

  it("never prices with another shop's rules", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    await inBeta(() => createRule(wholesaleRule(90), { admin: fakeAdmin([]), actor }));

    await inAlpha(async () => {
      const matched = await match(fakeAdmin([variant()]), [poLine({ quantity: 1 })]);
      // Beta's 90% off is not a discount Alpha's buyer has ever been offered.
      expect(matched.lines[0]?.unitPrice).toEqual(money(1000, "USD"));
    });
  });

  it("lists an ambiguous line for the merchant instead of guessing", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const matched = await match(
        fakeAdmin([
          variant({ id: "gid://shopify/ProductVariant/1", sku: "MUG-1" }),
          variant({ id: "gid://shopify/ProductVariant/2", sku: "MUG-2" }),
        ]),
        [poLine({ sku: null, description: "blue mug" })],
      );

      const line = matched.lines[0]!;
      expect(line.confidence).toBe("ambiguous");
      expect(line.variant).toBeNull();
      expect(line.candidates).toHaveLength(2);
      expect(line.unitPrice).toBeNull();
      expect(matched.subtotal).toEqual(money(0, "USD"));
      // Nothing ambiguous can reach a real order.
      expect(orderableLines(matched)).toEqual([]);
    });
  });

  it("applies the merchant's pick to the price, not just to the screen", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const matched = await match(
        fakeAdmin([
          variant({ id: "gid://shopify/ProductVariant/1", sku: "MUG-1", price: "10.00" }),
          variant({ id: "gid://shopify/ProductVariant/2", sku: "MUG-2", price: "25.00" }),
        ]),
        [poLine({ sku: null, description: "blue mug", quantity: 2 })],
        { "0": "gid://shopify/ProductVariant/2" },
      );

      const line = matched.lines[0]!;
      expect(line.variant?.id).toBe("gid://shopify/ProductVariant/2");
      expect(line.confidence).toBe("exact");
      expect(line.unitPrice).toEqual(money(2500, "USD"));
      expect(orderableLines(matched)).toEqual([
        {
          variantId: "gid://shopify/ProductVariant/2",
          quantity: 2,
          unitPrice: 2500,
          currencyCode: "USD",
          unitPriceDecimal: "25.00",
        },
      ]);
    });
  });

  it("keeps a line nothing matched, and keeps it off the order", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const matched = await match(fakeAdmin([]), [
        poLine({ sku: "GHOST-1", description: "something we don't sell" }),
      ]);

      expect(matched.lines).toHaveLength(1);
      expect(matched.lines[0]?.confidence).toBe("none");
      expect(matched.needsAttention).toBe(1);
      expect(orderableLines(matched)).toEqual([]);
    });
  });

  it("says a search never ran rather than that nothing matched", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const matched = await match(fakeAdmin([variant()], { failing: true }), [poLine()]);

      expect(matched.lines[0]?.confidence).toBe("unchecked");
      expect(matched.lines[0]?.candidates).toEqual([]);
      expect(orderableLines(matched)).toEqual([]);
    });
  });

  it("lists a variant whose price cannot be read, priced at nothing", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const matched = await match(fakeAdmin([variant({ price: "not a price" })]), [
        poLine(),
      ]);

      expect(matched.lines[0]?.confidence).toBe("none");
      expect(matched.lines[0]?.variant).not.toBeNull();
      expect(matched.lines[0]?.unitPrice).toBeNull();
      expect(orderableLines(matched)).toEqual([]);
    });
  });

  it("prices every line of a mixed order and totals only what it could", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const admin = {
        graphql: vi.fn(
          async (query: string, options?: { variables?: { query?: string } }) => {
            const term = options?.variables?.query ?? "";
            const nodes = term.includes("GHOST") ? [] : [variant()];
            return {
              json: async () => ({ data: { productVariants: { nodes } } }),
            };
          },
        ),
      } satisfies AdminGraphql;

      const matched = await match(admin, [
        poLine({ quantity: 2 }),
        poLine({ sku: "GHOST-1", description: "GHOST-1", quantity: 5 }),
        poLine({ quantity: 3 }),
      ]);

      expect(matched.lines).toHaveLength(3);
      expect(matched.subtotal).toEqual(money(5000, "USD"));
      expect(orderableLines(matched)).toHaveLength(2);
      expect(matched.needsAttention).toBe(1);
    });
  });
});
