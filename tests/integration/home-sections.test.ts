import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { loadActivity } from "~/lib/activity/feed.server";
import { deltaPercent, loadKpis, MIN_HISTORY_DAYS } from "~/lib/analytics/kpis.server";
import {
  confirmEmbed,
  dismissSetup,
  loadSetup,
  reopenSetup,
} from "~/lib/setup/checklist.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * The three things Home says besides the agent: the numbers, the checklist and
 * the feed.
 *
 * All three are claims about the merchant's own shop, which is why they are
 * asserted against real rows rather than against a fixture: a KPI that reads
 * another shop's revenue, or a checklist that ticks a step nobody did, is the
 * kind of wrong nobody notices until it matters.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const NOW = new Date("2026-09-10T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

async function installShop(
  shop: string,
  overrides: { planKey?: string; installedAt?: Date } = {},
) {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        planKey: overrides.planKey ?? "growth",
        billingStatus: "ACTIVE",
        currencyCode: "USD",
        name: "Acme Wholesale",
        installedAt: overrides.installedAt ?? ago(120),
      },
    }),
  );
}

let orderCounter = 0;
const order = (overrides: Record<string, unknown> = {}) =>
  db.order.create({
    data: {
      ...tenant(),
      orderId: `gid://shopify/Order/${(orderCounter += 1)}`,
      name: `#${1000 + orderCounter}`,
      totalPrice: 100_000,
      currencyCode: "USD",
      isWholesale: true,
      processedAt: ago(1),
      createdAt: ago(1),
      ...overrides,
    },
  });

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
  orderCounter = 0;
});

afterAll(async () => {
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */

describe("the KPI cards", () => {
  it("counts this period and the one before it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({ totalPrice: 120_000, createdAt: ago(3) });
      await order({ totalPrice: 80_000, createdAt: ago(10) });
      // Older than both windows.
      await order({ totalPrice: 500_000, createdAt: ago(90) });

      const set = await loadKpis(7, { now: NOW });
      const revenue = set.kpis.find((kpi) => kpi.key === "wholesale_revenue")!;

      expect(revenue.value.value).toEqual({ amount: 120_000, currencyCode: "USD" });
      expect(revenue.value.previous).toEqual({ amount: 80_000, currencyCode: "USD" });
      expect(deltaPercent(120_000, 80_000)).toBe(50);
    });
  });

  it("never adds two currencies together", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({ totalPrice: 100_000, currencyCode: "USD" });
      await order({ totalPrice: 900_000, currencyCode: "EUR" });

      const set = await loadKpis(30, { now: NOW });
      const revenue = set.kpis.find((kpi) => kpi.key === "wholesale_revenue")!;
      // The shop prices in USD. The euro order is not converted, and not summed.
      expect(revenue.value.value).toEqual({ amount: 100_000, currencyCode: "USD" });
    });
  });

  it("leaves out cancelled and retail orders", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({ totalPrice: 100_000 });
      await order({ totalPrice: 400_000, cancelledAt: ago(1) });
      await order({ totalPrice: 700_000, isWholesale: false });

      const set = await loadKpis(30, { now: NOW });
      expect(set.kpis.find((kpi) => kpi.key === "wholesale_orders")!.value.value).toBe(1);
    });
  });

  it("marks the period metrics partial for a shop installed this week", async () => {
    await installShop(ALPHA, { installedAt: ago(2) });

    await inAlpha(async () => {
      const set = await loadKpis(30, { now: NOW });
      expect(set.historyDays).toBeLessThan(MIN_HISTORY_DAYS);
      expect(set.kpis.find((kpi) => kpi.key === "wholesale_revenue")!.partial).toBe(true);
      // A count of what is waiting right now needs no history at all.
      expect(set.kpis.find((kpi) => kpi.key === "pending_approvals")!.partial).toBe(
        false,
      );
    });
  });

  it("owes nothing on terms until an invoice is unpaid and dated", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order({ totalPrice: 100_000, netTermsDueAt: ago(-10), amountPaid: 40_000 });
      // No terms on this one: it is not on the ledger.
      await order({ totalPrice: 300_000 });

      const set = await loadKpis(30, { now: NOW });
      expect(
        set.kpis.find((kpi) => kpi.key === "terms_outstanding")!.value.value,
      ).toEqual({ amount: 60_000, currencyCode: "USD" });
    });
  });

  it("never reads another shop's orders", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    await inBeta(() => order({ totalPrice: 999_000 }));

    await inAlpha(async () => {
      const set = await loadKpis(30, { now: NOW });
      expect(
        set.kpis.find((kpi) => kpi.key === "wholesale_revenue")!.value.value,
      ).toEqual({ amount: 0, currencyCode: "USD" });
    });
  });

  it("hides a delta rather than dividing by nothing", () => {
    expect(deltaPercent(5, 0)).toBeNull();
    expect(deltaPercent(5, null)).toBeNull();
    expect(deltaPercent(5, 4)).toBe(25);
    expect(deltaPercent(3, 4)).toBe(-25);
  });
});

/* -------------------------------------------------------------------------- */

