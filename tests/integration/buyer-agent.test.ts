import type { PricingRule } from "@mannon/pricing-engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { resetAnthropicClient, type MessagesApi } from "~/lib/ai/client.server";
import {
  historyFor,
  openConversation,
  overTurnLimit,
  purgeOldConversations,
  TURN_LIMIT,
} from "~/lib/agent/buyer/conversation.server";
import {
  lintInstructions,
  loadGuardrails,
  saveGuardrails,
  GuardrailValidationError,
  MAX_INSTRUCTION_WORDS,
} from "~/lib/agent/buyer/guardrails.server";
import { runTool, type ToolContext } from "~/lib/agent/buyer/tools.server";
import { allowedTools, answerBuyerTurn } from "~/lib/agent/buyer/turn.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { createRule } from "~/lib/pricing/rules.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * The Buyer Agent, against a real database and a stubbed model.
 *
 * The question every one of these is really asking: can a buyer, or a model
 * having a bad day, get this agent to say or do something the merchant did not
 * authorise? The answer has to be no by construction — a closed tool list, a
 * guardrail checked in our code rather than in a prompt, and a reply that may
 * only repeat figures the engine computed.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const NOW = new Date("2026-09-10T12:00:00Z");
const DAY = 86_400_000;
const BUYER_ID = "gid://shopify/Customer/77";
const actor = { type: "STAFF" as const, id: "staff-1" };

/* -------------------------------------------------------------------------- */
/* Stubs                                                                       */
/* -------------------------------------------------------------------------- */

function reply(text: string) {
  return {
    id: "msg_01agent",
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 90, output_tokens: 40, cache_read_input_tokens: 0 },
  };
}

const stub = (create: (...args: unknown[]) => unknown): MessagesApi =>
  ({ create, stream: () => {} }) as unknown as MessagesApi;

/**
 * Two model calls per turn: the router, then the writer.
 *
 * Handing back a queue rather than one canned answer is what lets a test say
 * "the router chose this tool and then the writer tried to say that" — which
 * is the only way to exercise the figure check at all.
 */
const conversationStub = (answers: string[]) => {
  const queue = [...answers];
  return stub(async () => reply(queue.shift() ?? queue[queue.length - 1] ?? "{}"));
};

const variant = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/ProductVariant/1",
  title: "Large",
  sku: "MUG-BL-L",
  price: "10.00",
  product: { id: "gid://shopify/Product/1", title: "Blue Mug" },
  ...overrides,
});

function fakeAdmin(nodes: unknown[] = [variant()]) {
  return {
    graphql: vi.fn(async (query: string) => {
      if (query.includes("MannonVariantsBySku")) {
        return { json: async () => ({ data: { productVariants: { nodes } } }) };
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
          data: { metafieldsSet: { metafields: [{ id: "gid://mf/1" }], userErrors: [] } },
        }),
      };
    }),
  } satisfies AdminGraphql;
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

async function installShop(shop: string, planKey = "agentic") {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        planKey,
        billingStatus: "ACTIVE",
        currencyCode: "USD",
        primaryLocale: "en",
      },
    }),
  );
}

const seedBuyer = (overrides: Record<string, unknown> = {}) =>
  db.customer.create({
    data: {
      ...tenant(),
      customerId: BUYER_ID,
      email: "buyer@acme.test",
      company: "Acme Ltd",
      status: "APPROVED",
      tags: ["wholesale"],
      currencyCode: "USD",
      ...overrides,
    },
  });

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  admin: fakeAdmin(),
  buyer: { customerId: BUYER_ID, tags: ["wholesale"], groupIds: [] },
  customerId: BUYER_ID,
  company: "Acme Ltd",
  email: "buyer@acme.test",
  currencyCode: "USD",
  locale: "en",
  now: NOW,
  testMode: false,
  abilities: {
    canBuildCart: true,
    canRequestQuote: true,
    canReadOrders: true,
    canReadTerms: true,
  },
  ...overrides,
});

/**
 * This shop's agent is live.
 *
 * Written straight onto the row rather than through a production path:
 * publishing is gated on a four-item checklist that `publishAgent` re-checks,
 * and satisfying all four is noise in a test about what the agent *says*.
 * A fixture that says "assume it is published" says exactly that.
 */
const goLive = () =>
  loadGuardrails().then((guardrails) =>
    db.agentGuardrails.update({
      where: { shop: guardrails.shop },
      data: { published: true, publishedAt: new Date() },
    }),
  );

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  resetAnthropicClient();
});

afterAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  resetAnthropicClient();
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */
/* The tools                                                                   */
/* -------------------------------------------------------------------------- */

describe("what the agent can look up", () => {
  it("prices from the engine, at this buyer's own price", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await createRule(wholesaleRule(35), { admin: fakeAdmin(), actor });

      const result = await runTool(
        { tool: "price_for", lines: [{ sku: "MUG-BL-L", quantity: 100 }], note: null },
        context(),
      );

      expect(result.lines[0]?.unitPrice).toBe("$6.50");
      expect(result.lines[0]?.lineTotal).toBe("$650.00");
      // Deciding shows its working, for buyers too.
      expect(result.lines[0]?.ruleSummary).toContain("Wholesale 35%");
      // And the slots it may write are exactly what it computed. The model
      // never types a figure; it types {{f1}} and this app substitutes.
      expect(result.slots.f1).toBe("$6.50");
      expect(result.slots.t1).toBe("$650.00");
      expect(result.slots.q1).toBe("100");
    });
  });

  it("prices at list for a buyer no rule reaches", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await createRule(wholesaleRule(35), { admin: fakeAdmin(), actor });

      const result = await runTool(
        { tool: "price_for", lines: [{ sku: "MUG-BL-L", quantity: 5 }], note: null },
        context({ buyer: { customerId: null, tags: [], groupIds: [] } }),
      );

      expect(result.lines[0]?.unitPrice).toBe("$10.00");
      expect(result.lines[0]?.ruleSummary).toBeNull();
    });
  });

  it("never prices with another shop's rules", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    await inBeta(() => createRule(wholesaleRule(90), { admin: fakeAdmin(), actor }));

    await inAlpha(async () => {
      await seedBuyer();
      const result = await runTool(
        { tool: "price_for", lines: [{ sku: "MUG-BL-L", quantity: 1 }], note: null },
        context(),
      );
      expect(result.lines[0]?.unitPrice).toBe("$10.00");
    });
  });

  it("lists a code the catalogue does not have, rather than dropping it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      const result = await runTool(
        {
          tool: "price_for",
          lines: [{ sku: "GHOST-1", quantity: 10 }],
          note: null,
        },
        context({ admin: fakeAdmin([]) }),
      );

      expect(result.lines).toEqual([]);
      expect(result.unknownSkus).toEqual(["GHOST-1"]);
      expect(result.slots).toEqual({});
    });
  });

  it("computes the next break rather than guessing at it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await createRule(
        {
          ...wholesaleRule(0),
          name: "Volume",
          kind: "volume_tier",
          value: {
            tiers: [
              { minQuantity: 1, maxQuantity: 49, kind: "percentage", percentage: 5 },
              { minQuantity: 50, maxQuantity: null, kind: "percentage", percentage: 12 },
            ],
          },
        } as PricingRule,
        { admin: fakeAdmin(), actor },
      );

      const result = await runTool(
        { tool: "next_tier", lines: [{ sku: "MUG-BL-L", quantity: 42 }], note: null },
        context(),
      );

      expect(result.facts).toContain("next_break_at: 50");
      expect(result.facts).toContain("units_to_add: 8");
      // The price at the break is the engine's answer, not arithmetic here.
      expect(result.facts).toContain("unit_price_at_break: $8.80");
      expect(result.slots.better).toBe("$8.80");
      expect(result.slots.addUnits).toBe("8");
    });
  });

  it("reads this buyer's own orders and nobody else's", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await db.order.createMany({
        data: [
          {
            ...tenant(),
            orderId: "gid://shopify/Order/1",
            name: "#1001",
            customerId: BUYER_ID,
            totalPrice: 120_000,
            currencyCode: "USD",
            processedAt: new Date(NOW.getTime() - DAY),
          },
          {
            ...tenant(),
            orderId: "gid://shopify/Order/2",
            name: "#1002",
            customerId: "gid://shopify/Customer/99",
            totalPrice: 999_000,
            currencyCode: "USD",
            processedAt: NOW,
          },
        ],
      });

      const result = await runTool(
        { tool: "order_status", lines: [], note: null },
        context(),
      );

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]).toContain("#1001");
      expect(result.slots.f1).toBe("$1,200.00");
      expect(result.slots.s1).toBe("#1001");
    });
  });

  it("states what a buyer owes, from their unpaid invoices", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer({ netTermsDays: 30, creditLimit: 500_000 });
      await db.order.create({
        data: {
          ...tenant(),
          orderId: "gid://shopify/Order/1",
          name: "#1001",
          customerId: BUYER_ID,
          totalPrice: 120_000,
          amountPaid: 20_000,
          currencyCode: "USD",
          netTermsDueAt: new Date(NOW.getTime() + DAY * 10),
          processedAt: NOW,
        },
      });

      const result = await runTool(
        { tool: "my_terms", lines: [], note: null },
        context(),
      );

      expect(result.facts).toContain("net_terms_days: 30");
      expect(result.facts).toContain("outstanding: $1,000.00");
      expect(result.slots.owed).toBe("$1,000.00");
      // "net 30" was unusable while the guard read three capitals and a number
      // as money. The days are a slot, so the sentence can be written.
      expect(result.slots.days).toBe("30");
    });
  });

  it("files a quote request the merchant prices, and promises nothing", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await createRule(wholesaleRule(35), { admin: fakeAdmin(), actor });

      const result = await runTool(
        {
          tool: "request_quote",
          lines: [{ sku: "MUG-BL-L", quantity: 500 }],
          note: "Can you do better on 500?",
        },
        context(),
      );

      expect(result.created?.kind).toBe("quote");

      const quote = await db.quote.findFirstOrThrow({ include: { lines: true } });
      expect(quote.source).toBe("BUYER_AGENT");
      expect(quote.requestNote).toBe("Can you do better on 500?");
      expect(quote.lines).toHaveLength(1);
      // Nothing was sent, so nothing was promised. The merchant decides.
      expect(quote.status).not.toBe("SENT");
      expect(quote.status).not.toBe("ACCEPTED");

      // **The price on the line, not just that there is a line.** `draftQuote`
      // prices what it is given, so handing it the already-discounted figure
      // applied the 35% twice — the merchant would have seen a line at $4.23
      // and a `listPrice` column claiming that was full price.
      expect(quote.lines[0]?.listPrice).toBe(1000);
      expect(quote.lines[0]?.unitPrice).toBe(650);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The guardrails                                                              */
/* -------------------------------------------------------------------------- */

describe("what the merchant switched off", () => {
  it("refuses a tool rather than running it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      const off = context({
        abilities: {
          canBuildCart: false,
          canRequestQuote: false,
          canReadOrders: false,
          canReadTerms: false,
        },
      });

      expect(
        (await runTool({ tool: "build_cart", lines: [], note: null }, off)).refusal,
      ).toBe("cart_off");
      expect(
        (await runTool({ tool: "request_quote", lines: [], note: null }, off)).refusal,
      ).toBe("quote_off");
      expect(
        (await runTool({ tool: "order_status", lines: [], note: null }, off)).refusal,
      ).toBe("orders_off");
      expect(
        (await runTool({ tool: "my_terms", lines: [], note: null }, off)).refusal,
      ).toBe("terms_off");

      // And nothing was written on the way to refusing.
      expect(await db.quote.count()).toBe(0);
    });
  });

  it("keeps a switched-off tool out of the list the model is given", async () => {
    const allowed = allowedTools({
      canBuildCart: false,
      canRequestQuote: true,
      canReadOrders: false,
      canReadTerms: true,
    });

    expect(allowed).not.toContain("build_cart");
    expect(allowed).not.toContain("order_status");
    expect(allowed).toContain("request_quote");
    expect(allowed).toContain("my_terms");
    // Pricing is not an ability a merchant grants: it is what the agent is for.
    expect(allowed).toContain("price_for");
  });

  it("defaults to able but unpublished, and to wholesale buyers only", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const guardrails = await loadGuardrails();
      expect(guardrails.published).toBe(false);
      expect(guardrails.guestMode).toBe(false);
      expect(guardrails.canBuildCart).toBe(true);
    });
  });

  it("refuses instructions longer than the cap, and an unknown tone", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await expect(
        saveGuardrails(
          { customInstructions: "word ".repeat(MAX_INSTRUCTION_WORDS + 1) },
          "staff-1",
        ),
      ).rejects.toBeInstanceOf(GuardrailValidationError);

      await expect(
        saveGuardrails({ tone: "piratical" }, "staff-1"),
      ).rejects.toBeInstanceOf(GuardrailValidationError);
    });
  });

  it("warns about instructions the agent will never follow", () => {
    const able = {
      canBuildCart: true,
      canRequestQuote: true,
      canReadOrders: true,
      canReadTerms: true,
    };

    // The checklist's own example. No setting grants this, so the warning is
    // the only thing standing between the merchant and a false belief.
    expect(
      lintInstructions("Offer discounts freely to good customers.", able).map(
        (w) => w.key,
      ),
    ).toContain("agent.lint.discountAuthority");

    expect(lintInstructions("Feel free to negotiate.", able).map((w) => w.key)).toContain(
      "agent.lint.discountAuthority",
    );

    expect(
      lintInstructions("Place the order for them if they ask.", able).map((w) => w.key),
    ).toContain("agent.lint.checkout");
  });

  it("warns about instructions that need an ability that is off", () => {
    const noQuotes = {
      canBuildCart: true,
      canRequestQuote: false,
      canReadOrders: true,
      canReadTerms: true,
    };

    expect(
      lintInstructions("Send a quote when they ask for one.", noQuotes).map((w) => w.key),
    ).toContain("agent.lint.quote");

    // The same sentence with the ability on is not a warning.
    expect(
      lintInstructions("Send a quote when they ask for one.", {
        ...noQuotes,
        canRequestQuote: true,
      }),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* A whole turn                                                                */
/* -------------------------------------------------------------------------- */

describe("answering a buyer", () => {
  const routed = (tool: string, lines: unknown[] = []) =>
    JSON.stringify({
      tool,
      lines,
      note: null,
      acknowledgement: "Let me check that for you.",
    });

  async function published() {
    await seedBuyer();
    await createRule(wholesaleRule(35), { admin: fakeAdmin(), actor });
    await goLive();
  }

  it("answers with a price the engine computed", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await published();

      const turn = await answerBuyerTurn(
        {
          message: "what's my price for MUG-BL-L at 100?",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
        },
        {
          messages: conversationStub([
            routed("price_for", [{ sku: "MUG-BL-L", quantity: 100 }]),
            JSON.stringify({ reply: "Your price is {{f1}} each — {{t1}} for {{q1}}." }),
          ]),
        },
      );

      expect(turn.failure).toBeNull();
      expect(turn.reply).toContain("$6.50");
      expect(turn.tool).toBe("price_for");

      // Both halves of the turn are on the record.
      const history = await historyFor(turn.conversationId);
      expect(history.map((row) => row.role)).toEqual(["buyer", "agent"]);
    });
  });

  it("throws away a reply that states a price nothing computed", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await published();

      const turn = await answerBuyerTurn(
        {
          message: "what's my price for MUG-BL-L at 100?",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
        },
        {
          messages: conversationStub([
            routed("price_for", [{ sku: "MUG-BL-L", quantity: 100 }]),
            // A model being helpful: rounding, and inventing a bulk price.
            JSON.stringify({ reply: "About $6 each, or $5.50 if you take 500." }),
            JSON.stringify({ reply: "About $6 each, or $5.50 if you take 500." }),
          ]),
        },
      );

      // The buyer is told something went wrong. They are never told $5.50.
      expect(turn.reply).toBeNull();
      expect(turn.failure).toBe("invalid_output");

      const messages = await db.agentMessage.findMany({
        where: { role: "AGENT" },
        orderBy: { createdAt: "asc" },
      });
      expect(messages.at(-1)?.text).toBe("");
      expect(messages.at(-1)?.refusal).not.toBeNull();
    });
  });

  it("says nothing at all until the merchant publishes it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      const create = vi.fn(async () => reply("{}"));

      const turn = await answerBuyerTurn(
        {
          message: "hello?",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
        },
        { messages: stub(create) },
      );

      expect(turn.failure).toBe("not_published");
      // And it did not cost the merchant a model call to find that out.
      expect(create).not.toHaveBeenCalled();
    });
  });

  it("does not answer a visitor who is not an approved buyer", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await published();
      await db.customer.updateMany({ data: { status: "PENDING" } });

      const turn = await answerBuyerTurn(
        {
          message: "what are your trade prices?",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
        },
        { messages: conversationStub([routed("price_for")]) },
      );

      expect(turn.failure).toBe("guest");
    });
  });

  it("stops talking once a person has taken the conversation over", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await published();
      const conversation = await openConversation({
        customerId: BUYER_ID,
        company: "Acme Ltd",
        locale: "en",
        now: NOW,
      });
      await db.agentConversation.update({
        where: { id: conversation.id },
        data: { takenOverAt: NOW, takenOverBy: "staff-1" },
      });

      const turn = await answerBuyerTurn(
        {
          message: "still there?",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
        },
        { messages: conversationStub([routed("price_for")]) },
      );

      expect(turn.failure).toBe("taken_over");
    });
  });

  it("records the outcome, strongest thing first", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await published();

      await answerBuyerTurn(
        {
          message: "what's my price for MUG-BL-L?",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
        },
        {
          messages: conversationStub([
            routed("price_for", [{ sku: "MUG-BL-L", quantity: 1 }]),
            JSON.stringify({ reply: "It's {{f1}} each." }),
          ]),
        },
      );
      expect((await db.agentConversation.findFirstOrThrow()).outcome).toBe("ANSWERED");

      await answerBuyerTurn(
        {
          message: "put 100 in my cart",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: new Date(NOW.getTime() + 60_000),
        },
        {
          messages: conversationStub([
            routed("build_cart", [{ sku: "MUG-BL-L", quantity: 100 }]),
            JSON.stringify({
              reply: "Done — {{total}} for {{q1}}. Review the cart when ready.",
            }),
          ]),
        },
      );

      const conversation = await db.agentConversation.findFirstOrThrow();
      expect(conversation.outcome).toBe("CART");
      // Same thread: a buyer who asks twice in the same hour is one errand.
      expect(await db.agentConversation.count()).toBe(1);
    });
  });

  it("hands back a cart the buyer reviews, and never a checkout", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await published();

      const turn = await answerBuyerTurn(
        {
          message: "reorder 100 blue mugs",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
        },
        {
          messages: conversationStub([
            routed("build_cart", [{ sku: "MUG-BL-L", quantity: 100 }]),
            JSON.stringify({ reply: "That's {{total}} for {{q1}} — have a look." }),
          ]),
        },
      );

      expect(turn.cart?.lines).toHaveLength(1);
      expect(turn.cart?.subtotal).toBe("$650.00");
      // No order, no draft order, nothing charged. The buyer takes it from here.
      expect(await db.order.count()).toBe(0);
    });
  });

  it("never reaches another shop's conversation", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(async () => {
      await seedBuyer();
      await goLive();
      await openConversation({
        customerId: BUYER_ID,
        company: "Acme Ltd",
        locale: "en",
        now: NOW,
      });
    });

    await inAlpha(async () => {
      expect(await db.agentConversation.count()).toBe(0);
      // Alpha's own guardrails are alpha's: beta publishing does not publish
      // an agent on somebody else's storefront.
      expect((await loadGuardrails()).published).toBe(false);
    });
  });
});

