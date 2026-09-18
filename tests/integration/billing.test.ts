import type { PricingRule } from "@mannon/pricing-engine";
import type { AppSubscription } from "@shopify/shopify-api";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { GRACE_PERIOD_DAYS, loadEntitlements } from "~/lib/billing/entitlements.server";
import {
  assertFeature,
  assertWithinLimit,
  FeatureLockedError,
  LimitReachedError,
} from "~/lib/billing/gate.server";
import {
  syncSubscription,
  syncSubscriptionIfStale,
} from "~/lib/billing/subscription.server";
import { publishLimits } from "~/lib/orders/limits.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { toRowData } from "~/lib/pricing/rule-mapper.server";
import { activeEngineRules } from "~/lib/pricing/rules.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";
import { signedWebhookRequest } from "../support/webhook-request";

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const NOW = new Date("2026-06-15T12:00:00Z");

const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const subscription = (overrides: Partial<AppSubscription> = {}): AppSubscription =>
  ({
    id: "gid://shopify/AppSubscription/1",
    name: "growth-monthly",
    test: false,
    status: "ACTIVE",
    trialDays: 0,
    createdAt: "2026-06-01T12:00:00Z",
    currentPeriodEnd: "2026-07-01T12:00:00Z",
    lineItems: [],
    ...overrides,
  }) as AppSubscription;

/** A stand-in for Shopify's billing helper. */
const billingReturning = (subscriptions: AppSubscription[]) => ({
  check: vi.fn(async () => ({ appSubscriptions: subscriptions })),
});

async function installShop(shop: string) {
  await shopScope.run(shop, () => db.shop.create({ data: { ...tenant() } }));
}

const post = async (request: Request) => {
  const { action } = await import("~/routes/webhooks.$");
  return action({ request, params: {}, context: {} as never });
};

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

describe("caching the subscription", () => {
  it("writes Shopify's answer onto the shop", async () => {
    await installShop(ALPHA);
    await inAlpha(() => syncSubscription(billingReturning([subscription()]), NOW));

    const shop = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.planKey).toBe("growth");
    expect(shop.billingStatus).toBe("ACTIVE");
    expect(shop.billingInterval).toBe("monthly");
    expect(shop.billingSyncedAt).toEqual(NOW);
  });

  it("records the change in the audit log", async () => {
    await installShop(ALPHA);
    await inAlpha(() => syncSubscription(billingReturning([subscription()]), NOW));

    const entry = await inAlpha(() =>
      db.auditLog.findFirstOrThrow({ where: { action: "billing.subscription_changed" } }),
    );
    expect(entry.summary).toContain("growth");
  });

  it("does not log when nothing changed", async () => {
    await installShop(ALPHA);
    const billing = billingReturning([subscription()]);
    await inAlpha(() => syncSubscription(billing, NOW));
    await inAlpha(() => syncSubscription(billing, NOW));

    const count = await inAlpha(() =>
      db.auditLog.count({ where: { action: "billing.subscription_changed" } }),
    );
    expect(count).toBe(1);
  });

  /**
   * Restarting the clock on every sync would give a merchant an unlimited
   * grace period simply by loading the page.
   */
  it("does not extend the grace period on a later sync", async () => {
    await installShop(ALPHA);
    const billing = billingReturning([subscription({ status: "FROZEN" })]);

    await inAlpha(() => syncSubscription(billing, NOW));
    const first = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );

    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    await inAlpha(() => syncSubscription(billing, later));
    const second = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );

    expect(second.graceEndsAt).toEqual(first.graceEndsAt);
  });

  it("clears the grace period once the charge goes through", async () => {
    await installShop(ALPHA);
    await inAlpha(() =>
      syncSubscription(billingReturning([subscription({ status: "FROZEN" })]), NOW),
    );
    await inAlpha(() => syncSubscription(billingReturning([subscription()]), NOW));

    const shop = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.graceEndsAt).toBeNull();
    expect(shop.billingStatus).toBe("ACTIVE");
  });

  it("only syncs a stale cache", async () => {
    await installShop(ALPHA);
    const billing = billingReturning([subscription()]);

    await inAlpha(() => syncSubscriptionIfStale(billing, NOW));
    expect(billing.check).toHaveBeenCalledTimes(1);

    // Ten minutes later: still fresh.
    await inAlpha(() =>
      syncSubscriptionIfStale(billing, new Date(NOW.getTime() + 10 * 60_000)),
    );
    expect(billing.check).toHaveBeenCalledTimes(1);

    // Two hours later: stale.
    await inAlpha(() =>
      syncSubscriptionIfStale(billing, new Date(NOW.getTime() + 2 * 3_600_000)),
    );
    expect(billing.check).toHaveBeenCalledTimes(2);
  });

  /**
   * A billing API outage must not take the whole admin down; the merchant keeps
   * the plan they had until we can ask again.
   */
  it("keeps the cached plan when Shopify is unreachable", async () => {
    await installShop(ALPHA);
    await inAlpha(() => syncSubscription(billingReturning([subscription()]), NOW));

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      check: vi.fn(async () => {
        throw new Error("502 from Shopify");
      }),
    };

    await expect(
      inAlpha(() =>
        syncSubscriptionIfStale(failing, new Date(NOW.getTime() + 2 * 3_600_000)),
      ),
    ).resolves.toBeUndefined();

    const shop = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.planKey).toBe("growth");
    error.mockRestore();
  });

  it("never reads or writes another shop's plan", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    await inAlpha(() => syncSubscription(billingReturning([subscription()]), NOW));

    const beta = await inBeta(() => db.shop.findUniqueOrThrow({ where: { shop: BETA } }));
    expect(beta.planKey).toBe("free");
    expect(beta.billingStatus).toBe("NONE");
  });
});