describe("the setup checklist", () => {
  it("starts at one of six on a free plan with nothing done", async () => {
    await installShop(ALPHA, { planKey: "free" });

    await inAlpha(async () => {
      const setup = await loadSetup();
      expect(setup.total).toBe(6);
      expect(setup.done).toBe(0);
      expect(setup.complete).toBe(false);
      expect(setup.items.every((item) => item.href.startsWith("/app"))).toBe(true);
    });
  });

  it("ticks a step because it happened, not because a page was opened", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      expect((await loadSetup()).items.find((item) => item.step === "rule")?.done).toBe(
        false,
      );

      await db.pricingRule.create({
        data: {
          ...tenant(),
          name: "Wholesale 35%",
          kind: "PERCENTAGE",
          status: "ACTIVE",
          value: { percentage: 35 },
          targets: { mode: "all" },
          audience: { mode: "all" },
          markets: { mode: "all", marketIds: [] },
        },
      });

      expect((await loadSetup()).items.find((item) => item.step === "rule")?.done).toBe(
        true,
      );
    });
  });

  it("says the embed is the merchant's word until their storefront calls us", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await confirmEmbed();
      const attested = (await loadSetup()).items.find((item) => item.step === "embed")!;
      expect(attested.done).toBe(true);
      expect(attested.attested).toBe(true);

      await db.shop.update({
        where: { shop: ALPHA },
        data: { storefrontSeenAt: NOW },
      });
      const seen = (await loadSetup()).items.find((item) => item.step === "embed")!;
      expect(seen.done).toBe(true);
      // Observed now, so it stops being a claim about what the merchant said.
      expect(seen.attested).toBe(false);
    });
  });

  it("only stays collapsed while it is actually finished", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await dismissSetup();
      // Nothing is done, so the checklist re-opens on its own — the checklist's
      // own rule about the embed, applied to all six.
      expect((await loadSetup()).dismissed).toBe(false);

      await reopenSetup();
      expect((await loadSetup()).dismissed).toBe(false);
    });
  });

  it("stays collapsed once every step is genuinely done", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await confirmEmbed();
      await db.pricingRule.create({
        data: {
          ...tenant(),
          name: "Wholesale 35%",
          kind: "PERCENTAGE",
          status: "ACTIVE",
          value: { percentage: 35 },
          targets: { mode: "all" },
          audience: { mode: "all" },
          markets: { mode: "all", marketIds: [] },
        },
      });
      await db.registrationForm.create({
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
      await db.customer.create({
        data: {
          ...tenant(),
          customerId: "gid://shopify/Customer/1",
          email: "buyer@acme.test",
          status: "APPROVED",
        },
      });
      await order();

      const before = await loadSetup();
      expect(before.done).toBe(6);
      expect(before.complete).toBe(true);
      expect(before.dismissed).toBe(false);

      await dismissSetup();
      expect((await loadSetup()).dismissed).toBe(true);
    });
  });

  it("never counts another shop's work", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(async () => {
      await db.registrationForm.create({
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
    });

    await inAlpha(async () => {
      expect((await loadSetup()).items.find((item) => item.step === "form")?.done).toBe(
        false,
      );
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("the activity feed", () => {
  const auditRow = (overrides: Record<string, unknown> = {}) =>
    db.auditLog.create({
      data: {
        ...tenant(),
        actorType: "STAFF",
        actorId: "staff-1",
        action: "pricing_rule.created",
        summary: "Created the rule “Wholesale 35%”.",
        ...overrides,
      },
    });

  it("merges the audit log and mirrored orders, newest first", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await auditRow({ createdAt: ago(2) });
      await order({ processedAt: ago(1) });
      await auditRow({
        createdAt: ago(3),
        action: "form.submitted",
        summary: "Applied.",
      });

      const page = await loadActivity({ limit: 8 });
      expect(page.rows).toHaveLength(3);
      expect(page.rows[0]?.kind).toBe("order");
      expect(page.rows[0]?.action).toBe("order.placed");
      expect(page.rows.map((row) => row.at.getTime())).toEqual(
        [...page.rows.map((row) => row.at.getTime())].sort((a, b) => b - a),
      );
    });
  });

  it("chips a row an agent is responsible for", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await auditRow({ actorType: "MERCHANT_AGENT", actorLabel: "Claude" });
      await order({ source: "BUYER_AGENT" });
      await order({ source: "STOREFRONT" });

      const page = await loadActivity({ limit: 8 });
      expect(page.rows.filter((row) => row.agent)).toHaveLength(2);
    });
  });

  it("pages backwards without repeating or skipping a row", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      for (let index = 0; index < 6; index += 1) {
        await auditRow({ createdAt: new Date(NOW.getTime() - index * 60_000) });
      }

      const first = await loadActivity({ limit: 3 });
      expect(first.rows).toHaveLength(3);
      expect(first.nextCursor).not.toBeNull();

      const second = await loadActivity({ limit: 3, before: first.nextCursor });
      const ids = new Set([...first.rows, ...second.rows].map((row) => row.id));
      expect(ids.size).toBe(6);
      expect(second.nextCursor).toBeNull();
    });
  });

  it("filters to one family without inventing rows in it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await auditRow();
      await auditRow({ action: "form.submitted", summary: "Applied." });
      await order();

      expect((await loadActivity({ filter: "pricing" })).rows).toHaveLength(1);
      expect((await loadActivity({ filter: "registrations" })).rows).toHaveLength(1);
      // Orders keep their own rows plus the quote and terms families.
      expect((await loadActivity({ filter: "orders" })).rows).toHaveLength(1);
    });
  });

  it("never shows another shop's activity", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(async () => {
      await auditRow();
      await order();
    });

    await inAlpha(async () => {
      expect((await loadActivity()).rows).toEqual([]);
    });
  });
});
