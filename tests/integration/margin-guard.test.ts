import { describe, expect, it, vi } from "vitest";

import type { PricingRule } from "@mannon/pricing-engine";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import {
  fetchCollections,
  fetchMarginCandidates,
  MARGIN_SAMPLE_PRODUCTS,
} from "~/lib/pricing/catalog.server";
import { checkMargins } from "~/lib/pricing/margin-guard.server";

/**
 * The margin guard against a stubbed Admin API.
 *
 * The costs it reads have never come from a real store — there is no dev-store
 * session in this environment — so these tests pin the request shape and the
 * conversion, which is where the damage would be. A unit cost read as ×100 in
 * a three-decimal currency reports a healthy margin on a rule losing money,
 * and that mistake has already shipped twice in this codebase.
 */

const NOW = new Date("2026-09-10T12:00:00Z");

const variant = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/ProductVariant/1",
  sku: "SKU-1",
  title: "Default Title",
  price: "100.00",
  inventoryItem: { unitCost: { amount: "60.00", currencyCode: "USD" } },
  ...overrides,
});

const product = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Product/1",
  title: "Oak table",
  collections: { nodes: [{ id: "gid://shopify/Collection/1" }] },
  variants: { nodes: [variant()] },
  ...overrides,
});

interface Call {
  query: string;
  variables: Record<string, unknown>;
}

function fakeAdmin(
  answer: (query: string, variables: Record<string, unknown>) => unknown,
): AdminGraphql & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    graphql: vi.fn(
      async (query: string, options?: { variables?: Record<string, unknown> }) => {
        calls.push({ query, variables: options?.variables ?? {} });
        return { json: async () => ({ data: answer(query, options?.variables ?? {}) }) };
      },
    ),
  };
}

const rule = (overrides: Partial<PricingRule> = {}): PricingRule =>
  ({
    id: "r1",
    name: "Wholesale",
    status: "draft",
    priority: 100,
    combinable: false,
    targets: { mode: "all" },
    audience: { mode: "all" },
    markets: { mode: "all", marketIds: [] },
    schedule: { startsAt: null, endsAt: null },
    createdAt: NOW,
    kind: "percentage",
    value: { percentage: 50 },
    ...overrides,
  }) as PricingRule;

/* -------------------------------------------------------------------------- */

