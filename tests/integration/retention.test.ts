import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "~/db.server";
import {
  EMAIL_RETENTION_MONTHS,
  purgeRetention,
  RETENTION_DAYS,
} from "~/lib/jobs/handlers/purge-retention.server";
import { STATS_WINDOW_DAYS } from "~/lib/forms/forms.server";
import { ARCHIVE_RETENTION_DAYS } from "~/lib/pricing/rules.server";
import { runDueJobs } from "~/lib/jobs/runner.server";
import { shopScope, tenant, withoutShopScope } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";

/**
 * The five tables that only ever grew.
 *
 * Each one had a sentence somewhere saying how long it lived and nothing
 * behind it. So every test here asks the same two questions: does the old row
 * actually go, and is the row a screen still needs still there the day after
 * the window closes?
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);

const NOW = new Date("2026-09-11T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);
const monthsAgo = (months: number) => {
  const at = new Date(NOW);
  at.setUTCMonth(at.getUTCMonth() - months);
  return at;
};

let sequence = 0;

async function seed(shop: string, age: { days: number }) {
  await shopScope.run(shop, async () => {
    sequence += 1;
    const at = daysAgo(age.days);

    await withoutShopScope("a delivery record is written before any tenant exists", () =>
      prismaBase.webhookDelivery.create({
        data: {
          shop,
          webhookId: `wh_${shop}_${sequence}`,
          topic: "ORDERS_CREATE",
          receivedAt: at,
        },
      }),
    );

    const form = await db.registrationForm.create({
      data: {
        ...tenant(),
        name: "Trade application",
        slug: `trade-${shop}-${sequence}`,
        publicId: `form-${shop}-${sequence}`,
        fields: {},
        appearance: {},
        emails: {},
        publish: {},
      },
    });
    await db.formEvent.create({
      data: { ...tenant(), formId: form.id, kind: "VIEW", at },
    });

    await db.ruleImportDraft.create({
      data: { ...tenant(), fileName: "prices.csv", content: "sku,price", createdAt: at },
    });

    await db.pricingRule.create({
      data: {
        ...tenant(),
        name: `Archived ${sequence}`,
        kind: "PERCENTAGE",
        status: "ARCHIVED",
        value: {},
        targets: {},
        audience: {},
        markets: {},
        archivedAt: at,
      },
    });
    // An active rule of the same age, which a retention sweep must never take.
    await db.pricingRule.create({
      data: {
        ...tenant(),
        name: `Active ${sequence}`,
        kind: "PERCENTAGE",
        status: "ACTIVE",
        value: {},
        targets: {},
        audience: {},
        markets: {},
        createdAt: at,
      },
    });

    await db.emailMessage.create({
      data: {
        ...tenant(),
        kind: "approved",
        to: "dana@acme.test",
        subject: "You're approved",
        body: "Welcome.",
        createdAt: at,
      },
    });
  });
}

async function installed(shop: string) {
  await shopScope.run(shop, () => db.shop.create({ data: { ...tenant() } }));
}

beforeEach(async () => {
  await resetDatabase();
  sequence = 0;
});
afterAll(async () => {
  await prismaBase.$disconnect();
});

/* -------------------------------------------------------------------------- */

