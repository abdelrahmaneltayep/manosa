import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "~/db.server";
import { runDueJobs } from "~/lib/jobs/runner.server";
import { buyerData, redactBuyer } from "~/lib/privacy/buyer-data.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { action as webhookAction } from "~/routes/webhooks.$";
import { prismaBase, resetDatabase } from "../support/db";
import { signedWebhookRequest } from "../support/webhook-request";

/**
 * Shopify's three mandatory privacy topics.
 *
 * Every app in the store must subscribe to all three and answer them, and
 * until the release pass this app subscribed to none. The purge it did have
 * cleared the *merchant's* contact details and left every buyer's behind.
 *
 * So the question each of these asks is the plain one: **after this, is the
 * person actually gone?**
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);

const BUYER = "gid://shopify/Customer/1";
const EMAIL = "dana@acme.test";

const post = (request: Request) =>
  webhookAction({ request, params: {}, context: {} as never });

const deliver = (topic: string, shop: string, payload: Record<string, unknown>) =>
  post(signedWebhookRequest({ topic, shop, webhookId: `wh_${topic}_${shop}`, payload }));

/** Everything one buyer leaves behind, in one shop. */
async function seedBuyer(shop: string, options: { email?: string } = {}) {
  const email = options.email ?? EMAIL;

  await shopScope.run(shop, async () => {
    await db.shop.create({ data: { ...tenant(), email: "owner@" + shop } });

    await db.customer.create({
      data: {
        ...tenant(),
        customerId: BUYER,
        email,
        firstName: "Dana",
        lastName: "Bright",
        company: "Acme Ltd",
        phone: "+44 20 7946 0000",
        vatNumber: "GB123456789",
      },
    });

    const form = await db.registrationForm.create({
      data: {
        ...tenant(),
        name: "Trade application",
        slug: `trade-${shop}`,
        publicId: `form-${shop}`,
        fields: {},
        appearance: {},
        emails: {},
        publish: {},
      },
    });

    const submission = await db.formSubmission.create({
      data: {
        ...tenant(),
        formId: form.id,
        status: "APPROVED",
        email,
        company: "Acme Ltd",
        customerId: BUYER,
        answers: { company: "Acme Ltd", vat: "GB123456789" },
        ip: "203.0.113.7",
      },
    });

    await db.formUpload.create({
      data: {
        ...tenant(),
        submissionId: submission.id,
        fieldKey: "licence",
        fileName: "licence.pdf",
        contentType: "application/pdf",
        byteSize: 5,
        content: Buffer.from("%PDF-"),
      },
    });

    await db.emailMessage.create({
      data: {
        ...tenant(),
        kind: "approved",
        to: email,
        subject: "You're approved",
        body: "Welcome, Dana.",
        submissionId: submission.id,
      },
    });

    await db.order.create({
      data: {
        ...tenant(),
        orderId: `gid://shopify/Order/1-${shop}`,
        name: "#1001",
        customerId: BUYER,
        email,
        company: "Acme Ltd",
        currencyCode: "USD",
        totalPrice: 10_000,
        processedAt: new Date("2026-08-01T00:00:00Z"),
        isWholesale: true,
      },
    });

    const conversation = await db.agentConversation.create({
      data: { ...tenant(), customerId: BUYER, company: "Acme Ltd", locale: "en" },
    });
    await db.agentMessage.create({
      data: {
        ...tenant(),
        conversationId: conversation.id,
        role: "BUYER",
        text: "What's my price on MUG-BL?",
      },
    });
  });
}

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

/* -------------------------------------------------------------------------- */

