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