describe("the gate", () => {
  it("refuses a capability the plan does not include, and names the plan that does", async () => {
    await installShop(ALPHA);

    await expect(inAlpha(() => assertFeature("buyer_agent"))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof FeatureLockedError &&
        error.requiredPlan === "agentic" &&
        error.currentPlan === "free",
    );
  });

  it("allows a capability the plan includes", async () => {
    await installShop(ALPHA);
    await inAlpha(() => syncSubscription(billingReturning([subscription()]), NOW));

    await expect(inAlpha(() => assertFeature("merchant_agent"))).resolves.toMatchObject({
      effectivePlan: "growth",
    });
  });

  it("stops granting paid capability once a subscription is cancelled", async () => {
    await installShop(ALPHA);
    await inAlpha(() => syncSubscription(billingReturning([subscription()]), NOW));
    await inAlpha(() =>
      syncSubscription(billingReturning([subscription({ status: "CANCELLED" })]), NOW),
    );

    await expect(inAlpha(() => assertFeature("merchant_agent"))).rejects.toBeInstanceOf(
      FeatureLockedError,
    );
  });

  it("enforces quotas, and reports the numbers the merchant needs", async () => {
    await installShop(ALPHA);

    await expect(
      inAlpha(() => assertWithinLimit("pricingRules", 0)),
    ).resolves.toBeTruthy();
    await expect(inAlpha(() => assertWithinLimit("pricingRules", 1))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof LimitReachedError &&
        error.used === 1 &&
        error.allowed === 1 &&
        error.requiredPlan === "pro",
    );
  });

  it("lifts the quota on a paid plan", async () => {
    await installShop(ALPHA);
    await inAlpha(() => syncSubscription(billingReturning([subscription()]), NOW));
    await expect(
      inAlpha(() => assertWithinLimit("pricingRules", 500)),
    ).resolves.toBeTruthy();
  });

  it("gates on the tenant making the request, not the last one seen", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    await inAlpha(() => syncSubscription(billingReturning([subscription()]), NOW));

    await expect(inAlpha(() => assertFeature("merchant_agent"))).resolves.toBeTruthy();
    await expect(inBeta(() => assertFeature("merchant_agent"))).rejects.toBeInstanceOf(
      FeatureLockedError,
    );
  });

  it("grants nothing to a shop with no install record", async () => {
    const entitlements = await inAlpha(() => loadEntitlements(NOW));
    expect(entitlements.effectivePlan).toBe("free");
  });
});

