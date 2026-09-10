import { parseMoney, type PricingRule } from "@mannon/pricing-engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { AdminApiError, type AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { normalizeBuyerFacts, publishBuyerFacts } from "~/lib/pricing/buyer-facts.server";
import {
  ensureDiscount,
  publishRuleset,
  RULESET_BYTE_LIMIT,
  RulesetTooLargeError,
  rulesetPayload,
} from "~/lib/pricing/ruleset.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const FUNCTION_ID = "gid://shopify/ShopifyFunction/abc123";
const DISCOUNT_ID = "gid://shopify/DiscountAutomaticNode/1";

const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);

const rule = (overrides: Partial<PricingRule> = {}): PricingRule =>
  ({
    id: "wholesale-35",
    name: "Wholesale 35%",
    status: "active",
    priority: 100,
    combinable: false,
    kind: "percentage",
    value: { percentage: 35 },
    targets: { mode: "all" },
    audience: { mode: "tags", tags: ["wholesale"] },
    markets: { mode: "all", marketIds: [] },
    schedule: { startsAt: null, endsAt: null },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }) as PricingRule;

/**
 * These calls cannot be exercised without a real store, so the tests pin the
 * request we send rather than a response we control. A change to the mutation
 * or its variables has to be deliberate.
 */
interface Call {
  query: string;
  variables?: Record<string, unknown>;
}

function fakeAdmin(responses: Record<string, unknown>): AdminGraphql & { calls: Call[] } {
  const calls: Call[] = [];

  return {
    calls,
    graphql: vi.fn(
      async (query: string, options?: { variables?: Record<string, unknown> }) => {
        calls.push({ query, variables: options?.variables });

        const key = Object.keys(responses).find((name) => query.includes(name));
        const data = key ? responses[key] : {};

        return { json: async () => ({ data }) };
      },
    ),
  };
}

const HAPPY = {
  MannonDiscountFunction: {
    shopifyFunctions: {
      nodes: [{ id: FUNCTION_ID, title: "Mannon", apiType: "discount" }],
    },
  },
  MannonCreateDiscount: {
    discountAutomaticAppCreate: {
      automaticAppDiscount: { discountId: DISCOUNT_ID },
      userErrors: [],
    },
  },
  MannonSetMetafields: {
    metafieldsSet: { metafields: [{ id: "gid://mf/1" }], userErrors: [] },
  },
  MannonSetBuyerFacts: {
    metafieldsSet: { metafields: [{ id: "gid://mf/2" }], userErrors: [] },
  },
};

async function installShop(shop: string) {
  await shopScope.run(shop, () => db.shop.create({ data: { ...tenant() } }));
}

const callFor = (admin: { calls: Call[] }, name: string) =>
  admin.calls.find((call) => call.query.includes(name));

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

describe("publishing the ruleset", () => {
  it("creates the discount and attaches the ruleset", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin(HAPPY);

    const result = await inAlpha(() => publishRuleset(admin, [rule()]));

    expect(result).toMatchObject({ status: "published", ruleCount: 1 });

    const create = callFor(admin, "MannonCreateDiscount");
    const discount = create!.variables!.discount as Record<string, unknown>;
    expect(discount.functionId).toBe(FUNCTION_ID);
    expect(discount.title).toBe("Mannon wholesale pricing");
    // Wholesale pricing is not a promotion: no end date.
    expect(discount.endsAt).toBeUndefined();

    const metafield = (discount.metafields as Record<string, unknown>[])[0]!;
    expect(metafield.namespace).toBe("$app:mannon");
    expect(metafield.key).toBe("ruleset");
    expect(metafield.type).toBe("json");
    expect(JSON.parse(metafield.value as string).rules[0].id).toBe("wholesale-35");
  });

  it("remembers the discount and does not create a second one", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin(HAPPY);

    await inAlpha(() => publishRuleset(admin, [rule()]));
    await inAlpha(() => publishRuleset(admin, [rule({ value: { percentage: 40 } })]));

    const creates = admin.calls.filter((call) =>
      call.query.includes("MannonCreateDiscount"),
    );
    expect(creates).toHaveLength(1);

    const shop = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.discountId).toBe(DISCOUNT_ID);
    expect(shop.discountFunctionId).toBe(FUNCTION_ID);
  });

  it("writes the metafield against the discount that owns it", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin(HAPPY);
    await inAlpha(() => publishRuleset(admin, [rule()]));

    const set = callFor(admin, "MannonSetMetafields");
    const metafield = (set!.variables!.metafields as Record<string, unknown>[])[0]!;
    expect(metafield.ownerId).toBe(DISCOUNT_ID);
  });

  /** Saving an unrelated setting should not spend an API call. */
  it("skips an unchanged ruleset", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin(HAPPY);

    await inAlpha(() => publishRuleset(admin, [rule()]));
    const before = admin.calls.length;

    const second = await inAlpha(() => publishRuleset(admin, [rule()]));

    expect(second.status).toBe("unchanged");
    expect(admin.calls.length).toBe(before);
  });

  it("republishes when a rule changes", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin(HAPPY);

    await inAlpha(() => publishRuleset(admin, [rule()]));
    const second = await inAlpha(() =>
      publishRuleset(admin, [rule({ value: { percentage: 36 } })]),
    );

    expect(second.status).toBe("published");
  });

  it("records what is live for the merchant to see", async () => {
    await installShop(ALPHA);
    await inAlpha(() => publishRuleset(fakeAdmin(HAPPY), [rule(), rule({ id: "b" })]));

    const shop = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.rulesetRuleCount).toBe(2);
    expect(shop.rulesetPublishedAt).toBeInstanceOf(Date);

    const entry = await inAlpha(() =>
      db.auditLog.findFirstOrThrow({ where: { action: "pricing.ruleset_published" } }),
    );
    expect(entry.summary).toContain("2 pricing rules");
  });

  /**
   * Truncating a ruleset would mean charging prices nobody configured, so an
   * oversized one fails and leaves checkout on the last good ruleset.
   */
  it("refuses to publish a ruleset over the metafield limit", async () => {
    await installShop(ALPHA);
    const many = Array.from({ length: 4000 }, (_, index) =>
      rule({ id: `rule-${index}`, name: `Rule number ${index} with a long-ish name` }),
    );

    expect(rulesetPayload(many).bytes).toBeGreaterThan(RULESET_BYTE_LIMIT);
    await expect(
      inAlpha(() => publishRuleset(fakeAdmin(HAPPY), many)),
    ).rejects.toBeInstanceOf(RulesetTooLargeError);

    const shop = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.rulesetHash).toBeNull();
  });

  it("surfaces Shopify's own errors rather than reporting success", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin({
      ...HAPPY,
      MannonCreateDiscount: {
        discountAutomaticAppCreate: {
          automaticAppDiscount: null,
          userErrors: [{ message: "Function not found", field: ["functionId"] }],
        },
      },
    });

    await expect(inAlpha(() => publishRuleset(admin, [rule()]))).rejects.toThrow(
      /Function not found/,
    );
  });

  it("says what to do when no Function is deployed", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin({
      ...HAPPY,
      MannonDiscountFunction: { shopifyFunctions: { nodes: [] } },
    });

    await expect(inAlpha(() => ensureDiscount(admin, []))).rejects.toThrow(
      /shopify app deploy/,
    );
  });

  it("uses a pinned function id when one is configured", async () => {
    await installShop(ALPHA);
    process.env.SHOPIFY_DISCOUNT_FUNCTION_ID = "gid://shopify/ShopifyFunction/pinned";
    const admin = fakeAdmin(HAPPY);

    await inAlpha(() => publishRuleset(admin, [rule()]));

    expect(callFor(admin, "MannonDiscountFunction")).toBeUndefined();
    const create = callFor(admin, "MannonCreateDiscount");
    expect((create!.variables!.discount as { functionId: string }).functionId).toBe(
      "gid://shopify/ShopifyFunction/pinned",
    );

    delete process.env.SHOPIFY_DISCOUNT_FUNCTION_ID;
  });

  it("keeps one shop's discount out of another's", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    await inAlpha(() => publishRuleset(fakeAdmin(HAPPY), [rule()]));

    const beta = await shopScope.run(BETA, () =>
      db.shop.findUniqueOrThrow({ where: { shop: BETA } }),
    );
    expect(beta.discountId).toBeNull();
    expect(beta.rulesetHash).toBeNull();
  });
});

