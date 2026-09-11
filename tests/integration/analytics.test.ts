import type { SubmissionStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { summariseAging } from "@mannon/net-terms";

import { db } from "~/db.server";
import { toInvoice } from "~/lib/terms/terms.server";
import { loadAnalytics } from "~/lib/analytics/charts.server";
import { hasAnyData } from "~/lib/analytics/view-model.server";
import { upsertOrder, factsFromWebhook } from "~/lib/orders/sync.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * The six charts, against a real database.
 *
 * The question every one of these asks: could a merchant read this page and
 * come away believing something untrue? Money in a currency this shop does not
 * sell in, a refunded line still counted, another shop's orders, a funnel with
 * more approvals than applications, or a day in the wrong week.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const NOW = new Date("2026-09-30T12:00:00Z");
const labels = {
  rest: "Everyone else",
  retail: "Retail",
  ungrouped: "No group",
  unnamedBuyer: "Unnamed",
};

const load = (range: 7 | 30 | 90 = 30) => loadAnalytics({ range, now: NOW, labels });

async function installShop(shop: string, overrides: Record<string, unknown> = {}) {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        currencyCode: "USD",
        ianaTimezone: "UTC",
        installedAt: new Date("2026-01-01T00:00:00Z"),
        ...overrides,
      },
    }),
  );
}

/** One mirrored order, through the real writer so the lines are real too. */
async function order(options: {
  id: number;
  at: string;
  total: string;
  wholesale?: boolean;
  currency?: string;
  customerId?: string;
  company?: string;
  lines?: Record<string, unknown>[];
  dueAt?: string;
  refunds?: Record<string, unknown>[];
  cancelled?: boolean;
}) {
  const facts = factsFromWebhook({
    admin_graphql_api_id: `gid://shopify/Order/${options.id}`,
    name: `#${options.id}`,
    currency: options.currency ?? "USD",
    processed_at: options.at,
    current_total_price: options.total,
    ...(options.refunds ? { refunds: options.refunds } : {}),
    ...(options.cancelled ? { cancelled_at: options.at } : {}),
    customer: options.customerId
      ? { id: Number(options.customerId.split("/").pop()) }
      : null,
    discount_applications: [{ title: "Café trade price" }],
    line_items: options.lines ?? [
      {
        admin_graphql_api_id: `gid://shopify/LineItem/${options.id}`,
        title: "House Blend 1kg",
        product_id: 1,
        quantity: 10,
        current_quantity: 10,
        price: "10.00",
        discount_allocations: [{ amount: "35.00", discount_application_index: 0 }],
      },
    ],
  })!;

  return upsertOrder(
    { ...facts, company: options.company ?? null },
    options.wholesale ?? true,
    {
      ...(options.dueAt ? { netTermsDueAt: new Date(options.dueAt) } : {}),
    },
  );
}

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
});
afterAll(resetDatabase);

/* -------------------------------------------------------------------------- */

describe("revenue over time", () => {
  it("separates wholesale from retail, and totals each", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({ id: 1, at: "2026-09-20T10:00:00Z", total: "100.00" });
      await order({
        id: 2,
        at: "2026-09-21T10:00:00Z",
        total: "50.00",
        wholesale: false,
      });

      const data = await load();
      expect(data.revenue.wholesale.total.amount).toBe(10_000);
      expect(data.revenue.retail.total.amount).toBe(5_000);
    });
  });

  it("keeps a day with nothing in it, so a quiet week reads as quiet", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({ id: 1, at: "2026-09-28T10:00:00Z", total: "100.00" });

      const data = await load(7);
      // "Last 7 days" is seven whole store-local days, today included. The
      // version this replaced produced eight buckets whose first was a part
      // day drawn at full width, so the first and last bar of every window
      // systematically under-reported.
      expect(data.revenue.wholesale.points).toHaveLength(7);
      expect(data.revenue.wholesale.points.filter((p) => p.value === 0)).toHaveLength(6);
    });
  });

  it("buckets into the store's own day, not the server's", async () => {
    await installShop(ALPHA, { ianaTimezone: "Australia/Sydney" });

    await inAlpha(async () => {
      // 8pm UTC on the 20th is 6am on the 21st in Sydney.
      await order({ id: 1, at: "2026-09-20T20:00:00Z", total: "100.00" });

      const data = await load();
      const sold = data.revenue.wholesale.points.find((point) => point.value > 0);
      expect(sold?.day).toBe("2026-09-21");
    });
  });

  it("counts a refunded order once, the way Shopify already counted it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      // Written through the real webhook writer, because `current_total_price`
      // is *already* net of the refund — the previous version of this test
      // hand-set `refundedAmount` onto a row carrying a gross `totalPrice`,
      // a combination the writer cannot produce, so it could not fail.
      await order({
        id: 1,
        at: "2026-09-20T10:00:00Z",
        total: "60.00",
        refunds: [{ transactions: [{ amount: "40.00", kind: "refund" }] }],
      });

      const stored = await db.order.findFirstOrThrow();
      expect(stored.totalPrice).toBe(6_000);
      expect(stored.refundedAmount).toBe(4_000);

      // One number, matching the Orders list and the Home KPI card.
      expect((await load()).revenue.wholesale.total.amount).toBe(6_000);
    });
  });

  it("ignores an order outside the window rather than piling it on the edge", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({ id: 1, at: "2026-06-01T10:00:00Z", total: "999.00" });
      expect((await load()).revenue.wholesale.total.amount).toBe(0);
    });
  });
});