describe("the app_subscriptions/update webhook", () => {
  const send = (payload: Record<string, unknown>, shop = ALPHA, webhookId = "wh_b1") =>
    post(
      signedWebhookRequest({
        topic: "app_subscriptions/update",
        shop,
        webhookId,
        payload,
      }),
    );

  it("applies an approved subscription without waiting for a page load", async () => {
    await installShop(ALPHA);

    const response = await send({
      app_subscription: {
        admin_graphql_api_id: "gid://shopify/AppSubscription/9",
        name: "agentic-annual",
        status: "ACTIVE",
        test: false,
      },
    });

    expect(response.status).toBe(200);
    const shop = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.planKey).toBe("agentic");
    expect(shop.billingInterval).toBe("annual");
    expect(shop.billingStatus).toBe("ACTIVE");
  });

  it("starts the grace period when a charge fails", async () => {
    await installShop(ALPHA);
    await send({ app_subscription: { name: "growth-monthly", status: "FROZEN" } });

    const shop = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.billingStatus).toBe("PAST_DUE");
    expect(shop.graceEndsAt).toBeInstanceOf(Date);

    const entitlements = await inAlpha(() => loadEntitlements());
    expect(entitlements.effectivePlan).toBe("growth");
    expect(entitlements.graceDaysRemaining).toBe(GRACE_PERIOD_DAYS);
  });

  it("does not extend the grace period on a repeated notification", async () => {
    await installShop(ALPHA);
    await send(
      { app_subscription: { name: "growth-monthly", status: "FROZEN" } },
      ALPHA,
      "wh_1",
    );
    const first = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );

    await send(
      { app_subscription: { name: "growth-monthly", status: "FROZEN" } },
      ALPHA,
      "wh_2",
    );
    const second = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );

    expect(second.graceEndsAt).toEqual(first.graceEndsAt);
  });

  it("pauses paid features on cancellation without deleting anything", async () => {
    await installShop(ALPHA);
    await send(
      { app_subscription: { name: "growth-monthly", status: "ACTIVE" } },
      ALPHA,
      "wh_1",
    );
    await send(
      { app_subscription: { name: "growth-monthly", status: "CANCELLED" } },
      ALPHA,
      "wh_2",
    );

    const shop = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.billingStatus).toBe("CANCELLED");
    // The install record and everything hanging off it survives.
    expect(shop.installedAt).toBeInstanceOf(Date);
    expect(shop.uninstalledAt).toBeNull();
  });

  /**
   * A plan renamed without a migration would otherwise drop a paying merchant
   * to Free on the next webhook. Leave the cache alone and make it loud.
   */
  it("leaves the cached plan alone when it does not recognise the subscription", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await installShop(ALPHA);
    await send(
      { app_subscription: { name: "growth-monthly", status: "ACTIVE" } },
      ALPHA,
      "wh_1",
    );

    await send(
      { app_subscription: { name: "enterprise-monthly", status: "ACTIVE" } },
      ALPHA,
      "wh_2",
    );

    const shop = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.planKey).toBe("growth");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("unrecognised subscription"),
    );
    error.mockRestore();
  });

  it("does not change another shop's plan", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    await send({ app_subscription: { name: "agentic-monthly", status: "ACTIVE" } });

    const beta = await inBeta(() => db.shop.findUniqueOrThrow({ where: { shop: BETA } }));
    expect(beta.planKey).toBe("free");
  });

  it("writes an audit entry the merchant can read", async () => {
    await installShop(ALPHA);
    await send({ app_subscription: { name: "growth-monthly", status: "FROZEN" } });

    const entry = await inAlpha(() =>
      db.auditLog.findFirstOrThrow({ where: { action: "billing.past_due" } }),
    );
    expect(entry.summary).toContain("keep working");
  });
});

/* -------------------------------------------------------------------------- */
/* What a lapse has to actually do                                             */
/* -------------------------------------------------------------------------- */

interface AdminCall {
  query: string;
  variables?: Record<string, unknown>;
}

