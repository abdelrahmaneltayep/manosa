import { money, zero } from "@mannon/pricing-engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { FeatureLockedError } from "~/lib/billing/gate.server";
import { setTerms } from "~/lib/customers/customers.server";
import {
  applyTermsToOrder,
  parseAmount,
  PaymentError,
  paymentsFor,
  publishBuyerTerms,
  recordPayment,
} from "~/lib/terms/ledger.server";
import { ledgerPage } from "~/lib/terms/ledger-query.server";
import { canRemind, ReminderError, sendReminder } from "~/lib/terms/reminders.server";
import { publishTermsSettings, saveTermsSettings } from "~/lib/terms/settings.server";
import { ledgerFor, termsFor, termsAreOverridden } from "~/lib/terms/terms.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { handleOrdersUpsert } from "~/lib/webhooks/handlers/orders-upsert.server";
import { resetDatabase } from "../support/db";

/**
 * Net terms end to end: who gets them, what they owe, and what checkout is told.
 *
 * The eligibility and aging rules themselves are `packages/net-terms`' business
 * and are tested there. These tests are about the wiring: the right rows, the
 * right metafield, and the boundary between two shops.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const NOW = new Date("2026-09-10T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const daysAhead = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const actor = { type: "STAFF" as const, id: "staff-1" };

interface AdminCall {
  query: string;
  variables: Record<string, unknown>;
}

function fakeAdmin() {
  const calls: AdminCall[] = [];
  const admin: AdminGraphql & { calls: AdminCall[] } = {
    calls,
    graphql: vi.fn(
      async (query: string, options?: { variables?: Record<string, unknown> }) => {
        calls.push({ query, variables: options?.variables ?? {} });
        const data = query.includes("MannonShopId")
          ? { shop: { id: "gid://shopify/Shop/42" } }
          : query.includes("TagsAdd")
            ? { tagsAdd: { userErrors: [] } }
            : { metafieldsSet: { metafields: [{ id: "gid://mf/1" }], userErrors: [] } };
        return { json: async () => ({ data }) };
      },
    ),
  };
  return admin;
}

const queried = (admin: { calls: AdminCall[] }, name: string) =>
  admin.calls.filter((call) => call.query.includes(name));

/** The buyer facts the last publish wrote. */
function lastBuyerFacts(admin: { calls: AdminCall[] }) {
  const calls = queried(admin, "MannonSetBuyerFacts");
  const last = calls[calls.length - 1];
  if (!last) return null;
  const metafields = last.variables.metafields as { value: string }[];
  return JSON.parse(metafields[0]!.value) as {
    tags: string[];
    groupIds: string[];
    terms: {
      days: number;
      creditLimit: number | null;
      outstanding: number;
      overdueCount: number;
    } | null;
  };
}

async function installShop(shop: string, planKey = "growth") {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        planKey,
        billingStatus: "ACTIVE",
        currencyCode: "USD",
        ordersBackfilledAt: NOW,
        customersBackfilledAt: NOW,
      },
    }),
  );
}

const seedGroup = (overrides: Record<string, unknown> = {}) =>
  db.customerGroup.create({
    data: {
      ...tenant(),
      name: "Gold",
      handle: "gold",
      tag: "gold",
      netTermsDays: 30,
      ...overrides,
    },
  });

const seedBuyer = (overrides: Record<string, unknown> = {}) =>
  db.customer.create({
    data: {
      ...tenant(),
      customerId: "gid://shopify/Customer/77",
      email: "buyer@acme.test",
      company: "Acme Ltd",
      tags: ["wholesale"],
      currencyCode: "USD",
      ...overrides,
    },
    include: { group: true },
  });

const seedOrder = (overrides: Record<string, unknown> = {}) =>
  db.order.create({
    data: {
      ...tenant(),
      orderId: `gid://shopify/Order/${Math.random().toString(36).slice(2)}`,
      name: "#1001",
      customerId: "gid://shopify/Customer/77",
      email: "buyer@acme.test",
      company: "Acme Ltd",
      financialStatus: "pending",
      totalPrice: 100000,
      subtotalPrice: 100000,
      currencyCode: "USD",
      isWholesale: true,
      processedAt: daysAgo(10),
      netTermsDays: 30,
      netTermsDueAt: daysAhead(20),
      ...overrides,
    },
  });

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */
/* Whose terms apply                                                           */
/* -------------------------------------------------------------------------- */

