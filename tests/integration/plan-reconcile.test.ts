import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import {
  reconcilePlan,
  RECONCILE_PAGE_SIZE,
} from "~/lib/jobs/handlers/reconcile-plan.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { toRowData } from "~/lib/pricing/rule-mapper.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";
import type { PricingRule } from "@mannon/pricing-engine";

/**
 * Making the plan true at checkout, after it changes.
 *
 * The gate refused every admin action correctly, and three capabilities went
 * on working anyway: the pricing ruleset, the order limits and each buyer's
 * net terms all reach a buyer through a metafield Shopify evaluates without
 * asking us. Withdrawing them is work, not a flag, and nothing did that work.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";

const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);

interface Call {
  query: string;
  variables?: Record<string, unknown>;
}

function fakeAdmin(): AdminGraphql & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    graphql: vi.fn(
      async (query: string, options?: { variables?: Record<string, unknown> }) => {
        calls.push({ query, variables: options?.variables });

        if (query.includes("MannonDiscountFunction")) {
          return {
            json: async () => ({
              data: { shopifyFunctions: { nodes: [{ id: "gid://fn/1", title: "M" }] } },
            }),
          };
        }
        if (query.includes("MannonUpdateDiscount")) {
          return {
            json: async () => ({
              data: {
                discountAutomaticAppUpdate: {
                  automaticAppDiscount: { discountId: "gid://d/1" },
                  userErrors: [],
                },
              },
            }),
          };
        }
        if (query.includes("MannonShopId") || query.includes("MannonShopFacts")) {
          return {
            json: async () => ({ data: { shop: { id: "gid://shopify/Shop/1" } } }),
          };
        }
        return {
          json: async () => ({
            data: { metafieldsSet: { metafields: [], userErrors: [] } },
          }),
        };
      },
    ),
  };
}

const rule = (id: string, priority: number): PricingRule =>
  ({
    id,
    name: `Wholesale ${id}`,
    status: "active",
    priority,
    combinable: false,
    kind: "percentage",
    value: { percentage: 20 },
    targets: { mode: "all" },
    audience: { mode: "tags", tags: ["wholesale"] },
    markets: { mode: "all", marketIds: [] },
    schedule: { startsAt: null, endsAt: null },
    createdAt: new Date("2026-01-01T00:00:00Z"),
  }) as PricingRule;

async function installShop(shop: string, planKey = "growth") {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        planKey,
        billingStatus: "ACTIVE",
        currencyCode: "USD",
        discountId: "gid://shopify/DiscountAutomaticNode/1",
      },
    }),
  );
}

const buyerOnTerms = (index: number) =>
  db.customer.create({
    data: {
      ...tenant(),
      customerId: `gid://shopify/Customer/${index}`,
      email: `buyer${index}@acme.test`,
      tags: ["wholesale"],
      currencyCode: "USD",
      netTermsDays: 30,
    },
  });

const publishedRuleset = (admin: { calls: Call[] }) => {
  const call = [...admin.calls]
    .reverse()
    .find((one) => one.query.includes("MannonSetMetafields"));
  const metafields = call?.variables?.metafields as Record<string, unknown>[] | undefined;
  const value = metafields?.[0]?.value as string | undefined;
  return value ? (JSON.parse(value) as { rules: unknown[] }) : null;
};

const buyerWrites = (admin: { calls: Call[] }) =>
  admin.calls.filter((call) => call.query.includes("MannonSetBuyerFacts"));

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

describe("reconciling checkout with the plan", () => {
  it("republishes the ruleset truncated to what the plan allows", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      for (let index = 0; index < 4; index += 1) {
        await db.pricingRule.create({
          data: { ...tenant(), ...toRowData(rule(`r${index}`, index + 1)) },
        });
      }
      await db.shop.update({
        where: { shop: ALPHA },
        data: { billingStatus: "CANCELLED" },
      });

      const admin = fakeAdmin();
      const result = await reconcilePlan(async () => admin);

      expect(result).toMatchObject({ done: true, pausedRules: 3 });
      // Free allows one. The other three stop pricing at checkout and stay in
      // the table — the Plans page has always said exactly this.
      expect(publishedRuleset(admin)!.rules).toHaveLength(1);
      expect(await db.pricingRule.count({ where: { archivedAt: null } })).toBe(4);
    });
  });

  it("puts everything back when the merchant resubscribes", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      for (let index = 0; index < 3; index += 1) {
        await db.pricingRule.create({
          data: { ...tenant(), ...toRowData(rule(`r${index}`, index + 1)) },
        });
      }

      const admin = fakeAdmin();
      const result = await reconcilePlan(async () => admin);

      expect(result).toMatchObject({ pausedRules: 0 });
      expect(publishedRuleset(admin)!.rules).toHaveLength(3);
    });
  });

  it("withdraws every buyer's net terms, and restores them", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await buyerOnTerms(1);
      await buyerOnTerms(2);
      await db.shop.update({
        where: { shop: ALPHA },
        data: { billingStatus: "CANCELLED" },
      });

      const admin = fakeAdmin();
      await reconcilePlan(async () => admin);

      const writes = buyerWrites(admin);
      expect(writes).toHaveLength(2);
      for (const write of writes) {
        const metafields = write.variables!.metafields as Record<string, unknown>[];
        const facts = JSON.parse(metafields[0]!.value as string) as {
          terms: unknown;
        };
        // The payment customization reads this. It kept offering "pay in 30
        // days" after a lapse while `recordPayment` refused the merchant the
        // ability to record the money coming in against it.
        expect(facts.terms).toBeNull();
      }

      // The ledger is untouched: days, invoices and due dates all stay.
      expect(await db.customer.count({ where: { netTermsDays: 30 } })).toBe(2);
    });
  });

  it("leaves a buyer with no terms alone", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await db.customer.create({
        data: {
          ...tenant(),
          customerId: "gid://shopify/Customer/9",
          email: "retail@acme.test",
          currencyCode: "USD",
        },
      });

      const admin = fakeAdmin();
      await reconcilePlan(async () => admin);

      // Nothing to withdraw, so nothing is written — a plan change must not be
      // thousands of metafield writes for buyers it cannot affect.
      expect(buyerWrites(admin)).toHaveLength(0);
    });
  });

  it("pages through the buyers and queues itself for the next page", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      for (let index = 0; index < RECONCILE_PAGE_SIZE + 2; index += 1) {
        await buyerOnTerms(index);
      }

      const admin = fakeAdmin();
      const first = await reconcilePlan(async () => admin);
      expect(first).toMatchObject({ done: false, buyers: RECONCILE_PAGE_SIZE });

      const mid = await db.shop.findUniqueOrThrow({ where: { shop: ALPHA } });
      expect(mid.planReconcileCursor).not.toBeNull();
      expect(mid.planReconciledAt).toBeNull();
      expect(await db.scheduledJob.count({ where: { kind: "billing.reconcile" } })).toBe(
        1,
      );

      const second = await reconcilePlan(async () => admin);
      expect(second).toMatchObject({ done: true, buyers: 2 });

      const done = await db.shop.findUniqueOrThrow({ where: { shop: ALPHA } });
      expect(done.planReconcileCursor).toBeNull();
      expect(done.planReconciledAt).not.toBeNull();
    });
  });

  it("does not create a discount for a shop that has never had one", async () => {
    await shopScope.run(ALPHA, () =>
      db.shop.create({ data: { ...tenant(), planKey: "free", currencyCode: "USD" } }),
    );

    await inAlpha(async () => {
      const admin = fakeAdmin();
      await reconcilePlan(async () => admin);

      // A plan change is not a reason to put a live object in somebody's
      // Shopify admin. The same rule the pause path follows.
      expect(
        admin.calls.some((call) => call.query.includes("MannonCreateDiscount")),
      ).toBe(false);
    });
  });

  it("does nothing for a shop that has uninstalled", async () => {
    await installShop(ALPHA);
    await inAlpha(() =>
      db.shop.update({ where: { shop: ALPHA }, data: { uninstalledAt: new Date() } }),
    );

    const admin = fakeAdmin();
    const result = await inAlpha(() => reconcilePlan(async () => admin));

    expect(result).toEqual({ skipped: "uninstalled" });
    expect(admin.calls).toHaveLength(0);
  });

  it("touches only its own shop", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await shopScope.run(BETA, () => buyerOnTerms(50));
    await inAlpha(async () => {
      const admin = fakeAdmin();
      await reconcilePlan(async () => admin);
      expect(buyerWrites(admin)).toHaveLength(0);
    });

    const beta = await shopScope.run(BETA, () =>
      db.shop.findUniqueOrThrow({ where: { shop: BETA } }),
    );
    expect(beta.planReconciledAt).toBeNull();
  });
});