/** Answers the shop-id read and records what was written. */
function fakeLimitsAdmin(): AdminGraphql & { calls: AdminCall[] } {
  const calls: AdminCall[] = [];
  return {
    calls,
    graphql: vi.fn(
      async (query: string, options?: { variables?: Record<string, unknown> }) => {
        calls.push({ query, variables: options?.variables });
        if (query.includes("shop")) {
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

/**
 * "Paid features are paused" is a sentence this app printed and did not mean.
 *
 * `entitlementsFor` correctly dropped `effectivePlan` to Free on a cancellation,
 * and the gate correctly refused every *admin* action. But three capabilities
 * reach a buyer through a metafield Shopify evaluates without asking us — the
 * pricing ruleset, the order limits, the buyer's net terms — and nothing
 * withdrew any of them. A merchant who cancelled kept all of it, for ever.
 */
describe("a lapsed subscription at checkout", () => {
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

  const seedRules = async (count: number) => {
    for (let index = 0; index < count; index += 1) {
      await db.pricingRule.create({
        data: { ...tenant(), ...toRowData(rule(`r${index}`, index + 1)) },
      });
    }
  };

  const onPlan = (plan: string, status: "ACTIVE" | "CANCELLED") =>
    db.shop.update({
      where: { shop: ALPHA },
      data: { planKey: plan, billingStatus: status },
    });

  it("prices with only as many rules as the effective plan allows", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedRules(5);
      await onPlan("growth", "ACTIVE");
      // Paid: every rule applies.
      expect((await activeEngineRules()).rules).toHaveLength(5);

      await onPlan("growth", "CANCELLED");
      const lapsed = await activeEngineRules();

      // Free allows one. The quota used to be consulted on create and nowhere
      // else, so all five kept pricing at checkout after the merchant left.
      expect(lapsed.rules).toHaveLength(1);
      expect(lapsed.pausedByPlan).toBe(4);
    });
  });

  it("keeps the rules the merchant ranked highest, and the same ones every time", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedRules(3);
      await onPlan("pro", "CANCELLED");

      const first = await activeEngineRules();
      const second = await activeEngineRules();

      // The cascade's own order, so which rule survives is a thing the
      // merchant can predict and audit rather than a coin toss per request.
      expect(first.rules[0]!.id).toBe(second.rules[0]!.id);
      expect(first.rules[0]!.priority).toBe(1);
    });
  });

  it("deletes nothing, and gives it all back on resubscribing", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedRules(4);
      await onPlan("growth", "CANCELLED");
      expect((await activeEngineRules()).rules).toHaveLength(1);

      // Still in the table, all four of them.
      expect(await db.pricingRule.count({ where: { archivedAt: null } })).toBe(4);

      await onPlan("growth", "ACTIVE");
      expect((await activeEngineRules()).rules).toHaveLength(4);
      expect((await activeEngineRules()).pausedByPlan).toBe(0);
    });
  });

  it("publishes no order limits, because the Function reads a metafield", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await db.orderLimit.create({
        data: { ...tenant(), enabled: true, minSubtotal: 20000 },
      });
      await onPlan("growth", "CANCELLED");

      const admin = fakeLimitsAdmin();
      await publishLimits(admin);

      const written = admin.calls.find((call) => call.query.includes("metafieldsSet"))!;
      const metafield = (written.variables!.metafields as Record<string, unknown>[])[0]!;
      const payload = JSON.parse(metafield.value as string) as { limits: unknown[] };

      // Gating the editor stopped nothing: a merchant who cancelled kept every
      // minimum blocking their buyers' carts.
      expect(payload.limits).toEqual([]);
      // And the row is untouched — resubscribing republishes it.
      expect(await db.orderLimit.count()).toBe(1);
    });
  });
});

/**
 * An upgrade is exactly when Shopify sends two deliveries whose order is not
 * guaranteed: the new subscription going ACTIVE, and the replaced one going
 * CANCELLED. The handler wrote whatever the payload said.
 */