describe("customers/data_request", () => {
  it("answers with what is held, and never with the contents", async () => {
    await seedBuyer(ALPHA);

    const response = await deliver("customers/data_request", ALPHA, {
      customer: { id: 1, email: EMAIL },
    });
    expect(response.headers.get("X-Mannon-Webhook")).toBe("handled");

    await inAlpha(async () => {
      const entry = await db.auditLog.findFirstOrThrow({
        where: { action: "privacy.data_requested" },
      });

      // Counts and areas, so a merchant knows where to look. The words
      // themselves stay where they are: answering a question about somebody's
      // data by copying it into a log is not an answer.
      expect(entry.summary).toContain("record");
      expect(entry.summary).not.toContain("Dana");
      expect(JSON.stringify(entry.metadata)).not.toContain("Dana");
      expect(JSON.stringify(entry.metadata)).not.toContain("Acme");
    });
  });

  it("says plainly when nothing is held", async () => {
    await shopScope.run(ALPHA, () => db.shop.create({ data: { ...tenant() } }));

    await deliver("customers/data_request", ALPHA, {
      customer: { id: 99, email: "nobody@example.test" },
    });

    await inAlpha(async () => {
      const entry = await db.auditLog.findFirstOrThrow({
        where: { action: "privacy.data_requested" },
      });
      expect(entry.summary).toContain("holds nothing");
    });
  });

  it("finds a buyer who applied but never got an account", async () => {
    await shopScope.run(ALPHA, async () => {
      await db.shop.create({ data: { ...tenant() } });
      const form = await db.registrationForm.create({
        data: {
          ...tenant(),
          name: "Trade application",
          slug: "trade-no-account",
          publicId: "form-no-account",
          fields: {},
          appearance: {},
          emails: {},
          publish: {},
        },
      });
      await db.formSubmission.create({
        data: {
          ...tenant(),
          formId: form.id,
          status: "PENDING",
          // Applied as one case, asked about as another. One person.
          email: "Dana@Acme.test",
          answers: {},
        },
      });
    });

    await inAlpha(async () => {
      const held = await buyerData({ customerId: null, email: "dana@acme.test" });
      expect(held.applications).toHaveLength(1);
    });
  });

  it("reads one shop's records and never another's", async () => {
    await seedBuyer(ALPHA);
    await seedBuyer(BETA);

    await shopScope.run(BETA, async () => {
      const held = await buyerData({ customerId: BUYER, email: EMAIL });
      expect(held.customers).toHaveLength(1);
      expect(held.orders).toHaveLength(1);
      // The same Shopify customer id exists in both shops — it is the same
      // person — and each shop may only ever be told about its own dealings
      // with them.
      expect(
        (held.orders as { orderId: string }[]).every((order) =>
          order.orderId.endsWith(BETA),
        ),
      ).toBe(true);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("customers/redact", () => {
  it("removes the person and leaves the merchant's business record", async () => {
    await seedBuyer(ALPHA);

    await deliver("customers/redact", ALPHA, { customer: { id: 1, email: EMAIL } });

    await inAlpha(async () => {
      // Gone: everything that exists only because of them.
      expect(await db.customer.count()).toBe(0);
      expect(await db.formSubmission.count()).toBe(0);
      expect(await db.formUpload.count()).toBe(0);
      expect(await db.emailMessage.count()).toBe(0);
      expect(await db.agentConversation.count()).toBe(0);
      expect(await db.agentMessage.count()).toBe(0);

      // Kept, with the person taken out: an order is an accounting record the
      // merchant is required to keep, and deleting it would tear a hole in
      // their revenue to satisfy a request the law does not make.
      const order = await db.order.findFirstOrThrow();
      expect(order.totalPrice).toBe(10_000);
      expect(order.email).toBeNull();
      expect(order.company).toBeNull();
      expect(order.customerId).toBeNull();
    });
  });

  it("says what it did, without saying who", async () => {
    await seedBuyer(ALPHA);
    await deliver("customers/redact", ALPHA, { customer: { id: 1, email: EMAIL } });

    await inAlpha(async () => {
      const entry = await db.auditLog.findFirstOrThrow({
        where: { action: "privacy.customer_redacted" },
      });
      expect(entry.summary).toContain("Deleted a buyer's application");
      expect(entry.summary).not.toContain("Dana");
      expect(JSON.stringify(entry.metadata)).not.toContain("dana@acme.test");
    });
  });

  it("is idempotent — Shopify delivers at least once", async () => {
    await seedBuyer(ALPHA);

    await inAlpha(async () => {
      const first = await redactBuyer({ customerId: BUYER, email: EMAIL });
      expect(first.customers).toBe(1);

      const second = await redactBuyer({ customerId: BUYER, email: EMAIL });
      expect(second.customers).toBe(0);
      expect(second.applications).toBe(0);
    });
  });

  it("never reaches into another shop", async () => {
    await seedBuyer(ALPHA);
    await seedBuyer(BETA);

    await deliver("customers/redact", ALPHA, { customer: { id: 1, email: EMAIL } });

    await shopScope.run(BETA, async () => {
      // The same person, another merchant's records. One shop's deletion
      // request is not another shop's.
      expect(await db.customer.count()).toBe(1);
      expect(await db.formSubmission.count()).toBe(1);
      expect((await db.order.findFirstOrThrow()).email).toBe(EMAIL);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("shop/redact", () => {
  it("queues the purge to run now, and the purge reaches the buyers", async () => {
    await seedBuyer(ALPHA);
    await shopScope.run(ALPHA, () =>
      db.shop.update({ where: { shop: ALPHA }, data: { uninstalledAt: new Date() } }),
    );

    await deliver("shop/redact", ALPHA, { shop_domain: ALPHA });
    await runDueJobs();

    await inAlpha(async () => {
      const record = await db.shop.findUniqueOrThrow({ where: { shop: ALPHA } });
      expect(record.piiPurgedAt).toBeInstanceOf(Date);
      expect(record.email).toBeNull();

      // The part that was missing until the release pass: the buyers.
      expect(await db.customer.count()).toBe(0);
      expect(await db.formSubmission.count()).toBe(0);
      expect(await db.formUpload.count()).toBe(0);
      expect(await db.emailMessage.count()).toBe(0);
      expect(await db.order.count()).toBe(0);
      expect(await db.agentConversation.count()).toBe(0);
    });
  });

  it("records a redact for a shop that never looked uninstalled", async () => {
    await shopScope.run(ALPHA, () => db.shop.create({ data: { ...tenant() } }));

    await deliver("shop/redact", ALPHA, { shop_domain: ALPHA });

    await inAlpha(async () => {
      // Believe Shopify — they only send this after an uninstall — but write
      // the disagreement down rather than deleting a live merchant's data on a
      // webhook nobody expected.
      const record = await db.shop.findUniqueOrThrow({ where: { shop: ALPHA } });
      expect(record.uninstalledAt).toBeInstanceOf(Date);
    });
  });

  it("leaves every other shop alone", async () => {
    await seedBuyer(ALPHA);
    await seedBuyer(BETA);
    await shopScope.run(ALPHA, () =>
      db.shop.update({ where: { shop: ALPHA }, data: { uninstalledAt: new Date() } }),
    );

    await deliver("shop/redact", ALPHA, { shop_domain: ALPHA });
    await runDueJobs();

    await shopScope.run(BETA, async () => {
      expect(await db.customer.count()).toBe(1);
      expect(await db.order.count()).toBe(1);
      expect((await db.shop.findUniqueOrThrow({ where: { shop: BETA } })).email).toBe(
        "owner@" + BETA,
      );
    });
  });
});
