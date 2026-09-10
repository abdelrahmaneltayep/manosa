import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "~/db.server";
import { action as webhookAction } from "~/routes/webhooks.$";
import { dispatchWebhook } from "~/lib/webhooks/dispatch.server";
import { shopScope, tenant, withoutShopScope } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";
import { signedWebhookRequest } from "../support/webhook-request";

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";

const post = (request: Request) =>
  webhookAction({ request, params: {}, context: {} as never });

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

describe("HMAC verification", () => {
  it("accepts a correctly signed delivery", async () => {
    const response = await post(
      signedWebhookRequest({
        topic: "app/uninstalled",
        shop: ALPHA,
        webhookId: "wh_1",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Mannon-Webhook")).toBe("handled");
  });

  it("rejects a payload whose signature does not match the body", async () => {
    // The signature covers a body with an extra field; the body sent does not
    // have it. This is the forged-delivery case.
    const response = await post(
      signedWebhookRequest({
        topic: "app/uninstalled",
        shop: ALPHA,
        webhookId: "wh_forged",
        tamper: true,
      }),
    ).catch((thrown) => thrown as Response);

    expect(response.status).toBe(401);
    // Nothing was written for the shop the forged request named.
    const shops = await withoutShopScope("test assertion", () =>
      prismaBase.shop.findMany(),
    );
    expect(shops).toHaveLength(0);
  });

  it("rejects a delivery signed with the wrong secret", async () => {
    const response = await post(
      signedWebhookRequest({
        topic: "app/uninstalled",
        shop: ALPHA,
        webhookId: "wh_wrong_secret",
        secret: "not-the-app-secret",
      }),
    ).catch((thrown) => thrown as Response);

    expect(response.status).toBe(401);
  });

  it("does not serve the app shell on GET", async () => {
    const { loader } = await import("~/routes/webhooks.$");
    const response = await loader();
    expect(response.status).toBe(405);
  });
});

describe("delivery records", () => {
  it("records the delivery against the shop that sent it", async () => {
    await post(
      signedWebhookRequest({ topic: "app/uninstalled", shop: ALPHA, webhookId: "wh_1" }),
    );

    const delivery = await shopScope.run(ALPHA, () =>
      db.webhookDelivery.findFirstOrThrow(),
    );
    expect(delivery.webhookId).toBe("wh_1");
    expect(delivery.topic).toBe("APP_UNINSTALLED");
    expect(delivery.handledAt).toBeInstanceOf(Date);
    expect(delivery.attempts).toBe(1);
  });

  it("treats a replay of a handled delivery as a no-op", async () => {
    const first = await post(
      signedWebhookRequest({ topic: "app/uninstalled", shop: ALPHA, webhookId: "wh_1" }),
    );
    const replay = await post(
      signedWebhookRequest({ topic: "app/uninstalled", shop: ALPHA, webhookId: "wh_1" }),
    );

    expect(first.headers.get("X-Mannon-Webhook")).toBe("handled");
    expect(replay.headers.get("X-Mannon-Webhook")).toBe("duplicate");

    // The critical consequence: one purge scheduled, not two.
    const jobs = await shopScope.run(ALPHA, () => db.scheduledJob.findMany());
    expect(jobs.filter((job) => job.status === "PENDING")).toHaveLength(1);
  });

  it("re-runs a delivery whose previous attempt failed", async () => {
    await withoutShopScope("seeding a half-finished delivery", () =>
      prismaBase.webhookDelivery.create({
        data: {
          shop: ALPHA,
          webhookId: "wh_retry",
          topic: "APP_UNINSTALLED",
          attempts: 1,
          lastError: "database was unreachable",
        },
      }),
    );

    const response = await post(
      signedWebhookRequest({
        topic: "app/uninstalled",
        shop: ALPHA,
        webhookId: "wh_retry",
      }),
    );

    expect(response.headers.get("X-Mannon-Webhook")).toBe("handled");
    const delivery = await shopScope.run(ALPHA, () =>
      db.webhookDelivery.findFirstOrThrow(),
    );
    expect(delivery.attempts).toBe(2);
    expect(delivery.handledAt).toBeInstanceOf(Date);
    expect(delivery.lastError).toBeNull();
  });

  it("keeps the same webhook id in two shops apart", async () => {
    await post(
      signedWebhookRequest({
        topic: "app/uninstalled",
        shop: ALPHA,
        webhookId: "wh_same",
      }),
    );
    await post(
      signedWebhookRequest({
        topic: "app/uninstalled",
        shop: BETA,
        webhookId: "wh_same",
      }),
    );

    const alpha = await shopScope.run(ALPHA, () => db.webhookDelivery.findMany());
    const beta = await shopScope.run(BETA, () => db.webhookDelivery.findMany());
    expect(alpha).toHaveLength(1);
    expect(beta).toHaveLength(1);
  });

  it("acknowledges a topic nothing handles rather than making Shopify retry for 48h", async () => {
    const outcome = await dispatchWebhook({
      shop: ALPHA,
      topic: "fulfillments/create",
      webhookId: "wh_unknown",
      payload: {},
    });
    expect(outcome).toEqual({ status: "unhandled-topic", topic: "fulfillments/create" });
  });
});

describe("app/uninstalled", () => {
  it("revokes sessions, tombstones the install and schedules the purge", async () => {
    await withoutShopScope("seeding a live session", () =>
      prismaBase.session.create({
        data: {
          id: "offline_alpha",
          shop: ALPHA,
          state: "",
          isOnline: false,
          accessToken: "shpat_secret",
        },
      }),
    );
    await shopScope.run(ALPHA, () =>
      db.shop.create({ data: { ...tenant(), email: "owner@alpha.test" } }),
    );

    await post(
      signedWebhookRequest({ topic: "app/uninstalled", shop: ALPHA, webhookId: "wh_1" }),
    );

    const sessions = await withoutShopScope("test assertion", () =>
      prismaBase.session.findMany({ where: { shop: ALPHA } }),
    );
    expect(sessions).toHaveLength(0);

    const shop = await shopScope.run(ALPHA, () =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.uninstalledAt).toBeInstanceOf(Date);

    const job = await shopScope.run(ALPHA, () => db.scheduledJob.findFirstOrThrow());
    expect(job.kind).toBe("shop.purge_pii");
    expect(job.status).toBe("PENDING");
    // Inside the 48h GDPR window, with slack for a late runner.
    const hoursOut = (job.runAt.getTime() - Date.now()) / 3_600_000;
    expect(hoursOut).toBeGreaterThan(24);
    expect(hoursOut).toBeLessThan(48);
  });

  it("copes with an uninstall from a shop that never loaded a page", async () => {
    const response = await post(
      signedWebhookRequest({ topic: "app/uninstalled", shop: BETA, webhookId: "wh_2" }),
    );
    expect(response.status).toBe(200);

    const shop = await shopScope.run(BETA, () =>
      db.shop.findUniqueOrThrow({ where: { shop: BETA } }),
    );
    expect(shop.uninstalledAt).toBeInstanceOf(Date);
  });

  it("writes an audit entry the merchant can read later", async () => {
    await post(
      signedWebhookRequest({ topic: "app/uninstalled", shop: ALPHA, webhookId: "wh_1" }),
    );

    const entry = await shopScope.run(ALPHA, () =>
      db.auditLog.findFirstOrThrow({ where: { action: "app.uninstalled" } }),
    );
    expect(entry.actorType).toBe("SYSTEM");
    expect(entry.summary).toContain("scheduled for deletion within 48 hours");
  });

  it("never touches another tenant's data", async () => {
    await withoutShopScope("seeding another shop's session", () =>
      prismaBase.session.create({
        data: {
          id: "offline_beta",
          shop: BETA,
          state: "",
          isOnline: false,
          accessToken: "shpat_beta",
        },
      }),
    );

    await post(
      signedWebhookRequest({ topic: "app/uninstalled", shop: ALPHA, webhookId: "wh_1" }),
    );

    const betaSessions = await withoutShopScope("test assertion", () =>
      prismaBase.session.findMany({ where: { shop: BETA } }),
    );
    expect(betaSessions).toHaveLength(1);

    const betaShop = await shopScope.run(BETA, () =>
      db.shop.findUnique({ where: { shop: BETA } }),
    );
    expect(betaShop).toBeNull();
  });
});
