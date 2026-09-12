import type { PricingRule } from "@mannon/pricing-engine";
import { describe, expect, it, vi } from "vitest";

import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import {
  fetchProductCollections,
  PRODUCT_COLLECTIONS_FIELD,
  productCollectionIds,
  ruleUsesCollections,
} from "~/lib/pricing/product-collections.server";

/**
 * The one place anything outside checkout learns what is in a collection.
 *
 * It reads the same `$app:mannon.collections` metafield the discount Function
 * reads, which is the whole point: two readers of one value cannot disagree
 * about the same product, and a *fresher* second source would be worse, not
 * better — it would show a buyer a price checkout will not honour.
 */

const rule = (overrides: Partial<PricingRule> = {}): PricingRule =>
  ({
    id: "r1",
    name: "Wholesale 20%",
    status: "active",
    priority: 100,
    combinable: false,
    kind: "percentage",
    value: { percentage: 20 },
    targets: { mode: "all" },
    audience: { mode: "all" },
    markets: { mode: "all", marketIds: [] },
    schedule: { startsAt: null, endsAt: null },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }) as PricingRule;

function fakeAdmin(response: unknown): AdminGraphql & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    graphql: vi.fn(async (query: string) => {
      queries.push(query);
      return { json: async () => response };
    }),
  };
}

describe("reading the published metafield", () => {
  it("reads the list off a product node", () => {
    expect(
      productCollectionIds({ collections: { jsonValue: ["gid://c/1", "gid://c/2"] } }),
    ).toEqual(["gid://c/1", "gid://c/2"]);
  });

  it("treats an unwritten metafield as no collections, like the Function does", () => {
    // Genuinely different from "in no collections", and genuinely not this
    // function's to report: `Shop.productsBackfilledAt` says whether the store
    // has been published, and the Pricing page shows it.
    expect(productCollectionIds({ collections: null })).toEqual([]);
    expect(productCollectionIds(null)).toEqual([]);
    expect(productCollectionIds(undefined)).toEqual([]);
  });

  it("drops anything in the value that is not a string", () => {
    expect(
      productCollectionIds({ collections: { jsonValue: ["gid://c/1", 7, null, {}] } }),
    ).toEqual(["gid://c/1"]);
    expect(productCollectionIds({ collections: { jsonValue: "not a list" } })).toEqual(
      [],
    );
  });

  it("selects the app-reserved namespace, which only this app can read", () => {
    expect(PRODUCT_COLLECTIONS_FIELD).toContain('namespace: "$app:mannon"');
    expect(PRODUCT_COLLECTIONS_FIELD).toContain('key: "collections"');
  });
});

describe("the batched lookup", () => {
  it("asks once for many products and maps them by id", async () => {
    const admin = fakeAdmin({
      data: {
        nodes: [
          { id: "gid://p/1", collections: { jsonValue: ["gid://c/sale"] } },
          { id: "gid://p/2", collections: { jsonValue: [] } },
        ],
      },
    });

    const found = await fetchProductCollections(admin, [
      "gid://p/1",
      "gid://p/2",
      // Duplicated and empty ids do not become extra work.
      "gid://p/1",
      "",
    ]);

    expect(admin.queries).toHaveLength(1);
    expect(found.get("gid://p/1")).toEqual(["gid://c/sale"]);
    expect(found.get("gid://p/2")).toEqual([]);
  });

  it("does not call Shopify at all for an empty list", async () => {
    const admin = fakeAdmin({ data: { nodes: [] } });
    expect(await fetchProductCollections(admin, [])).toEqual(new Map());
    expect(admin.queries).toHaveLength(0);
  });

  it("gives back an empty map when Shopify answers with an error", async () => {
    // A buyer standing on a product page gets the theme's own prices, which is
    // what they were already looking at.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const admin = fakeAdmin({ errors: [{ message: "Throttled" }] });

    expect(await fetchProductCollections(admin, ["gid://p/1"])).toEqual(new Map());
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("gives back an empty map when the request throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const admin: AdminGraphql = {
      graphql: vi.fn(async () => {
        throw new Error("network");
      }),
    };

    expect(await fetchProductCollections(admin, ["gid://p/1"])).toEqual(new Map());
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("which rules need the lookup at all", () => {
  it("counts a rule targeting collections", () => {
    expect(
      ruleUsesCollections(
        rule({ targets: { mode: "collections", collectionIds: ["c"] } }),
      ),
    ).toBe(true);
  });

  /**
   * The expensive direction. With no membership an exclusion excludes nothing,
   * so the discount lands on exactly the products the merchant protected —
   * which is how "20% off everything except Sale" discounts the sale items.
   */
  it("counts a rule excluding collections, which is the one that costs money", () => {
    expect(
      ruleUsesCollections(
        rule({ targets: { mode: "all", excludeCollectionIds: ["c"] } }),
      ),
    ).toBe(true);
  });

  it("does not count a rule that never mentions a collection", () => {
    expect(ruleUsesCollections(rule())).toBe(false);
    expect(
      ruleUsesCollections(rule({ targets: { mode: "products", productIds: ["p"] } })),
    ).toBe(false);
    expect(
      ruleUsesCollections(rule({ targets: { mode: "all", excludeCollectionIds: [] } })),
    ).toBe(false);
  });
});