describe("retention", () => {
  it("deletes a conversation and its messages once it is old enough", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const old = await openConversation({
        customerId: BUYER_ID,
        company: "Acme Ltd",
        locale: "en",
        now: new Date(NOW.getTime() - 200 * DAY),
      });
      await db.agentMessage.create({
        data: {
          ...tenant(),
          conversationId: old.id,
          role: "BUYER",
          text: "an old question",
          createdAt: new Date(NOW.getTime() - 200 * DAY),
        },
      });
      await db.agentConversation.update({
        where: { id: old.id },
        data: { lastMessageAt: new Date(NOW.getTime() - 200 * DAY) },
      });

      const recent = await openConversation({
        customerId: "gid://shopify/Customer/99",
        company: "Other Ltd",
        locale: "en",
        now: NOW,
      });

      expect(await purgeOldConversations(NOW)).toBe(1);
      expect(await db.agentMessage.count()).toBe(0);
      expect((await db.agentConversation.findMany()).map((row) => row.id)).toEqual([
        recent.id,
      ]);
    });
  });
});

describe("how much one buyer may ask", () => {
  it("stops a buyer at the ceiling, and only that buyer", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const conversation = await openConversation({
        customerId: BUYER_ID,
        company: "Acme Ltd",
        locale: "en",
        now: NOW,
      });

      expect(await overTurnLimit({ customerId: BUYER_ID }, { now: NOW })).toBe(false);

      for (let index = 0; index < TURN_LIMIT; index += 1) {
        await db.agentMessage.create({
          data: {
            ...tenant(),
            conversationId: conversation.id,
            role: "BUYER",
            text: `question ${index}`,
            createdAt: NOW,
          },
        });
      }

      // Per buyer, so one buyer cannot spend the merchant's whole budget —
      // and cannot mute the agent for anybody else either.
      expect(await overTurnLimit({ customerId: BUYER_ID }, { now: NOW })).toBe(true);
      expect(
        await overTurnLimit({ customerId: "gid://shopify/Customer/99" }, { now: NOW }),
      ).toBe(false);
    });
  });

  it("forgets the ceiling once the window has passed", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const conversation = await openConversation({
        customerId: BUYER_ID,
        company: "Acme Ltd",
        locale: "en",
        now: NOW,
      });
      for (let index = 0; index < TURN_LIMIT; index += 1) {
        await db.agentMessage.create({
          data: {
            ...tenant(),
            conversationId: conversation.id,
            role: "BUYER",
            text: `question ${index}`,
            createdAt: new Date(NOW.getTime() - 60 * 60_000),
          },
        });
      }

      expect(await overTurnLimit({ customerId: BUYER_ID }, { now: NOW })).toBe(false);
    });
  });

  it("schedules the retention purge from the first conversation", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await openConversation({
        customerId: BUYER_ID,
        company: "Acme Ltd",
        locale: "en",
        now: NOW,
      });

      // "Retention 90d" is a promise about a buyer's own words. A promise
      // nothing enforces is a sentence in a settings page.
      const queued = await db.scheduledJob.findMany({
        where: { kind: "agent.purge_conversations" },
      });
      expect(queued).toHaveLength(1);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* What the cold read found                                                    */
/* -------------------------------------------------------------------------- */

describe("what may be priced at all", () => {
  it("will not sell a product that is not published", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      const result = await runTool(
        { tool: "build_cart", lines: [{ sku: "MUG-BL-L", quantity: 10 }], note: null },
        context({
          admin: fakeAdmin([
            variant({ product: { id: "gid://p/1", title: "Blue Mug", status: "DRAFT" } }),
          ]),
        }),
      );

      // The quick-order block refuses a draft or archived product. The agent
      // must not be the softer door into the same catalogue.
      expect(result.lines).toEqual([]);
      expect(result.unknownSkus).toEqual(["MUG-BL-L"]);
    });
  });

  it("adds up two lines that name the same product", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      const result = await runTool(
        {
          tool: "price_for",
          lines: [
            { sku: "MUG-BL-L", quantity: 50 },
            { sku: "mug-bl-l", quantity: 50 },
          ],
          note: null,
        },
        context(),
      );

      // "50 of the blue mug, and another 50" is a hundred, not two lines the
      // cart quietly merges afterwards.
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]?.quantity).toBe(100);
    });
  });

  it("keeps the variant's own name on the line", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      const result = await runTool(
        { tool: "price_for", lines: [{ sku: "MUG-BL-L", quantity: 1 }], note: null },
        context(),
      );

      // "Blue Mug" alone loses which one — and a buyer reading a cart card has
      // to be able to tell the large from the small.
      expect(result.lines[0]?.title).toBe("Blue Mug — Large");
    });
  });

  it("offers a bigger quantity only when it is actually cheaper", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      // A volume rule aimed at somebody else. Its breaks are not breaks this
      // buyer can reach, and flattening every tier in the shop offered them.
      await createRule(
        {
          ...wholesaleRule(0),
          name: "Distributor volume",
          kind: "volume_tier",
          audience: { mode: "tags", tags: ["distributor"] },
          value: {
            tiers: [
              { minQuantity: 500, maxQuantity: null, kind: "percentage", percentage: 40 },
            ],
          },
        } as PricingRule,
        { admin: fakeAdmin(), actor },
      );

      const result = await runTool(
        { tool: "next_tier", lines: [{ sku: "MUG-BL-L", quantity: 10 }], note: null },
        context(),
      );

      expect(result.facts).toContain("no_better_price_above: 10");
      expect(result.slots.better).toBeUndefined();
    });
  });
});

