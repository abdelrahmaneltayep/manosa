import type { SubmissionStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
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
}) {
  const facts = factsFromWebhook({
    admin_graphql_api_id: `gid://shopify/Order/${options.id}`,
    name: `#${options.id}`,
    currency: options.currency ?? "USD",
    processed_at: options.at,
    current_total_price: options.total,
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
      // Both ends inclusive: seven days back from today is eight calendar days.
      expect(data.revenue.wholesale.points).toHaveLength(8);
      expect(data.revenue.wholesale.points.filter((p) => p.value === 0)).toHaveLength(7);
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

  it("takes refunds off, as every other figure in this app does", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const row = await order({ id: 1, at: "2026-09-20T10:00:00Z", total: "100.00" });
      await db.order.update({ where: { id: row.id }, data: { refundedAmount: 4_000 } });

      const data = await load();
      expect(data.revenue.wholesale.total.amount).toBe(6_000);
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
        at: "2026-09-21T10:00:00Z",
        total: "50.00",
        // Sixty days late, not twenty-nine: the bucket boundaries are the
        // point of this chart.
        dueAt: "2026-08-01T00:00:00Z",
      });

      const aging = (await load()).aging;
      expect(aging.find((row) => row.bucket === "current")?.amount.amount).toBe(10_000);
      expect(aging.find((row) => row.bucket === "days_30_plus")?.count).toBe(1);
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
      expect(hasAnyData(await load())).toBe(false);

      await order({ id: 1, at: "2026-09-20T10:00:00Z", total: "100.00" });
      expect(hasAnyData(await load())).toBe(true);
    });
  });

  it("is not offered for a window that is merely quiet", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({ id: 1, at: "2026-09-01T10:00:00Z", total: "100.00" });

      // Nothing in the last seven days, but this shop has history — replacing
      // a quiet fortnight with somebody else's sample numbers would leave the
      // merchant no way to tell the difference.
      const quiet = await load(7);
      expect(quiet.revenue.wholesale.total.amount).toBe(0);
      expect(hasAnyData(await load(90))).toBe(true);
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
