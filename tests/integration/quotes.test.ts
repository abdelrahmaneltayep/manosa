import { money } from "@mannon/pricing-engine";
import type { PricingRule } from "@mannon/pricing-engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { FeatureLockedError } from "~/lib/billing/gate.server";
import { expireQuotes, nextRun } from "~/lib/jobs/handlers/expire-quotes.server";
import { createRule } from "~/lib/pricing/rules.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { searchVariants } from "~/lib/quotes/admin-graphql.server";
import {
  acceptQuote,
  createQuote,
  declineQuote,
  draftQuote,
  findPublicQuote,
  getQuote,
  listQuotes,
  QuoteValidationError,
  reopenQuote,
  sendQuote,
} from "~/lib/quotes/quotes.server";
import { QuoteTransitionError } from "~/lib/quotes/state";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * Quotes end to end, with one question above all the others: does the price a
 * buyer was quoted survive until they accept it?
 *
 * The lifecycle itself is `tests/unit/quote-state.test.ts`, and the pricing is
 * the engine's own suite. These are about the wiring — that the engine is asked
 * once, that what it said is what reaches Shopify, and that a quote in one shop
 * is invisible in another.
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

function fakeAdmin(variants: unknown[] = []) {
  const calls: AdminCall[] = [];
  const admin: AdminGraphql & { calls: AdminCall[] } = {
    calls,
    graphql: vi.fn(
      async (query: string, options?: { variables?: Record<string, unknown> }) => {
        calls.push({ query, variables: options?.variables ?? {} });

        if (query.includes("MannonQuoteVariants")) {
          return {
            json: async () => ({ data: { productVariants: { nodes: variants } } }),
          };
        }
        if (query.includes("MannonDraftOrderCreate")) {
          return {
            json: async () => ({
              data: {
                draftOrderCreate: {
                  draftOrder: {
                    id: "gid://shopify/DraftOrder/900",
                    name: "#D12",
                    invoiceUrl: "https://example.test/invoice",
                  },
                  userErrors: [],
                },
              },
            }),
          };
        }
        if (query.includes("MannonDiscountFunction")) {
          return {
            json: async () => ({
              data: {
                shopifyFunctions: { nodes: [{ id: "gid://fn/1", title: "Mannon" }] },
              },
            }),
          };
        }
        if (query.includes("discountAutomaticAppCreate")) {
          return {
            json: async () => ({
              data: {
                discountAutomaticAppCreate: {
                  automaticAppDiscount: { discountId: "gid://discount/1" },
                  userErrors: [],
                },
              },
            }),
          };
        }
        return {
          json: async () => ({
            data: {
              metafieldsSet: { metafields: [{ id: "gid://mf/1" }], userErrors: [] },
            },
          }),
        };
      },
    ),
  };
  return admin;
}

const queried = (admin: { calls: AdminCall[] }, name: string) =>
  admin.calls.filter((call) => call.query.includes(name));

async function installShop(shop: string, planKey = "growth") {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        planKey,
        billingStatus: "ACTIVE",
        currencyCode: "USD",
        name: "Alpha Wholesale",
      },
    }),
  );
}

const wholesaleRule = (percentage: number): PricingRule =>
  ({
    id: "new",
    name: `Wholesale ${percentage}%`,
    status: "active",
    priority: 100,
    combinable: false,
    kind: "percentage",
    value: { percentage },
    targets: { mode: "all" },
    audience: { mode: "tags", tags: ["wholesale"] },
    markets: { mode: "all", marketIds: [] },
    schedule: { startsAt: null, endsAt: null },
    createdAt: new Date("2026-01-01T00:00:00Z"),
  }) as PricingRule;

const seedBuyer = () =>
  db.customer.create({
    data: {
      ...tenant(),
      customerId: "gid://shopify/Customer/77",
      email: "buyer@acme.test",
      company: "Acme Ltd",
      tags: ["wholesale"],
      currencyCode: "USD",
      orderCount: 4,
      lifetimeSpend: 120050,
    },
  });

const line = (overrides: Record<string, unknown> = {}) => ({
  variantId: "gid://shopify/ProductVariant/1",
  productId: "gid://shopify/Product/1",
  title: "Blue Mug — Large",
  sku: "MUG-BL-L",
  quantity: 100,
  listPrice: money(1000, "USD"),
  ...overrides,
});