describe("money this page cannot add up", () => {
  it("counts an order in another currency, and never folds it in", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({ id: 1, at: "2026-09-20T10:00:00Z", total: "100.00" });
      await order({ id: 2, at: "2026-09-21T10:00:00Z", total: "80.00", currency: "EUR" });

      const data = await load();
      // Adding two currencies produces a third number that is not money.
      expect(data.revenue.wholesale.total.amount).toBe(10_000);
      expect(data.excludedOrders).toBe(1);
    });
  });

  it("says how many orders arrived with more lines than Shopify returned", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const row = await order({ id: 1, at: "2026-09-20T10:00:00Z", total: "100.00" });
      await db.order.update({ where: { id: row.id }, data: { linesTruncated: true } });

      expect((await load()).ordersMissingLines).toBe(1);
    });
  });
});

describe("the ranked charts", () => {
  it("groups revenue by the buyer's group, and names the ungrouped", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const group = await db.customerGroup.create({
        data: { ...tenant(), name: "Cafés", handle: "cafes", tag: "cafes" },
      });
      await db.customer.create({
        data: {
          ...tenant(),
          customerId: "gid://shopify/Customer/1",
          email: "one@acme.test",
          status: "APPROVED",
          currencyCode: "USD",
          groupId: group.id,
        },
      });

      await order({
        id: 1,
        at: "2026-09-20T10:00:00Z",
        total: "100.00",
        customerId: "gid://shopify/Customer/1",
      });
      await order({
        id: 2,
        at: "2026-09-21T10:00:00Z",
        total: "60.00",
        customerId: "gid://shopify/Customer/2",
      });

      const rows = (await load()).byGroup;
      expect(rows.find((row) => row.label === "Cafés")?.value).toBe(10_000);
      // A wholesale buyer in no group is still wholesale revenue; dropping
      // them would make this chart disagree with the total above it.
      expect(rows.find((row) => row.label === "No group")?.value).toBe(6_000);
    });
  });

  it("ranks products from the mirrored lines", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({ id: 1, at: "2026-09-20T10:00:00Z", total: "100.00" });

      const [top] = (await load()).topProducts;
      expect(top?.label).toBe("House Blend 1kg");
      expect(top?.value).toBe(6_500);
    });
  });

  it("does not count a line the buyer sent back", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({
        id: 1,
        at: "2026-09-20T10:00:00Z",
        total: "0.00",
        lines: [
          {
            admin_graphql_api_id: "gid://shopify/LineItem/1",
            title: "House Blend 1kg",
            product_id: 1,
            quantity: 10,
            current_quantity: 0,
            price: "10.00",
          },
        ],
      });

      const data = await load();
      expect(data.topProducts[0]?.value ?? 0).toBe(0);
      // And the rule that priced it earned nothing either.
      expect(data.rules).toEqual([]);
    });
  });
});