describe("subjects the merchant put off limits", () => {
  const routed = (tool: string, lines: unknown[] = []) =>
    JSON.stringify({
      tool,
      lines,
      note: null,
      acknowledgement: "Let me check that for you.",
    });

  it("declines in our own words, before any model call", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await saveGuardrails({ offLimits: ["our supplier", "lead times"] }, "staff-1");
      await goLive();

      const create = vi.fn(async () => reply(routed("price_for")));
      const turn = await answerBuyerTurn(
        {
          message: "who is your supplier for these?",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
        },
        { messages: stub(create) },
      );

      expect(turn.refusal).toBe("off_limits");
      expect(turn.reply).toContain("not something I can help with");
      // Enforced in code, so it costs nothing and cannot be talked around.
      expect(create).not.toHaveBeenCalled();

      const conversation = await db.agentConversation.findFirstOrThrow();
      expect(conversation.outcome).toBe("DECLINED");
    });
  });

  it("matches a whole word, not a fragment of one", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await saveGuardrails({ offLimits: ["cost"] }, "staff-1");
      await goLive();

      // A merchant who bans "cost" has not banned "costume".
      const turn = await answerBuyerTurn(
        {
          message: "do you stock the costume mugs?",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
        },
        {
          messages: conversationStub([
            routed("price_for", [{ sku: "MUG-BL-L", quantity: 1 }]),
            JSON.stringify({ reply: "It's {{f1}} each." }),
          ]),
        },
      );

      expect(turn.refusal).not.toBe("off_limits");
    });
  });
});