describe("a subscription webhook that arrives out of order", () => {
  const send = (payload: Record<string, unknown>, webhookId: string) =>
    post(
      signedWebhookRequest({
        topic: "app_subscriptions/update",
        shop: ALPHA,
        webhookId,
        payload,
      }),
    );

  const planOf = async () =>
    (await inAlpha(() => db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }))).planKey;

  it("ignores the cancellation of a subscription the merchant upgraded away from", async () => {
    await installShop(ALPHA);

    // The merchant moves pro → growth. Shopify emits both halves.
    await send(
      {
        app_subscription: {
          admin_graphql_api_id: "gid://shopify/AppSubscription/2",
          name: "growth-monthly",
          status: "ACTIVE",
          created_at: "2026-06-15T12:00:00Z",
        },
      },
      "wh_new",
    );
    await send(
      {
        app_subscription: {
          admin_graphql_api_id: "gid://shopify/AppSubscription/1",
          name: "pro-monthly",
          status: "CANCELLED",
          created_at: "2026-01-01T12:00:00Z",
        },
      },
      "wh_old",
    );

    // They were charged for Growth minutes ago. They used to end up on Free,
    // with an audit line saying their pro subscription had ended.
    expect(await planOf()).toBe("growth");
  });

  it("still applies a real cancellation of the subscription the shop is on", async () => {
    await installShop(ALPHA);

    await send(
      {
        app_subscription: {
          admin_graphql_api_id: "gid://shopify/AppSubscription/2",
          name: "growth-monthly",
          status: "ACTIVE",
        },
      },
      "wh_a",
    );
    await send(
      {
        app_subscription: {
          admin_graphql_api_id: "gid://shopify/AppSubscription/2",
          name: "growth-monthly",
          status: "CANCELLED",
        },
      },
      "wh_b",
    );

    expect(await planOf()).toBe("free");
  });

  it("applies a new subscription taking over from the cached one", async () => {
    await installShop(ALPHA);

    await send(
      {
        app_subscription: {
          admin_graphql_api_id: "gid://shopify/AppSubscription/1",
          name: "pro-monthly",
          status: "ACTIVE",
        },
      },
      "wh_a",
    );
    // A different id, but not terminal — this is the upgrade itself.
    await send(
      {
        app_subscription: {
          admin_graphql_api_id: "gid://shopify/AppSubscription/2",
          name: "agentic-annual",
          status: "ACTIVE",
        },
      },
      "wh_b",
    );

    expect(await planOf()).toBe("agentic");
  });

  it("queues the checkout reconcile when, and only when, the plan moved", async () => {
    await installShop(ALPHA);

    await send(
      { app_subscription: { name: "growth-monthly", status: "ACTIVE" } },
      "wh_a",
    );
    expect(
      await inAlpha(() =>
        db.scheduledJob.count({
          where: { kind: "billing.reconcile", status: "PENDING" },
        }),
      ),
    ).toBe(1);

    // The same state again is not news, and must not queue a second sweep.
    await send(
      { app_subscription: { name: "growth-monthly", status: "ACTIVE" } },
      "wh_b",
    );
    expect(
      await inAlpha(() =>
        db.scheduledJob.count({
          where: { kind: "billing.reconcile", status: "PENDING" },
        }),
      ),
    ).toBe(1);
  });
});

/**
 * `billing.check` filters by plan name **and** by test mode, so an empty list
 * is not the same fact as "this shop cancelled". Writing Free on it cut off a
 * paying merchant and erased their grace period, on a page load.
 */
describe("an empty answer from Shopify", () => {
  const paidShop = (extra: Record<string, unknown> = {}) =>
    db.shop.update({
      where: { shop: ALPHA },
      data: {
        planKey: "growth",
        billingStatus: "PAST_DUE",
        subscriptionId: "gid://shopify/AppSubscription/1",
        graceEndsAt: new Date("2026-06-20T12:00:00Z"),
        currentPeriodEnd: new Date("2026-07-01T12:00:00Z"),
        ...extra,
      },
    });

  it("does not cancel the plan or erase the grace period", async () => {
    await installShop(ALPHA);
    await inAlpha(paidShop);

    await inAlpha(() => syncSubscription(billingReturning([]), NOW));

    const shop = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.planKey).toBe("growth");
    expect(shop.graceEndsAt).not.toBeNull();
    // Stamped anyway, so the staleness check does not call Shopify again on
    // every page load for a shop whose config has drifted.
    expect(shop.billingSyncedAt).toEqual(NOW);
  });

  it("writes no audit entry about a change that did not happen", async () => {
    await installShop(ALPHA);
    await inAlpha(paidShop);

    await inAlpha(() => syncSubscription(billingReturning([]), NOW));

    expect(
      await inAlpha(() =>
        db.auditLog.count({ where: { action: "billing.subscription_changed" } }),
      ),
    ).toBe(0);
  });

  it("does trust it once the period the merchant paid for has ended", async () => {
    await installShop(ALPHA);
    // Refusing for ever would keep a shop paid up on a cancellation whose
    // webhook was lost. A period end in the past corroborates the empty answer.
    await inAlpha(() => paidShop({ currentPeriodEnd: new Date("2026-06-01T12:00:00Z") }));

    await inAlpha(() => syncSubscription(billingReturning([]), NOW));

    const shop = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.planKey).toBe("free");
  });

  it("never downgrades on a plan name it does not recognise", async () => {
    await installShop(ALPHA);
    await inAlpha(() => paidShop({ currentPeriodEnd: new Date("2026-06-01T12:00:00Z") }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // Config drift: a live subscription we cannot read. Never a cancellation,
    // whatever the period end says.
    await inAlpha(() =>
      syncSubscription(
        billingReturning([subscription({ name: "enterprise-monthly" })]),
        NOW,
      ),
    );

    const shop = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.planKey).toBe("growth");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