describe("rule performance", () => {
  it("reads the name the buyer saw, and says when no rule has it now", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({ id: 1, at: "2026-09-20T10:00:00Z", total: "100.00" });

      const [before] = (await load()).rules;
      expect(before?.label).toBe("Café trade price");
      expect(before?.lines).toBe(1);
      expect(before?.discounted).toBe(3_500);
      // No rule by that name exists in this shop yet.
      expect(before?.stillExists).toBe(false);

      await db.pricingRule.create({
        data: {
          ...tenant(),
          name: "Café trade price",
          status: "ACTIVE",
          kind: "PERCENTAGE",
          value: { percentage: 35 },
          targets: { mode: "all" },
          audience: { mode: "all" },
          markets: { mode: "all", marketIds: [] },
        },
      });

      expect((await load()).rules[0]?.stillExists).toBe(true);
    });
  });
});

describe("whole days", () => {
  it("starts a window at a store-local midnight, whatever the zone", async () => {
    await installShop(ALPHA, { ianaTimezone: "Australia/Sydney" });

    await inAlpha(async () => {
      const data = await load(7);
      expect(data.revenue.wholesale.points).toHaveLength(7);
      // The first bucket is a whole day, so the day it names begins at the
      // merchant's midnight rather than seven days ago to the second.
      expect(data.window.start.toISOString()).toBe("2026-09-23T14:00:00.000Z");
    });
  });

  it("counts an order at the very start of the first day", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      // 00:30 on the first day of the window. Under the old start — seven
      // days back to the second, i.e. midday — this order fell outside the
      // window while its day still got a full-width bar.
      await order({ id: 1, at: "2026-09-24T00:30:00Z", total: "100.00" });

      const data = await load(7);
      expect(data.revenue.wholesale.total.amount).toBe(10_000);
    });
  });
});

describe("the registration funnel", () => {
  it("follows one cohort through, so it can never widen", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const form = await db.registrationForm.create({
        data: {
          ...tenant(),
          name: "Trade",
          slug: "trade",
          status: "LIVE",
          fields: [],
          appearance: {},
          emails: {},
          publish: {},
        },
      });
      const submission = (
        status: SubmissionStatus,
        customerId: string | null,
        at: string,
      ) =>
        db.formSubmission.create({
          data: {
            ...tenant(),
            formId: form.id,
            status,
            customerId,
            email: `${status}-${at}@acme.test`,
            answers: {},
            createdAt: new Date(at),
          },
        });

      await submission("PENDING", null, "2026-09-20T10:00:00Z");
      await submission("APPROVED", "gid://shopify/Customer/1", "2026-09-21T10:00:00Z");
      await submission("APPROVED", "gid://shopify/Customer/2", "2026-09-22T10:00:00Z");
      // An approval from *before* the window: counting it here would show more
      // approvals than applications.
      await submission("APPROVED", "gid://shopify/Customer/9", "2026-01-02T10:00:00Z");

      await order({
        id: 1,
        at: "2026-09-25T10:00:00Z",
        total: "100.00",
        customerId: "gid://shopify/Customer/1",
      });
      // A cancelled order from before they ever applied. Counting it made the
      // page claim this application converted.
      await order({
        id: 2,
        at: "2026-09-02T10:00:00Z",
        total: "70.00",
        customerId: "gid://shopify/Customer/2",
        cancelled: true,
      });

      const funnel = (await load()).funnel;
      expect(funnel).toEqual([
        { key: "submitted", value: 3 },
        { key: "approved", value: 2 },
        { key: "ordered", value: 1 },
      ]);
      expect(funnel[1]!.value).toBeLessThanOrEqual(funnel[0]!.value);
    });
  });
});