describe("the log a merchant reads", () => {
  const routed = (tool: string) =>
    JSON.stringify({ tool, lines: [], note: null, acknowledgement: "One moment." });

  it("does not call a dead turn an answered one", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await goLive();

      await answerBuyerTurn(
        {
          message: "hello?",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
        },
        { messages: conversationStub(["not json at all", "still not json"]) },
      );

      // Invariant 4, on the one screen a merchant uses to decide whether to
      // trust this thing: a conversation where nothing worked said "Answered".
      expect((await db.agentConversation.findFirstOrThrow()).outcome).toBe("FAILED");
    });
  });

  it("keeps what a buyer said to a merchant who has taken over", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await goLive();

      const conversation = await openConversation({
        customerId: BUYER_ID,
        company: "Acme Ltd",
        locale: "en",
        now: NOW,
      });
      await db.agentConversation.update({
        where: { id: conversation.id },
        data: { takenOverAt: NOW, takenOverBy: "staff-1" },
      });

      const turn = await answerBuyerTurn(
        {
          message: "are we still on for Friday?",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
        },
        { messages: conversationStub([routed("price_for")]) },
      );

      expect(turn.failure).toBe("taken_over");
      // The message a person is meant to answer must not be the one that
      // vanished on the way to them.
      const messages = await db.agentMessage.findMany();
      expect(messages.map((row) => row.text)).toContain("are we still on for Friday?");
    });
  });

  it("files an escalation where the merchant will see it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      const result = await runTool(
        { tool: "escalate", lines: [], note: "Can I collect it myself?" },
        context(),
      );

      expect(result.facts).toContain("escalated");
      // The checklist asks for an escalation "which files a message in the
      // admin". An audit entry is that message, and Home's activity feed
      // already reads them.
      const entry = await db.auditLog.findFirstOrThrow({
        where: { action: "agent.escalated" },
      });
      expect(entry.summary).toContain("Acme Ltd");
      expect(entry.metadata).toMatchObject({ asked: "Can I collect it myself?" });
    });
  });

  it("creates nothing at all for a shop that has not published", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();

      await answerBuyerTurn(
        {
          message: "hello?",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
        },
        { messages: conversationStub([routed("price_for")]) },
      );

      // A table anyone could fill from the outside is a table anyone can fill.
      expect(await db.agentConversation.count()).toBe(0);
      expect(await db.agentMessage.count()).toBe(0);
    });
  });
});

describe("a signed-out visitor", () => {
  it("is counted, and threaded, like anybody else", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const first = await openConversation({
        customerId: null,
        guestKey: "guest-a",
        company: null,
        locale: "en",
        now: NOW,
      });
      const again = await openConversation({
        customerId: null,
        guestKey: "guest-a",
        company: null,
        locale: "en",
        now: new Date(NOW.getTime() + 60_000),
      });

      // The same visitor, the same thread — without which a guest had no
      // conversation to count turns against and so no ceiling at all.
      expect(again.id).toBe(first.id);

      for (let index = 0; index < TURN_LIMIT; index += 1) {
        await db.agentMessage.create({
          data: {
            ...tenant(),
            conversationId: first.id,
            role: "BUYER",
            text: `question ${index}`,
            createdAt: NOW,
          },
        });
      }

      expect(await overTurnLimit({ guestKey: "guest-a" }, { now: NOW })).toBe(true);
      expect(await overTurnLimit({ guestKey: "guest-b" }, { now: NOW })).toBe(false);
    });
  });
});
