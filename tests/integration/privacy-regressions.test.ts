import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "~/db.server";
import { createForm } from "~/lib/forms/forms.server";
import { DEFAULT_APPEARANCE, DEFAULT_PUBLISH } from "~/lib/forms/appearance";
import { RENDERED_AT_FIELD, submitForm } from "~/lib/forms/submissions.server";
import { runDueJobs } from "~/lib/jobs/runner.server";
import { ensureShopRecord } from "~/lib/shop/ensure-shop.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { action as webhookAction } from "~/routes/webhooks.$";
import { prismaBase, resetDatabase } from "../support/db";
import { signedWebhookRequest } from "../support/webhook-request";

/**
 * The 7.2 cold read's findings, kept as tests.
 *
 * Every one of these failed against `4c84786`, which passed its own gate. Two
 * were the kind that only a stranger finds: `shop/redact` wrote the very
 * `uninstalledAt` the purge checks before deleting, so one delivery for a shop
 * whose uninstall webhook we had missed wiped a live merchant; and a reinstall
 * never cleared `piiPurgedAt`, so a shop that had ever been purged could never
 * be purged again — for ever, silently, under copy promising 48 hours.
 *
 * They stay here rather than folded into `privacy.test.ts` because each names
 * the shape of a bug rather than a feature.
 */

const ALPHA = "alpha.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const BUYER = "gid://shopify/Customer/1";
const EMAIL = "dana@acme.test";

const post = (request: Request) =>
  webhookAction({ request, params: {}, context: {} as never });

const deliver = (
  topic: string,
  shop: string,
  payload: Record<string, unknown>,
  webhookId?: string,
) =>
  post(
    signedWebhookRequest({
      topic,
      shop,
      webhookId: webhookId ?? `wh_${topic}_${shop}_${Math.random()}`,
      payload,
    }),
  );

async function seedTrading(shop: string) {
  await shopScope.run(shop, async () => {
    await db.shop.create({
      data: {
        ...tenant(),
        planKey: "pro",
        billingStatus: "ACTIVE",
        email: "owner@" + shop,
      },
    });
    await db.customer.create({
      data: {
        ...tenant(),
        customerId: BUYER,
        email: EMAIL,
        firstName: "Dana",
        company: "Acme Ltd",
      },
    });
    await db.order.create({
      data: {
        ...tenant(),
        orderId: `gid://shopify/Order/1-${shop}`,
        name: "#1001",
        customerId: BUYER,
        email: EMAIL,
        currencyCode: "USD",
        totalPrice: 10_000,
        processedAt: new Date("2026-08-01T00:00:00Z"),
      },
    });
  });
}

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

describe("P0-1 shop/redact on a shop that is installed and trading", () => {
  it("must not destroy a live merchant's data", async () => {
    await seedTrading(ALPHA);

    // No uninstall has ever been recorded for this shop: it is open for
    // business. One shop/redact delivery (a replay, a Shopify bug, or a
    // reinstall inside the 48h window) is all it takes.
    await deliver("shop/redact", ALPHA, { shop_domain: ALPHA });
    await runDueJobs();

    await inAlpha(async () => {
      expect(await db.customer.count()).toBe(1);
      expect(await db.order.count()).toBe(1);
      const record = await db.shop.findUniqueOrThrow({ where: { shop: ALPHA } });
      expect(record.piiPurgedAt).toBeNull();
    });
  });
});

describe("P0-2 uninstall → reinstall → uninstall", () => {
  it("purges the second time too", async () => {
    await seedTrading(ALPHA);

    // 1. First uninstall, purge runs.
    await deliver("app/uninstalled", ALPHA, { domain: ALPHA });
    await inAlpha(() =>
      db.scheduledJob.updateMany({
        where: { kind: "shop.purge_pii" },
        data: { runAt: new Date(Date.now() - 1000) },
      }),
    );
    await runDueJobs();

    // 2. Reinstall: the merchant comes back and trades for a year.
    await inAlpha(() => ensureShopRecord());
    await inAlpha(async () => {
      await db.customer.create({
        data: { ...tenant(), customerId: BUYER, email: EMAIL, firstName: "Dana" },
      });
      await db.order.create({
        data: {
          ...tenant(),
          orderId: "gid://shopify/Order/2",
          name: "#1002",
          customerId: BUYER,
          email: EMAIL,
          totalPrice: 5_000,
          processedAt: new Date("2027-01-01T00:00:00Z"),
        },
      });
    });

    // 3. They uninstall again. The 48-hour promise applies again.
    await deliver("app/uninstalled", ALPHA, { domain: ALPHA }, "wh_uninstall_2");
    await inAlpha(() =>
      db.scheduledJob.updateMany({
        where: { kind: "shop.purge_pii", status: "PENDING" },
        data: { runAt: new Date(Date.now() - 1000) },
      }),
    );
    await runDueJobs();

    await inAlpha(async () => {
      expect(await db.customer.count()).toBe(0);
      expect(await db.order.count()).toBe(0);
    });
  });
});