describe("termsFor", () => {
  it("takes a group's terms when the buyer has none of their own", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const group = await seedGroup();
      const buyer = await seedBuyer({ groupId: group.id });

      expect(termsFor(buyer, "USD")).toMatchObject({ days: 30, source: "group" });
      expect(termsAreOverridden(buyer)).toBe(false);
    });
  });

  it("takes the buyer's own, and flags the override", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const group = await seedGroup();
      const buyer = await seedBuyer({ groupId: group.id, netTermsDays: 60 });

      expect(termsFor(buyer, "USD")).toMatchObject({ days: 60, source: "customer" });
      expect(termsAreOverridden(buyer)).toBe(true);
    });
  });

  it("resolves a credit limit in the store's currency", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const group = await seedGroup({ creditLimit: 500000 });
      const buyer = await seedBuyer({ groupId: group.id });

      expect(termsFor(buyer, "USD")?.creditLimit).toEqual(money(500000, "USD"));
    });
  });
});

describe("setTerms", () => {
  it("publishes the change so checkout agrees with the admin", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const buyer = await seedBuyer();
      await setTerms(
        buyer.id,
        { netTermsDays: 45, creditLimit: 250000 },
        { admin, actor },
      );

      const facts = lastBuyerFacts(admin);
      expect(facts?.terms).toMatchObject({ days: 45, creditLimit: 250000 });
    });
  });

  it("clearing a buyer's own terms hands them back to their group", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const group = await seedGroup();
      const buyer = await seedBuyer({ groupId: group.id, netTermsDays: 60 });
      await setTerms(
        buyer.id,
        { netTermsDays: null, creditLimit: null },
        { admin, actor },
      );

      expect(lastBuyerFacts(admin)?.terms).toMatchObject({ days: 30 });
    });
  });

  it("is gated on the plan, server-side", async () => {
    await installShop(ALPHA, "free");
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const buyer = await seedBuyer();
      await expect(
        setTerms(buyer.id, { netTermsDays: 30, creditLimit: null }, { admin, actor }),
      ).rejects.toBeInstanceOf(FeatureLockedError);
    });
  });

  it("never withdraws terms as a side effect of another change", async () => {
    // The hazard the required `terms` field guards: publishing buyer facts
    // without them tells checkout the buyer has none.
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const group = await seedGroup();
      const buyer = await seedBuyer({ groupId: group.id });
      await publishBuyerTerms(admin, buyer);

      expect(lastBuyerFacts(admin)?.terms).toMatchObject({ days: 30 });
      expect(lastBuyerFacts(admin)?.tags).toEqual(["wholesale"]);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Invoices                                                                    */
/* -------------------------------------------------------------------------- */

describe("putting an order on terms", () => {
  it("stamps the days and the due date when a buyer on terms checks out", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const group = await seedGroup();
      await seedBuyer({ groupId: group.id });

      await handleOrdersUpsert(
        {
          shop: ALPHA,
          topic: "orders/create",
          webhookId: "w1",
          payload: {
            id: 5001,
            admin_graphql_api_id: "gid://shopify/Order/5001",
            name: "#1001",
            email: "buyer@acme.test",
            currency: "USD",
            financial_status: "pending",
            source_name: "web",
            current_total_price: "1000.00",
            processed_at: NOW.toISOString(),
            customer: { id: 77 },
            line_items: [{ quantity: 10 }],
          },
        },
        async () => admin,
      );

      const order = await db.order.findFirstOrThrow();
      expect(order.netTermsDays).toBe(30);
      expect(order.netTermsDueAt?.toISOString()).toBe("2026-10-10T12:00:00.000Z");
    });
  });

  it("keeps the terms an invoice was raised under when the buyer's change", async () => {
    // The checklist's edge: "terms changed mid-outstanding-invoice → applies to
    // new orders only".
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const group = await seedGroup();
      const buyer = await seedBuyer({ groupId: group.id });
      const order = await seedOrder();

      await setTerms(buyer.id, { netTermsDays: 90, creditLimit: null }, { admin, actor });
      // Re-applying must not move a date the buyer has already been told.
      expect(await applyTermsToOrder(order, 90)).toBeNull();

      const unchanged = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(unchanged.netTermsDays).toBe(30);
      expect(unchanged.netTermsDueAt?.toISOString()).toBe(daysAhead(20).toISOString());
    });
  });

  it("does not put a buyer with no terms on terms", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await handleOrdersUpsert(
        {
          shop: ALPHA,
          topic: "orders/create",
          webhookId: "w1",
          payload: {
            admin_graphql_api_id: "gid://shopify/Order/5001",
            name: "#1001",
            currency: "USD",
            current_total_price: "1000.00",
            processed_at: NOW.toISOString(),
            customer: { id: 77 },
          },
        },
        async () => fakeAdmin(),
      );

      const order = await db.order.findFirstOrThrow();
      expect(order.netTermsDueAt).toBeNull();
    });
  });
});