describe("the aging report", () => {
  it("buckets what is owed by how late it is", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({
        id: 1,
        at: "2026-09-20T10:00:00Z",
        total: "100.00",
        dueAt: "2026-10-30T00:00:00Z",
      });
      await order({
        id: 2,
        at: "2026-08-16T10:00:00Z",
        total: "50.00",
        dueAt: "2026-08-21T00:00:00Z",
      });

      const aging = (await load()).aging;
      expect(aging.find((row) => row.bucket === "current")?.amount.amount).toBe(10_000);
      expect(aging.find((row) => row.bucket === "days_30_plus")?.count).toBe(1);
    });
  });

  it("is as of today, not as of the window", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      // A genuinely old invoice, issued long before any window the page
      // offers. Windowing this chart hid $1,400 of overdue money behind
      // "Nothing in this window", and made the worst bucket mathematically
      // unreachable — only an order due before it was placed could fill it.
      await order({
        id: 1,
        at: "2026-05-01T10:00:00Z",
        total: "900.00",
        dueAt: "2026-06-01T00:00:00Z",
      });

      const aging = (await load(7)).aging;
      expect(aging.find((row) => row.bucket === "days_30_plus")?.amount.amount).toBe(
        90_000,
      );
    });
  });

  it("agrees with the ledger, invoice for invoice", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({
        id: 1,
        at: "2026-08-16T10:00:00Z",
        total: "500.00",
        dueAt: "2026-09-15T00:00:00Z",
      });
      await order({
        id: 2,
        at: "2026-06-22T10:00:00Z",
        total: "900.00",
        dueAt: "2026-07-22T00:00:00Z",
      });

      const owing = await db.order.findMany({
        where: { isWholesale: true, paidAt: null, netTermsDueAt: { not: null } },
      });
      const ledger = summariseAging(owing.map(toInvoice), NOW, "USD");
      const aging = (await load()).aging;

      for (const bucket of ledger.buckets) {
        const chart = aging.find((row) => row.bucket === bucket.bucket);
        expect(chart?.amount.amount).toBe(bucket.outstanding.amount);
        expect(chart?.count).toBe(bucket.invoiceCount);
      }
    });
  });
});

describe("what the page marks", () => {
  it("marks the install and the day the agent went live", async () => {
    await installShop(ALPHA, { installedAt: new Date("2026-09-10T10:00:00Z") });

    await inAlpha(async () => {
      await db.agentGuardrails.create({
        data: {
          ...tenant(),
          offLimits: [],
          published: true,
          publishedAt: new Date("2026-09-15T10:00:00Z"),
        },
      });

      const marks = (await load()).annotations;
      expect(marks).toEqual([
        { key: "installed", day: "2026-09-10" },
        { key: "agent_published", day: "2026-09-15" },
      ]);
    });
  });

  it("marks nothing that happened outside the window", async () => {
    await installShop(ALPHA, { installedAt: new Date("2026-01-01T00:00:00Z") });
    await inAlpha(async () => {
      expect((await load(7)).annotations).toEqual([]);
    });
  });

  it("says a shop is too new for a trend line", async () => {
    await installShop(ALPHA, { installedAt: new Date("2026-09-28T00:00:00Z") });
    await inAlpha(async () => {
      const data = await load();
      expect(data.window.partial).toBe(true);
      expect(data.window.historyDays).toBe(2);
    });
  });
});

describe("the example state", () => {
  it("is offered only to a shop that has never had anything", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      expect(await hasAnyData(await load())).toBe(false);

      await order({ id: 1, at: "2026-09-20T10:00:00Z", total: "100.00" });
      expect(await hasAnyData(await load())).toBe(true);
    });
  });

  it("is not offered for a window that is merely quiet", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({ id: 1, at: "2026-09-01T10:00:00Z", total: "100.00" });

      // Nothing in the last seven days, but this shop has history. The
      // previous version of this test asserted against a *different* window
      // than the one it set up, so it never checked the thing it was named
      // for — and production passes the window-scoped data.
      const quiet = await load(7);
      expect(quiet.revenue.wholesale.total.amount).toBe(0);
      expect(await hasAnyData(quiet)).toBe(true);
    });
  });

  it("is not offered to a shop whose window is only in another currency", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({
        id: 1,
        at: "2026-09-20T10:00:00Z",
        total: "80.00",
        currency: "EUR",
      });

      // Revenue is zero and there is a banner saying why. Replacing the page
      // with an example deletes the one true sentence on it.
      const data = await load();
      expect(data.excludedOrders).toBe(1);
      expect(await hasAnyData(data)).toBe(true);
    });
  });
});

describe("another shop's numbers", () => {
  it("never reach this one", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(async () => {
      await order({ id: 1, at: "2026-09-20T10:00:00Z", total: "999.00" });
    });

    await inAlpha(async () => {
      const data = await load();
      expect(data.revenue.wholesale.total.amount).toBe(0);
      expect(data.topProducts).toEqual([]);
      expect(data.rules).toEqual([]);
      expect(data.byGroup).toEqual([]);
    });
  });
});