describe("publishing buyer facts", () => {
  it("writes the tags checkout needs, against the customer", async () => {
    const admin = fakeAdmin(HAPPY);
    await publishBuyerFacts(admin, "gid://shopify/Customer/1", {
      tags: ["wholesale", "gold"],
      terms: null,
    });

    const metafield = (
      callFor(admin, "MannonSetBuyerFacts")!.variables!.metafields as Record<
        string,
        unknown
      >[]
    )[0]!;

    expect(metafield.ownerId).toBe("gid://shopify/Customer/1");
    expect(metafield.namespace).toBe("$app:mannon");
    expect(metafield.key).toBe("buyer");
    expect(JSON.parse(metafield.value as string)).toEqual({
      tags: ["gold", "wholesale"],
      groupIds: [],
      terms: null,
    });
  });

  it("normalises the tag list Shopify sends", () => {
    // Webhooks send a comma-separated string; the API sends an array.
    expect(normalizeBuyerFacts({ tags: " wholesale , gold ,, wholesale " })).toEqual({
      tags: ["gold", "wholesale"],
      groupIds: [],
      terms: null,
    });
    expect(normalizeBuyerFacts({ tags: ["b", "a", "a"] })).toEqual({
      tags: ["a", "b"],
      groupIds: [],
      terms: null,
    });
    expect(normalizeBuyerFacts({ tags: null })).toEqual({
      tags: [],
      groupIds: [],
      terms: null,
    });
  });

  it("sorts deterministically, so an unchanged buyer produces an unchanged value", () => {
    expect(normalizeBuyerFacts({ tags: ["b", "a"] })).toEqual(
      normalizeBuyerFacts({ tags: ["a", "b"] }),
    );
  });

  it("raises Shopify's error rather than pretending the buyer is ready", async () => {
    const admin = fakeAdmin({
      MannonSetBuyerFacts: {
        metafieldsSet: {
          metafields: [],
          userErrors: [{ message: "Owner not found", field: ["ownerId"] }],
        },
      },
    });

    await expect(
      publishBuyerFacts(admin, "gid://shopify/Customer/404", {
        tags: ["wholesale"],
        terms: null,
      }),
    ).rejects.toBeInstanceOf(AdminApiError);
  });
});

describe("the ruleset payload", () => {
  it("hashes to the same value for the same rules", () => {
    expect(rulesetPayload([rule()]).hash).toBe(rulesetPayload([rule()]).hash);
  });

  it("hashes differently when anything changes", () => {
    expect(rulesetPayload([rule()]).hash).not.toBe(
      rulesetPayload([rule({ value: { percentage: 36 } })]).hash,
    );
  });

  it("carries money as exact minor units on the wire", () => {
    const fixed = rule({
      kind: "fixed_price",
      value: { base: parseMoney("8.05", "USD"), overrides: {} },
    });
    const wire = JSON.parse(rulesetPayload([fixed]).json);
    expect(wire.rules[0].value.base).toEqual({ amount: 805, currencyCode: "USD" });
  });
});