describe("fetchCollections", () => {
  it("pages until Shopify says there are no more", async () => {
    let page = 0;
    const admin = fakeAdmin(() => {
      page += 1;
      return {
        collections: {
          nodes: [
            {
              id: `gid://shopify/Collection/${page}`,
              title: `C${page}`,
              handle: `c${page}`,
            },
          ],
          pageInfo: { hasNextPage: page < 3, endCursor: `cursor-${page}` },
        },
      };
    });

    const collections = await fetchCollections(admin);

    expect(collections.map((one) => one.title)).toEqual(["C1", "C2", "C3"]);
    expect(admin.calls[1]?.variables.after).toBe("cursor-1");
  });

  it("stops at the limit even if Shopify keeps offering more", async () => {
    const admin = fakeAdmin(() => ({
      collections: {
        nodes: [{ id: "gid://shopify/Collection/1", title: "C", handle: "c" }],
        pageInfo: { hasNextPage: true, endCursor: "next" },
      },
    }));

    expect(await fetchCollections(admin, 2)).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */

describe("fetchMarginCandidates", () => {
  it("reads variant prices and costs in minor units", async () => {
    const admin = fakeAdmin(() => ({
      products: { nodes: [product()] },
    }));

    const { candidates } = await fetchMarginCandidates(admin, { mode: "all" }, "USD");

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sku: "SKU-1",
      title: "Oak table",
      price: { amount: 10_000, currencyCode: "USD" },
      cost: { amount: 6_000, currencyCode: "USD" },
      collectionIds: ["gid://shopify/Collection/1"],
    });
  });

  it("reads a three-decimal currency by its own exponent", async () => {
    const admin = fakeAdmin(() => ({
      products: {
        nodes: [
          product({
            variants: {
              nodes: [
                variant({
                  price: "10.500",
                  inventoryItem: { unitCost: { amount: "6.250", currencyCode: "KWD" } },
                }),
              ],
            },
          }),
        ],
      },
    }));

    const { candidates } = await fetchMarginCandidates(admin, { mode: "all" }, "KWD");

    expect(candidates[0]?.price).toEqual({ amount: 10_500, currencyCode: "KWD" });
    expect(candidates[0]?.cost).toEqual({ amount: 6_250, currencyCode: "KWD" });
  });

  it("names a variant after its product and its own option", async () => {
    const admin = fakeAdmin(() => ({
      products: {
        nodes: [
          product({
            variants: { nodes: [variant({ title: "Blue / Large" })] },
          }),
        ],
      },
    }));

    const { candidates } = await fetchMarginCandidates(admin, { mode: "all" }, "USD");
    expect(candidates[0]?.title).toBe("Oak table — Blue / Large");
  });

  it("records no cost rather than a zero one when Shopify has none", async () => {
    const admin = fakeAdmin(() => ({
      products: {
        nodes: [product({ variants: { nodes: [variant({ inventoryItem: null })] } })],
      },
    }));

    const { candidates } = await fetchMarginCandidates(admin, { mode: "all" }, "USD");
    expect(candidates[0]?.cost).toBeNull();
  });

  it("asks for the targeted variants by id", async () => {
    const admin = fakeAdmin(() => ({
      nodes: [{ ...variant(), product: product() }],
    }));

    const { candidates } = await fetchMarginCandidates(
      admin,
      { mode: "variants", variantIds: ["gid://shopify/ProductVariant/1"] },
      "USD",
    );

    expect(admin.calls[0]?.query).toContain("MannonVariantCosts");
    expect(admin.calls[0]?.variables.ids).toEqual(["gid://shopify/ProductVariant/1"]);
    expect(candidates).toHaveLength(1);
  });

  it("skips a variant that has been deleted in Shopify", async () => {
    const admin = fakeAdmin(() => ({ nodes: [null] }));

    const { candidates } = await fetchMarginCandidates(
      admin,
      { mode: "variants", variantIds: ["gid://shopify/ProductVariant/404"] },
      "USD",
    );

    expect(candidates).toEqual([]);
  });

  it("spreads its budget across every targeted collection", async () => {
    const admin = fakeAdmin(() => ({
      collection: { products: { nodes: [product()] } },
    }));

    await fetchMarginCandidates(
      admin,
      {
        mode: "collections",
        collectionIds: ["gid://shopify/Collection/1", "gid://shopify/Collection/2"],
      },
      "USD",
    );

    expect(admin.calls).toHaveLength(2);
    expect(admin.calls[0]?.variables.first).toBe(MARGIN_SAMPLE_PRODUCTS / 2);
    expect(admin.calls[1]?.variables.id).toBe("gid://shopify/Collection/2");
  });

  it("asks Shopify for nothing when a rule targets nothing", async () => {
    const admin = fakeAdmin(() => ({}));

    const { candidates } = await fetchMarginCandidates(
      admin,
      { mode: "collections", collectionIds: [] },
      "USD",
    );

    expect(candidates).toEqual([]);
    expect(admin.calls).toEqual([]);
  });

  it("says it sampled when the catalogue is bigger than the budget", async () => {
    const admin = fakeAdmin(() => ({
      products: {
        nodes: Array.from({ length: MARGIN_SAMPLE_PRODUCTS }, (_, index) =>
          product({ id: `gid://shopify/Product/${index}` }),
        ),
      },
    }));

    const { sampled } = await fetchMarginCandidates(admin, { mode: "all" }, "USD");
    expect(sampled).toBe(true);
  });

  it("does not claim to have sampled a small catalogue", async () => {
    const admin = fakeAdmin(() => ({ products: { nodes: [product()] } }));
    const { sampled } = await fetchMarginCandidates(admin, { mode: "all" }, "USD");
    expect(sampled).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("checkMargins", () => {
  it("finds the loss and reports what it checked", async () => {
    const admin = fakeAdmin(() => ({ products: { nodes: [product()] } }));

    const result = await checkMargins(admin, rule(), { currencyCode: "USD", now: NOW });

    expect(result.status).toBe("checked");
    expect(result.report?.checked).toBe(1);
    expect(result.report?.belowCost).toHaveLength(1);
    expect(result.report?.belowCost[0]?.sku).toBe("SKU-1");
  });

  it("says it could not check when Shopify returns an error", async () => {
    const admin: AdminGraphql = {
      graphql: async () => ({
        json: async () => ({ errors: [{ message: "Throttled" }] }),
      }),
    };

    const result = await checkMargins(admin, rule(), { currencyCode: "USD", now: NOW });

    expect(result.status).toBe("unavailable");
    expect(result.report).toBeNull();
    expect(result.detail).toContain("Throttled");
  });

  it("does not throw when the Admin API is unreachable", async () => {
    const admin: AdminGraphql = {
      graphql: async () => {
        throw new Error("ECONNREFUSED");
      },
    };

    await expect(
      checkMargins(admin, rule(), { currencyCode: "USD", now: NOW }),
    ).resolves.toMatchObject({ status: "unavailable" });
  });
});