describe("recordPayment", () => {
  it("records a part payment without calling the invoice settled", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const order = await seedOrder();
      const { order: updated } = await recordPayment(
        order.id,
        { amount: 40000, receivedAt: NOW, reference: "bank transfer 88213" },
        { actor },
      );

      expect(updated.amountPaid).toBe(40000);
      expect(updated.paidAt).toBeNull();
      expect(await paymentsFor(order.id)).toHaveLength(1);
    });
  });

  it("settles the invoice once the whole balance is in", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const order = await seedOrder();
      await recordPayment(
        order.id,
        { amount: 40000, receivedAt: NOW, reference: null },
        { actor },
      );
      const { order: settled } = await recordPayment(
        order.id,
        { amount: 60000, receivedAt: NOW, reference: null },
        { actor },
      );

      expect(settled.paidAt).not.toBeNull();
      // Two rows, not one edited — the ledger explains itself line by line.
      expect(await paymentsFor(order.id)).toHaveLength(2);
    });
  });

  it("counts a refund towards what is owed", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const order = await seedOrder({ refundedAmount: 30000 });
      const { order: settled } = await recordPayment(
        order.id,
        { amount: 70000, receivedAt: NOW, reference: null },
        { actor },
      );
      expect(settled.paidAt).not.toBeNull();
    });
  });

  it("refuses an overpayment rather than letting the ledger stop reconciling", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const order = await seedOrder();
      await expect(
        recordPayment(
          order.id,
          { amount: 100001, receivedAt: NOW, reference: null },
          { actor },
        ),
      ).rejects.toBeInstanceOf(PaymentError);
      expect(await paymentsFor(order.id)).toHaveLength(0);
    });
  });

  it("refuses a payment of nothing", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const order = await seedOrder();
      await expect(
        recordPayment(
          order.id,
          { amount: 0, receivedAt: NOW, reference: null },
          { actor },
        ),
      ).rejects.toBeInstanceOf(PaymentError);
    });
  });

  it("is gated on the plan", async () => {
    await installShop(ALPHA, "free");

    await inAlpha(async () => {
      const order = await seedOrder();
      await expect(
        recordPayment(
          order.id,
          { amount: 1000, receivedAt: NOW, reference: null },
          { actor },
        ),
      ).rejects.toBeInstanceOf(FeatureLockedError);
    });
  });

  it("parses a typed amount per the currency's own exponent", async () => {
    expect(parseAmount("12.50", "USD")).toBe(1250);
    expect(parseAmount("12.500", "KWD")).toBe(12500);
    expect(parseAmount("1250", "JPY")).toBe(1250);
    expect(parseAmount("not money", "USD")).toBeNull();
    expect(parseAmount("", "USD")).toBeNull();
    // More precision than the currency has is refused, never silently rounded.
    expect(parseAmount("12.505", "USD")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The ledger                                                                  */
/* -------------------------------------------------------------------------- */

describe("the ledger", () => {
  it("totals every outstanding invoice, not just the page", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      for (let index = 0; index < 4; index += 1) {
        await seedOrder({ name: `#100${index}`, totalPrice: 10000 });
      }

      const page = await ledgerPage({
        page: 1,
        pageSize: 2,
        now: NOW,
        currencyCode: "USD",
      });
      expect(page.rows).toHaveLength(2);
      // A merchant reading a total and then paging must not find it changing.
      expect(page.summary.outstanding).toEqual(money(40000, "USD"));
      expect(page.pageCount).toBe(2);
    });
  });

  it("drops a settled invoice out of the ledger entirely", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const order = await seedOrder();
      await recordPayment(
        order.id,
        { amount: 100000, receivedAt: NOW, reference: null },
        { actor },
      );

      const page = await ledgerPage({ now: NOW, currencyCode: "USD" });
      expect(page.rows).toHaveLength(0);
      expect(page.summary.outstanding).toEqual(zero("USD"));
    });
  });

  it("tells 'nobody is on terms' from 'everybody has paid'", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      expect((await ledgerPage({ now: NOW, currencyCode: "USD" })).anyBuyerHasTerms).toBe(
        false,
      );

      const group = await seedGroup();
      await seedBuyer({ groupId: group.id });
      expect((await ledgerPage({ now: NOW, currencyCode: "USD" })).anyBuyerHasTerms).toBe(
        true,
      );
    });
  });

  it("excludes a cancelled order — nobody chases money for goods never sent", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedOrder({ cancelledAt: daysAgo(1) });
      expect((await ledgerPage({ now: NOW, currencyCode: "USD" })).rows).toHaveLength(0);
    });
  });

  it("gives a buyer the same numbers the checkout Function is published", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const group = await seedGroup({ creditLimit: 500000 });
      const buyer = await seedBuyer({ groupId: group.id });
      await seedOrder({ totalPrice: 120000 });

      const ledger = await ledgerFor(buyer, { now: NOW, currencyCode: "USD" });
      await publishBuyerTerms(admin, buyer);

      expect(ledger.summary.outstanding).toEqual(money(120000, "USD"));
      // The checklist: agent and checkout say so with the same number.
      expect(lastBuyerFacts(admin)?.terms?.outstanding).toBe(120000);
      expect(ledger.eligibility.headroom).toEqual(money(380000, "USD"));
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Reminders                                                                   */
/* -------------------------------------------------------------------------- */

describe("reminders", () => {
  it("sends one and records it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const order = await seedOrder({ netTermsDueAt: daysAgo(5) });
      const message = await sendReminder(order.id, { actor, now: NOW });

      expect(message.to).toBe("buyer@acme.test");
      expect(message.subject).toContain("#1001");
      // The amount and the date are what a reminder is for.
      expect(message.body).toContain("$1,000.00");

      const updated = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updated.remindedAt).not.toBeNull();
    });
  });

  it("will not chase the same buyer twice in an afternoon", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const order = await seedOrder({ remindedAt: NOW });
      expect(canRemind(order, NOW)).toBe(false);
      await expect(sendReminder(order.id, { actor, now: NOW })).rejects.toBeInstanceOf(
        ReminderError,
      );
    });
  });

  it("allows another once the cooldown has passed", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const order = await seedOrder({ remindedAt: daysAgo(4) });
      expect(canRemind(order, NOW)).toBe(true);
    });
  });

  it("says so rather than throwing when there is no address to write to", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const order = await seedOrder({ email: null });
      await expect(sendReminder(order.id, { actor, now: NOW })).rejects.toBeInstanceOf(
        ReminderError,
      );
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

describe("terms settings", () => {
  it("publishes to the shop metafield, owned by Shopify's shop id", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await saveTermsSettings(
        { methodName: "Invoice me", showDaysInName: true, overdueBlocks: false },
        { admin, actor },
      );

      const record = await db.shop.findFirstOrThrow();
      expect(record.termsMethodName).toBe("Invoice me");
      expect(record.termsPublishedAt).not.toBeNull();
    });

    const published = queried(admin, "MannonSetTermsSettings");
    expect(published).toHaveLength(1);
    const metafields = published[0]?.variables.metafields as { ownerId: string }[];
    expect(metafields?.[0]?.ownerId).toBe("gid://shopify/Shop/42");
  });

  it("refuses an empty method name, which would hide every payment method", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await expect(
        saveTermsSettings(
          { methodName: "   ", showDaysInName: true, overdueBlocks: true },
          { admin, actor },
        ),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  it("does not republish an unchanged set", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await publishTermsSettings(admin);
      expect(await publishTermsSettings(admin)).toEqual({ published: false });
    });

    expect(queried(admin, "MannonSetTermsSettings")).toHaveLength(1);
  });

  it("is gated on the plan", async () => {
    await installShop(ALPHA, "free");
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await expect(
        saveTermsSettings(
          { methodName: "Net terms", showDaysInName: true, overdueBlocks: true },
          { admin, actor },
        ),
      ).rejects.toBeInstanceOf(FeatureLockedError);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The tenant boundary                                                         */
/* -------------------------------------------------------------------------- */

describe("tenant boundary", () => {
  it("never shows one shop's invoices to another", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    await inAlpha(() => seedOrder());

    await inBeta(async () => {
      const page = await ledgerPage({ now: NOW, currencyCode: "USD" });
      expect(page.rows).toHaveLength(0);
      expect(page.summary.outstanding).toEqual(zero("USD"));
    });
  });

  it("404s on recording a payment against another shop's order", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const order = await inAlpha(() => seedOrder());

    await inBeta(async () => {
      await expect(
        recordPayment(
          order.id,
          { amount: 1000, receivedAt: NOW, reference: null },
          { actor },
        ),
      ).rejects.toMatchObject({ status: 404 });
    });

    await inAlpha(async () => {
      const unchanged = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(unchanged.amountPaid).toBe(0);
    });
  });

  it("404s on reminding another shop's buyer", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const order = await inAlpha(() => seedOrder());

    await inBeta(async () => {
      await expect(sendReminder(order.id, { actor, now: NOW })).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  it("keeps one shop's terms settings out of another's", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const admin = fakeAdmin();

    await inAlpha(() =>
      saveTermsSettings(
        { methodName: "Invoice me", showDaysInName: false, overdueBlocks: false },
        { admin, actor },
      ),
    );

    await inBeta(async () => {
      const record = await db.shop.findFirstOrThrow();
      expect(record.termsMethodName).toBe("Net terms");
    });
  });
});