describe("the retention sweep", () => {
  it("takes everything past its stated window", async () => {
    await installed(ALPHA);
    await seed(ALPHA, { days: 400 });

    const result = await inAlpha(() => purgeRetention({ now: NOW }));
    expect(result).toMatchObject({
      webhookDeliveries: 1,
      formEvents: 1,
      importDrafts: 1,
      archivedRules: 1,
      emails: 1,
    });

    await inAlpha(async () => {
      expect(await db.formEvent.count()).toBe(0);
      expect(await db.ruleImportDraft.count()).toBe(0);
      expect(await db.emailMessage.count()).toBe(0);
      // The active rule of the same age is untouched.
      expect(await db.pricingRule.count()).toBe(1);
      expect((await db.pricingRule.findFirstOrThrow()).status).toBe("ACTIVE");
    });
  });

  it("leaves everything inside its window alone", async () => {
    await installed(ALPHA);
    await seed(ALPHA, { days: 1 });

    const result = await inAlpha(() => purgeRetention({ now: NOW }));
    expect(result).toMatchObject({
      webhookDeliveries: 0,
      formEvents: 0,
      importDrafts: 0,
      archivedRules: 0,
      emails: 0,
    });
  });

  it("keeps the form events the conversion rate is computed from", () => {
    // The forms list shows a conversion percentage over the last 30 days. A
    // retention window shorter than that would make the number quietly wrong
    // rather than obviously missing.
    expect(RETENTION_DAYS.formEvents).toBeGreaterThan(STATS_WINDOW_DAYS);
  });

  it("keeps an archived rule exactly as long as the merchant was told", () => {
    // The audit entry says "can be restored for 30 days". Three places carry
    // that number — the entry, the empty state and this job — and they are one
    // constant.
    expect(RETENTION_DAYS.archivedRules).toBe(ARCHIVE_RETENTION_DAYS);
  });

  it("counts a buyer's messages in calendar months, not 365 days", async () => {
    await installed(ALPHA);
    await inAlpha(async () => {
      await db.emailMessage.create({
        data: {
          ...tenant(),
          kind: "approved",
          to: "dana@acme.test",
          subject: "Old",
          body: "Welcome.",
          // A day inside twelve calendar months, which a fixed 365 would cut.
          createdAt: new Date(monthsAgo(EMAIL_RETENTION_MONTHS).getTime() + DAY),
        },
      });
    });

    await inAlpha(() => purgeRetention({ now: NOW }));
    expect(await inAlpha(() => db.emailMessage.count())).toBe(1);
  });

  it("never reaches another shop's rows", async () => {
    await installed(ALPHA);
    await installed(BETA);
    await seed(ALPHA, { days: 400 });
    await seed(BETA, { days: 400 });

    await inAlpha(() => purgeRetention({ now: NOW }));

    await shopScope.run(BETA, async () => {
      expect(await db.formEvent.count()).toBe(1);
      expect(await db.ruleImportDraft.count()).toBe(1);
      expect(await db.emailMessage.count()).toBe(1);
      expect(await db.pricingRule.count()).toBe(2);
    });
  });

  it("leaves an uninstalled shop to the PII purge", async () => {
    await installed(ALPHA);
    await seed(ALPHA, { days: 400 });
    await inAlpha(() =>
      db.shop.update({ where: { shop: ALPHA }, data: { uninstalledAt: NOW } }),
    );

    expect(await inAlpha(() => purgeRetention({ now: NOW }))).toEqual({
      skipped: "uninstalled",
    });
    expect(await inAlpha(() => db.emailMessage.count())).toBe(1);
  });

  it("queues its next run before it does any work", async () => {
    await installed(ALPHA);
    await seed(ALPHA, { days: 400 });

    await inAlpha(() => purgeRetention({ now: NOW }));

    // The lesson the briefing job learned: returning early before the requeue
    // is how recurring work stops for good.
    const queued = await inAlpha(() =>
      db.scheduledJob.findMany({ where: { kind: "retention.purge", status: "PENDING" } }),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.runAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("runs through the job runner, under the kind the registry knows", async () => {
    await installed(ALPHA);
    await seed(ALPHA, { days: 400 });
    await inAlpha(() =>
      db.scheduledJob.create({
        data: {
          ...tenant(),
          kind: "retention.purge",
          runAt: new Date(NOW.getTime() - DAY),
          status: "PENDING",
        },
      }),
    );

    const result = await runDueJobs();
    expect(result.failed).toBe(0);
    expect(await inAlpha(() => db.emailMessage.count())).toBe(0);
  });
});