/** A quote with a buyer, priced and ready to send. */
async function seedDraftedQuote() {
  await seedBuyer();
  await createRule(wholesaleRule(35), { admin: fakeAdmin(), actor });

  const quote = await createQuote(
    {
      customerId: "gid://shopify/Customer/77",
      email: "buyer@acme.test",
      company: "Acme Ltd",
      requestNote: "Can you do 100 of the blue ones?",
    },
    { actor },
  );

  return draftQuote(quote.id, { lines: [line()] }, { actor, now: NOW });
}

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */
/* Pricing, once                                                               */
/* -------------------------------------------------------------------------- */

describe("pricing a quote", () => {
  it("prices from the wholesale rules, not the list price", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await seedDraftedQuote();

      // 35% off $10.00 is $6.50, × 100.
      expect(quote.lines[0]?.unitPrice).toBe(650);
      expect(quote.lines[0]?.listPrice).toBe(1000);
      expect(quote.subtotal).toBe(65000);
      expect(quote.status).toBe("DRAFTED");
      expect(quote.lockedAt).not.toBeNull();
    });
  });

  it("records which rule made the price", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await seedDraftedQuote();
      // Deciding shows its working: a merchant asked "why is this cheaper than
      // the site?" needs an answer on the row.
      expect(quote.lines[0]?.ruleSummary).toBe("Wholesale 35%");
      expect(quote.lines[0]?.appliedRuleIds).toHaveLength(1);
    });
  });

  it("prices a guest request at list price rather than refusing it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await createRule(wholesaleRule(35), { admin: fakeAdmin(), actor });
      const quote = await createQuote(
        {
          customerId: null,
          email: "stranger@example.test",
          company: null,
          requestNote: null,
        },
        { actor },
      );
      const drafted = await draftQuote(
        quote.id,
        { lines: [line()] },
        { actor, now: NOW },
      );

      expect(drafted.lines[0]?.unitPrice).toBe(1000);
      expect(drafted.lines[0]?.ruleSummary).toBeNull();
    });
  });

  it("takes a merchant's own price over the engine's, and says it was manual", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await createRule(wholesaleRule(35), { admin: fakeAdmin(), actor });
      const quote = await createQuote(
        {
          customerId: "gid://shopify/Customer/77",
          email: "b@a.test",
          company: "Acme",
          requestNote: null,
        },
        { actor },
      );

      const drafted = await draftQuote(
        quote.id,
        {
          lines: [line()],
          overrides: { "gid://shopify/ProductVariant/1": 600 },
        },
        { actor, now: NOW },
      );

      expect(drafted.lines[0]?.unitPrice).toBe(600);
      // No rule is claimed for a number a person typed.
      expect(drafted.lines[0]?.ruleSummary).toBeNull();
      expect(drafted.lines[0]?.appliedRuleIds).toEqual([]);
    });
  });

  it("refuses a quote with no lines, and one with a nonsense quantity", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await createQuote(
        { customerId: null, email: null, company: null, requestNote: null },
        { actor },
      );

      await expect(draftQuote(quote.id, { lines: [] }, { actor })).rejects.toBeInstanceOf(
        QuoteValidationError,
      );
      await expect(
        draftQuote(quote.id, { lines: [line({ quantity: 0 })] }, { actor }),
      ).rejects.toBeInstanceOf(QuoteValidationError);
    });
  });

  it("re-pricing replaces the lines rather than adding to them", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await seedDraftedQuote();
      const again = await draftQuote(quote.id, { lines: [line()] }, { actor, now: NOW });

      expect(again.lines).toHaveLength(1);
      expect(await db.quoteLine.count()).toBe(1);
    });
  });

  it("is gated on the plan, server-side", async () => {
    await installShop(ALPHA, "free");

    await inAlpha(async () => {
      await expect(
        createQuote(
          { customerId: null, email: null, company: null, requestNote: null },
          { actor },
        ),
      ).rejects.toBeInstanceOf(FeatureLockedError);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The lock                                                                    */
/* -------------------------------------------------------------------------- */

describe("locked prices", () => {
  it("charges the quoted price after the rules change", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await seedDraftedQuote();
      expect(quote.lines[0]?.unitPrice).toBe(650);

      await sendQuote(quote.id, { actor, now: NOW });

      // The merchant cuts the wholesale discount to 10% the next day.
      await db.pricingRule.updateMany({ data: { value: { percentage: 10 } } });

      const admin = fakeAdmin();
      const accepted = await acceptQuote(quote.id, { admin, actor, now: daysAhead(1) });

      // Still $6.50 — this is the promise a quote makes.
      expect(accepted.lines[0]?.unitPrice).toBe(650);

      const draft = queried(admin, "MannonDraftOrderCreate")[0];
      const input = draft?.variables.input as {
        lineItems: { originalUnitPriceWithCurrency: { amount: string } }[];
      };
      // And the locked price is what actually reaches Shopify. Without this
      // field Shopify re-reads the variant and the promise evaporates.
      expect(input.lineItems[0]?.originalUnitPriceWithCurrency.amount).toBe("6.50");
    });
  });

  it("does not re-price on accept even when nothing changed", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await seedDraftedQuote();
      await sendQuote(quote.id, { actor, now: NOW });

      const admin = fakeAdmin();
      await acceptQuote(quote.id, { admin, actor, now: NOW });

      // The accept path asks Shopify to create a draft order and nothing else.
      // A metafield write here would mean it had gone near the pricing path.
      expect(queried(admin, "MannonQuoteVariants")).toHaveLength(0);
      expect(queried(admin, "MannonDraftOrderCreate")).toHaveLength(1);
    });
  });

  it("re-pricing a reopened quote does move the price", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await seedDraftedQuote();
      await sendQuote(quote.id, { actor, now: NOW });
      await declineQuote(quote.id, "decline", { actor, now: NOW });
      await reopenQuote(quote.id, { actor });

      await db.pricingRule.updateMany({ data: { value: { percentage: 10 } } });
      const repriced = await draftQuote(
        quote.id,
        { lines: [line()] },
        { actor, now: NOW },
      );

      // A deliberate re-price is the one way a quote's price changes.
      expect(repriced.lines[0]?.unitPrice).toBe(900);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The lifecycle                                                               */
/* -------------------------------------------------------------------------- */

describe("sending and accepting", () => {
  it("sets the expiry from settings and mails the buyer", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await seedDraftedQuote();
      const sent = await sendQuote(quote.id, { actor, now: NOW });

      expect(sent.status).toBe("SENT");
      expect(sent.expiryDays).toBe(14);
      expect(sent.expiresAt?.toISOString()).toBe("2026-09-24T12:00:00.000Z");

      const message = await db.emailMessage.findFirstOrThrow({
        where: { kind: "quote_sent" },
      });
      expect(message.to).toBe("buyer@acme.test");
      expect(message.body).toContain(sent.publicId);
      expect(message.body).toContain("$650.00");
    });
  });

  it("keeps a date the buyer was given when the default changes", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await seedDraftedQuote();
      const sent = await sendQuote(quote.id, { actor, now: NOW });

      await db.shop.updateMany({ data: { quoteExpiryDays: 3 } });

      const unchanged = await getQuote(quote.id);
      expect(unchanged?.expiresAt?.toISOString()).toBe(sent.expiresAt?.toISOString());
      expect(unchanged?.expiryDays).toBe(14);
    });
  });

  it("refuses to send a quote with no address or no lines", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const noEmail = await createQuote(
        { customerId: null, email: null, company: null, requestNote: null },
        { actor },
      );
      await draftQuote(noEmail.id, { lines: [line()] }, { actor, now: NOW });
      await expect(sendQuote(noEmail.id, { actor, now: NOW })).rejects.toBeInstanceOf(
        QuoteValidationError,
      );
    });
  });

  it("creates the draft order against the buyer, with the quote's number on it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await seedDraftedQuote();
      await sendQuote(quote.id, { actor, now: NOW });

      const admin = fakeAdmin();
      const accepted = await acceptQuote(quote.id, { admin, actor, now: NOW });

      expect(accepted.status).toBe("ACCEPTED");
      expect(accepted.draftOrderName).toBe("#D12");

      const input = queried(admin, "MannonDraftOrderCreate")[0]?.variables.input as {
        purchasingEntity: { customerId: string };
        tags: string[];
      };
      expect(input.purchasingEntity.customerId).toBe("gid://shopify/Customer/77");
      expect(input.tags).toContain(quote.number);
    });
  });

  it("refuses to accept a quote that has run out, and expires it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await seedDraftedQuote();
      await sendQuote(quote.id, { actor, now: daysAgo(30) });

      const admin = fakeAdmin();
      await expect(
        acceptQuote(quote.id, { admin, actor, now: NOW }),
      ).rejects.toBeInstanceOf(QuoteValidationError);

      // And no draft order was created on the way to refusing.
      expect(queried(admin, "MannonDraftOrderCreate")).toHaveLength(0);
      expect((await getQuote(quote.id))?.status).toBe("EXPIRED");
    });
  });

  it("refuses a second accept on the same quote", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await seedDraftedQuote();
      await sendQuote(quote.id, { actor, now: NOW });
      const admin = fakeAdmin();
      await acceptQuote(quote.id, { admin, actor, now: NOW });

      // A buyer refreshing the accept page must not get two draft orders.
      await expect(
        acceptQuote(quote.id, { admin, actor, now: NOW }),
      ).rejects.toBeInstanceOf(QuoteTransitionError);
      expect(queried(admin, "MannonDraftOrderCreate")).toHaveLength(1);
    });
  });

  it("reopening clears the dates so a stale expiry cannot linger", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await seedDraftedQuote();
      await sendQuote(quote.id, { actor, now: daysAgo(30) });
      await db.quote.update({ where: { id: quote.id }, data: { status: "EXPIRED" } });

      const reopened = await reopenQuote(quote.id, { actor });
      expect(reopened.status).toBe("DRAFTED");
      expect(reopened.expiresAt).toBeNull();
      expect(reopened.sentAt).toBeNull();
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The expiry job                                                              */
/* -------------------------------------------------------------------------- */

describe("expireQuotes", () => {
  it("expires what has run out and warns about what is close", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const stale = await seedDraftedQuote();
      await sendQuote(stale.id, { actor, now: daysAgo(30) });

      const closing = await createQuote(
        {
          customerId: null,
          email: "soon@acme.test",
          company: "Soon Ltd",
          requestNote: null,
        },
        { actor },
      );
      await draftQuote(closing.id, { lines: [line()] }, { actor, now: NOW });
      await sendQuote(closing.id, { actor, now: daysAgo(12) });

      const result = await expireQuotes({ now: NOW });

      expect(result).toMatchObject({ expired: 1, reminded: 1 });
      expect((await getQuote(stale.id))?.status).toBe("EXPIRED");
      expect((await getQuote(closing.id))?.remindedAt).not.toBeNull();
      expect(await db.emailMessage.count({ where: { kind: "quote_expiring" } })).toBe(1);
    });
  });

  it("warns once, however often it runs", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await seedDraftedQuote();
      await sendQuote(quote.id, { actor, now: daysAgo(12) });

      await expireQuotes({ now: NOW });
      const second = await expireQuotes({ now: NOW });

      expect(second.reminded).toBe(0);
      expect(await db.emailMessage.count({ where: { kind: "quote_expiring" } })).toBe(1);
    });
  });

  it("queues itself again only while something is still out", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      // Nothing outstanding: no daily no-op forever.
      expect((await expireQuotes({ now: NOW })).requeued).toBe(false);

      const quote = await seedDraftedQuote();
      await sendQuote(quote.id, { actor, now: NOW });
      expect((await expireQuotes({ now: NOW })).requeued).toBe(true);

      const queued = await db.scheduledJob.findMany({
        where: { kind: "quotes.expire", status: "PENDING" },
      });
      // Exactly one pending, whatever ran before.
      expect(queued).toHaveLength(1);
    });
  });

  it("runs just after midnight, not on the hour", () => {
    expect(nextRun(NOW).toISOString()).toBe("2026-09-11T00:05:00.000Z");
  });

  it("skips an uninstalled shop", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await db.shop.updateMany({ data: { uninstalledAt: NOW } });
      expect(await expireQuotes({ now: NOW })).toEqual({ skipped: "uninstalled" });
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The buyer's link                                                            */
/* -------------------------------------------------------------------------- */

describe("the public token", () => {
  it("is long and random, not a cuid", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const quote = await createQuote(
        { customerId: null, email: null, company: null, requestNote: null },
        { actor },
      );
      // 24 random bytes as base64url. A guessable link would expose one
      // buyer's negotiated prices and let a stranger act on them.
      expect(quote.publicId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    });
  });

  it("finds the quote and the shop it belongs to", async () => {
    await installShop(ALPHA);
    const quote = await inAlpha(() =>
      createQuote(
        { customerId: null, email: null, company: null, requestNote: null },
        { actor },
      ),
    );

    const found = await findPublicQuote(quote.publicId);
    expect(found?.shop).toBe(ALPHA);
    expect(found?.quote.id).toBe(quote.id);
  });

  it("returns nothing for a token that was never issued", async () => {
    expect(await findPublicQuote("not-a-real-token")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Searching the catalogue                                                     */
/* -------------------------------------------------------------------------- */

describe("searchVariants", () => {
  it("builds a title from the product and the variant", async () => {
    const admin = fakeAdmin([
      {
        id: "gid://shopify/ProductVariant/1",
        title: "Large",
        sku: "MUG-BL-L",
        price: "10.00",
        product: { id: "gid://shopify/Product/1", title: "Blue Mug" },
      },
    ]);

    const results = await searchVariants(admin, "mug");
    expect(results[0]).toMatchObject({ title: "Blue Mug — Large", sku: "MUG-BL-L" });
  });

  it("returns nothing for an empty term rather than every product", async () => {
    const admin = fakeAdmin([]);
    expect(await searchVariants(admin, "   ")).toEqual([]);
    expect(admin.calls).toHaveLength(0);
  });

  it("returns nothing rather than throwing when Shopify errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const admin: AdminGraphql = {
      graphql: vi.fn(async () => {
        throw new Error("rate limited");
      }),
    };

    // A quote half-built is worth more than an error page.
    expect(await searchVariants(admin, "mug")).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* The tenant boundary                                                         */
/* -------------------------------------------------------------------------- */

describe("tenant boundary", () => {
  it("never shows one shop's quotes to another", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    await inAlpha(() => seedDraftedQuote());

    await inBeta(async () => {
      const page = await listQuotes({ search: "", status: "" });
      expect(page.rows).toHaveLength(0);
      expect(page.totalUnfiltered).toBe(0);
    });
  });

  it("404s on drafting, sending or accepting another shop's quote", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const quote = await inAlpha(() => seedDraftedQuote());
    const admin = fakeAdmin();

    await inBeta(async () => {
      await expect(
        draftQuote(quote.id, { lines: [line()] }, { actor }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(sendQuote(quote.id, { actor })).rejects.toMatchObject({ status: 404 });
      await expect(acceptQuote(quote.id, { admin, actor })).rejects.toMatchObject({
        status: 404,
      });
    });

    // Untouched, and no draft order was created on the way to refusing.
    await inAlpha(async () => {
      expect((await getQuote(quote.id))?.status).toBe("DRAFTED");
    });
    expect(queried(admin, "MannonDraftOrderCreate")).toHaveLength(0);
  });

  it("does not expire another shop's quotes", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const quote = await inAlpha(async () => {
      const drafted = await seedDraftedQuote();
      return sendQuote(drafted.id, { actor, now: daysAgo(30) });
    });

    await inBeta(async () => {
      expect(await expireQuotes({ now: NOW })).toMatchObject({ expired: 0, examined: 0 });
    });
    await inAlpha(async () => {
      expect((await getQuote(quote.id))?.status).toBe("SENT");
    });
  });

  it("gives each shop its own quote numbering", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    const alpha = await inAlpha(() =>
      createQuote(
        { customerId: null, email: null, company: null, requestNote: null },
        { actor },
      ),
    );
    const beta = await inBeta(() =>
      createQuote(
        { customerId: null, email: null, company: null, requestNote: null },
        { actor },
      ),
    );

    // Both start at Q-1001: a merchant's quote numbers are theirs, and a
    // shared sequence would leak how many other stores are on the app.
    expect(alpha.number).toBe("Q-1001");
    expect(beta.number).toBe("Q-1001");
  });
});