describe("P0-3 customers/redact and the audit log", () => {
  it("leaves no trace of the person in AuditLog", async () => {
    await inAlpha(async () => {
      await db.shop.create({
        data: { ...tenant(), planKey: "pro", billingStatus: "ACTIVE" },
      });
      const created = await createForm(
        {
          name: "Wholesale application",
          definition: {
            v: 1,
            fields: [
              {
                key: "first_name",
                kind: "text",
                label: "First name",
                required: true,
                showWhen: null,
              },
              {
                key: "email",
                kind: "email",
                label: "Email",
                required: true,
                showWhen: null,
              },
              {
                key: "company",
                kind: "company",
                label: "Company",
                required: true,
                showWhen: null,
              },
              {
                key: "privacy",
                kind: "privacy",
                label: "Privacy",
                required: true,
                showWhen: null,
              },
            ],
          },
          appearance: { ...DEFAULT_APPEARANCE },
          emails: {
            confirmation: { subject: "Got it", body: "Hi {{first_name}}" },
            approved: { subject: "Welcome", body: "You are in" },
            rejected: { subject: "Sorry", body: "Not this time" },
            needs_info: { subject: "One more thing", body: "We need {{reason}}" },
          },
          publish: { ...DEFAULT_PUBLISH },
        },
        { type: "STAFF" as const, id: "staff-1" },
      );
      const form = await db.registrationForm.update({
        where: { id: created.id },
        data: { status: "LIVE" },
      });

      // The production writer, not a fixture.
      await submitForm({
        form,
        answers: {
          first_name: "Dana",
          email: EMAIL,
          company: "Acme Ltd",
          privacy: "yes",
          [RENDERED_AT_FIELD]: String(Date.now() - 30_000),
        },
        files: [],
        headers: new Headers({
          "x-forwarded-for": "203.0.113.7",
          "user-agent": "Mozilla/5.0",
        }),
      });
    });

    await deliver("customers/redact", ALPHA, { customer: { id: 1, email: EMAIL } });

    await inAlpha(async () => {
      const rows = await db.auditLog.findMany();
      const blob = JSON.stringify(rows);
      expect(blob).not.toContain(EMAIL);
      expect(blob).not.toContain("203.0.113.7");
    });
  });
});

describe("P1-4 a buyer's own words on a quote", () => {
  it("goes with them", async () => {
    await seedTrading(ALPHA);
    await inAlpha(() =>
      db.quote.create({
        data: {
          ...tenant(),
          publicId: "q-1",
          number: "Q-1001",
          customerId: BUYER,
          email: EMAIL,
          company: "Acme Ltd",
          // `Quote.requestNote` — "What the buyer asked for, in their words."
          requestNote:
            "Dana Bright, 12 Mill Lane, Leeds LS1 1AA — please call me on +44 7700 900123.",
          internalNote: "Dana's brother runs our Leeds account.",
        },
      }),
    );

    await deliver("customers/redact", ALPHA, { customer: { id: 1, email: EMAIL } });

    await inAlpha(async () => {
      const quote = await db.quote.findFirstOrThrow();
      expect(quote.requestNote).toBeNull();
      expect(quote.internalNote).toBeNull();
    });
  });
});

describe("P1-5 BlockedDomain and the 48-hour promise", () => {
  it("is deleted by the shop purge, as its written excuse claims", async () => {
    await seedTrading(ALPHA);
    await inAlpha(async () => {
      await db.blockedDomain.create({
        data: { ...tenant(), domain: "dana-bright.example", reason: "Dana asked us to" },
      });
      await db.shop.update({
        where: { shop: ALPHA },
        data: { uninstalledAt: new Date() },
      });
    });

    await deliver("shop/redact", ALPHA, { shop_domain: ALPHA });
    await runDueJobs();

    await inAlpha(async () => {
      expect(await db.blockedDomain.count()).toBe(0);
    });
  });
});
