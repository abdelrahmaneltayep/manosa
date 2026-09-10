import type { PricingRule } from "@mannon/pricing-engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { resetAnthropicClient, type MessagesApi } from "~/lib/ai/client.server";
import {
  exportConversations,
  listConversations,
  readConversation,
  replyAsMerchant,
  takeOver,
} from "~/lib/agent/buyer/log.server";
import { loadGuardrails, saveGuardrails } from "~/lib/agent/buyer/guardrails.server";
import {
  markGuardrailsReviewed,
  NotReadyError,
  outstanding,
  publishAgent,
  publishReadiness,
  unpublishAgent,
} from "~/lib/agent/buyer/publish.server";
import {
  closeRehearsal,
  currentRehearsal,
  rehearsalCompleted,
  rehearsalView,
} from "~/lib/agent/buyer/rehearsal.server";
import { answerBuyerTurn } from "~/lib/agent/buyer/turn.server";
import { logView, transcriptView } from "~/lib/agent/buyer/view-model.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { createRule } from "~/lib/pricing/rules.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * The three screens 5.3 adds, against a real database.
 *
 * Three questions, and the whole file is them: can this thing go live before
 * it is ready; can a merchant read back what it actually said; and does a
 * rehearsal ever touch anything real. The last one matters most — a test mode
 * that quietly files a genuine quote request teaches the merchant that the
 * panel is safe to press right up until the day it is not.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const NOW = new Date("2026-09-10T12:00:00Z");
const BUYER_ID = "gid://shopify/Customer/77";
const actor = { type: "STAFF" as const, id: "staff-1" };
const t = (key: string) => key;

/* -------------------------------------------------------------------------- */

function reply(text: string) {
  return {
    id: "msg_01panel",
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0 },
  };
}

const stub = (create: (...args: unknown[]) => unknown): MessagesApi =>
  ({ create, stream: () => {} }) as unknown as MessagesApi;

const conversationStub = (answers: string[]) => {
  const queue = [...answers];
  return stub(async () => reply(queue.shift() ?? queue[queue.length - 1] ?? "{}"));
};

/** The router picks a tool; the writer writes prose with slots in it. */
const routed = (tool: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    tool,
    lines: [],
    note: null,
    acknowledgement: "One moment.",
    ...extra,
  });

const written = (template: string) => JSON.stringify({ reply: template });

const variant = () => ({
  id: "gid://shopify/ProductVariant/1",
  title: "Large",
  sku: "MUG-BL-L",
  price: "10.00",
  product: { id: "gid://shopify/Product/1", title: "Blue Mug" },
});

function fakeAdmin() {
  return {
    graphql: vi.fn(async (query: string) => {
      if (query.includes("MannonVariantsBySku")) {
        return {
          json: async () => ({ data: { productVariants: { nodes: [variant()] } } }),
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
        primaryDomain: `${shop.replace(".myshopify.com", "")}.example`,
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

/** Everything the pre-publish checklist asks for, done. */
async function makeReady() {
  await seedBuyer();
  await createRule(wholesaleRule(35), { admin: fakeAdmin(), actor });
  await markGuardrailsReviewed("staff-1");
  await db.agentConversation.create({
    data: {
      ...tenant(),
      customerId: BUYER_ID,
      company: "Acme Ltd",
      testMode: true,
      outcome: "ANSWERED",
      startedAt: NOW,
      lastMessageAt: NOW,
    },
  });
}

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
/* The publish gate                                                            */
/* -------------------------------------------------------------------------- */

describe("before the agent goes live", () => {
  it("names all four things a fresh shop has not done", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const readiness = await publishReadiness();
      expect(readiness.ready).toBe(false);
      expect(outstanding(readiness)).toEqual(["rule", "buyer", "reviewed", "test"]);
      expect(readiness.published).toBe(false);
    });
  });

  it("refuses to publish while anything is outstanding, and changes nothing", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await expect(publishAgent("staff-1")).rejects.toBeInstanceOf(NotReadyError);
      expect((await loadGuardrails()).published).toBe(false);
      expect(await db.auditLog.count({ where: { action: "agent.published" } })).toBe(0);
    });
  });

  it("does not count a draft rule, an unapproved buyer or a failed rehearsal", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer({ status: "PENDING" });
      await db.pricingRule.create({
        data: {
          ...tenant(),
          name: "Draft",
          status: "DRAFT",
          priority: 10,
          kind: "PERCENTAGE",
          value: { percentage: 10 },
          targets: { mode: "all" },
          audience: { mode: "all" },
          markets: { mode: "all", marketIds: [] },
        },
      });
      await db.agentConversation.create({
        data: {
          ...tenant(),
          customerId: BUYER_ID,
          testMode: true,
          outcome: "FAILED",
          startedAt: NOW,
          lastMessageAt: NOW,
        },
      });

      // Everything present, nothing true. A checklist that ticks on the
      // existence of a row rather than on the state of it is a checklist that
      // lies to the merchant about whether they are ready.
      expect(outstanding(await publishReadiness())).toEqual([
        "rule",
        "buyer",
        "reviewed",
        "test",
      ]);
    });
  });

  it("publishes once all four are true, and records who did it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await makeReady();

      const readiness = await publishAgent("staff-1");
      expect(readiness.published).toBe(true);
      expect(readiness.storefrontUrl).toContain("https://");

      const audit = await db.auditLog.findFirst({ where: { action: "agent.published" } });
      expect(audit?.actorId).toBe("staff-1");
    });
  });

  it("unpublishes instantly, and keeps every guardrail", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await makeReady();
      await saveGuardrails({ offLimits: ["our supplier"], tone: "brief" }, "staff-1");
      await publishAgent("staff-1");

      const after = await unpublishAgent("staff-1");
      expect(after.published).toBe(false);

      // Features pause, data is never deleted.
      const guardrails = await loadGuardrails();
      expect(guardrails.offLimits).toEqual(["our supplier"]);
      expect(guardrails.tone).toBe("brief");
      expect(guardrails.publishedAt).toBeNull();
    });
  });

  it("is per shop: one shop publishing does not publish another", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(async () => {
      await makeReady();
      await publishAgent("staff-b");
    });

    await inAlpha(async () => {
      expect((await publishReadiness()).published).toBe(false);
      expect(await db.agentConversation.count()).toBe(0);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Test mode                                                                   */
/* -------------------------------------------------------------------------- */

describe("a rehearsal", () => {
  it("answers even though the agent is not published", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await createRule(wholesaleRule(35), { admin: fakeAdmin(), actor });

      const turn = await answerBuyerTurn(
        {
          message: "what's my price for 100 of MUG-BL-L?",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
          testMode: true,
        },
        {
          messages: conversationStub([
            routed("price_for", { lines: [{ sku: "MUG-BL-L", quantity: 100 }] }),
            written("{{s1}} at {{q1}} units is {{f1}} each — {{t1}} the lot."),
          ]),
        },
      );

      expect(turn.failure).toBeNull();
      expect(turn.reply).toContain("$6.50");

      const conversation = await db.agentConversation.findFirst();
      expect(conversation?.testMode).toBe(true);
    });
  });

  it("files no quote, whatever the model asks for", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();

      const turn = await answerBuyerTurn(
        {
          message: "can you do better on 500?",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
          testMode: true,
        },
        {
          messages: conversationStub([
            routed("request_quote", { note: "500 units" }),
            written("I've passed that on."),
          ]),
        },
      );

      expect(turn.quote).toBeNull();
      // The one tool that writes, and it did not.
      expect(await db.quote.count()).toBe(0);

      const message = await db.agentMessage.findFirst({ where: { role: "AGENT" } });
      expect(message?.refusal).toBe("test_mode");
    });
  });

  it("records no escalation in the merchant's activity feed", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();

      await answerBuyerTurn(
        {
          message: "I need to speak to someone",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
          testMode: true,
        },
        {
          messages: conversationStub([
            routed("escalate", { note: "wants a person" }),
            written("I'll pass this to the team."),
          ]),
        },
      );

      expect(await db.auditLog.count({ where: { action: "agent.escalated" } })).toBe(0);
    });
  });

  it("never joins a rehearsal to a real conversation with the same buyer", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await saveGuardrails({ published: true }, "staff-1");

      const deps = {
        messages: conversationStub([routed("decline"), written("I can't help there.")]),
      };
      const real = await answerBuyerTurn(
        {
          message: "hello",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
        },
        deps,
      );
      const test = await answerBuyerTurn(
        {
          message: "hello",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
          testMode: true,
        },
        deps,
      );

      expect(test.conversationId).not.toBe(real.conversationId);
      expect(await db.agentConversation.count()).toBe(2);
    });
  });

  it("starts a fresh thread after the merchant asks for one, and keeps the old", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      const deps = {
        messages: conversationStub([routed("decline"), written("I can't help there.")]),
      };
      const say = () =>
        answerBuyerTurn(
          {
            message: "hello",
            customerId: BUYER_ID,
            locale: "en",
            admin: fakeAdmin(),
            now: NOW,
            testMode: true,
          },
          deps,
        );

      const first = await say();
      await closeRehearsal(BUYER_ID, NOW);
      expect(await currentRehearsal(BUYER_ID, NOW)).toBeNull();

      const second = await say();
      expect(second.conversationId).not.toBe(first.conversationId);

      // Closed, not deleted: the merchant can still read what it said before
      // they changed a guardrail.
      const old = await db.agentConversation.findUnique({
        where: { id: first.conversationId },
      });
      expect(old?.closedAt).not.toBeNull();
    });
  });

  it("ticks the publish checklist only once one has been answered", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      expect(await rehearsalCompleted()).toBe(false);

      await answerBuyerTurn(
        {
          message: "hello",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: NOW,
          testMode: true,
        },
        {
          messages: conversationStub([routed("decline"), written("I can't help there.")]),
        },
      );

      expect(await rehearsalCompleted()).toBe(true);
    });
  });

  it("will not rehearse as somebody else's buyer", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(async () => {
      await seedBuyer();
    });

    await inAlpha(async () => {
      await db.customer.create({
        data: {
          ...tenant(),
          customerId: "gid://shopify/Customer/1",
          email: "mine@alpha.test",
          company: "Alpha Buyer",
          status: "APPROVED",
          currencyCode: "USD",
        },
      });

      // β's customer id, asked for in α. The picker is the authority on who
      // may be rehearsed as, and it falls back to α's own first buyer.
      const view = await rehearsalView({
        t,
        entitled: true,
        requiredPlan: null,
        buyerId: BUYER_ID,
        hasKey: true,
        now: NOW,
      });

      expect(view.buyerId).toBe("gid://shopify/Customer/1");
      expect(view.buyers.map((buyer) => buyer.customerId)).not.toContain(BUYER_ID);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The log                                                                     */
/* -------------------------------------------------------------------------- */

async function seedConversations(count: number, overrides: Record<string, unknown> = {}) {
  for (let index = 0; index < count; index += 1) {
    const at = new Date(NOW.getTime() - index * 60_000);
    const conversation = await db.agentConversation.create({
      data: {
        ...tenant(),
        customerId: `${BUYER_ID}-${index}`,
        company: `Buyer ${index}`,
        outcome: "ANSWERED",
        startedAt: at,
        lastMessageAt: at,
        ...overrides,
      },
    });
    await db.agentMessage.create({
      data: {
        ...tenant(),
        conversationId: conversation.id,
        role: "BUYER",
        text: `message ${index}`,
        createdAt: at,
      },
    });
  }
}

describe("the conversation log", () => {
  it("says nothing has happened yet, and separately that nothing matched", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      expect((await listConversations()).neverAny).toBe(true);

      await seedConversations(1);
      const filtered = await listConversations({ search: "nobody" });
      expect(filtered.neverAny).toBe(false);
      expect(filtered.rows).toHaveLength(0);
    });
  });

  it("pages, newest first", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedConversations(25);

      const first = await listConversations({ pageSize: 10 });
      expect(first.rows).toHaveLength(10);
      expect(first.pageCount).toBe(3);
      expect(first.rows[0]?.company).toBe("Buyer 0");

      const last = await listConversations({ page: 3, pageSize: 10 });
      expect(last.rows).toHaveLength(5);
      expect(last.rows.at(-1)?.company).toBe("Buyer 24");
    });
  });

  it("filters by outcome and by buyer, case-insensitively", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedConversations(2);
      await seedConversations(1, { outcome: "CART", company: "Café Aroma" });

      expect((await listConversations({ outcome: "CART" })).rows).toHaveLength(1);
      expect((await listConversations({ search: "café" })).rows).toHaveLength(1);
      expect((await listConversations({ search: "CAFÉ ARO" })).rows).toHaveLength(1);
    });
  });

  it("counts the turns on each row", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedConversations(1);
      expect((await listConversations()).rows[0]?.turns).toBe(1);
    });
  });

  it("is another shop's business, and reads as not found", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    const id = await inBeta(async () => {
      await seedConversations(1);
      return (await listConversations()).rows[0]!.id;
    });

    await inAlpha(async () => {
      // Not a 403. The difference between "no such thing" and "yes, but not
      // for you" is a leak, and this must be the first.
      expect(await readConversation(id)).toBeNull();
      expect((await listConversations()).total).toBe(0);
      await expect(takeOver(id, "staff-1")).rejects.toBeInstanceOf(Response);
    });
  });
});

describe("taking over", () => {
  const conversation = () =>
    db.agentConversation.create({
      data: {
        ...tenant(),
        customerId: BUYER_ID,
        company: "Acme Ltd",
        outcome: "ANSWERED",
        startedAt: NOW,
        lastMessageAt: NOW,
      },
    });

  it("stops the agent, announces the person, and records who", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const row = await conversation();
      await takeOver(row.id, "staff-1");

      const after = await db.agentConversation.findUnique({ where: { id: row.id } });
      expect(after?.takenOverAt).not.toBeNull();
      expect(after?.takenOverBy).toBe("staff-1");
      expect(after?.outcome).toBe("ESCALATED");

      const announced = await db.agentMessage.findFirst({
        where: { conversationId: row.id },
      });
      expect(announced?.refusal).toBe("taken_over");

      const audit = await db.auditLog.findFirst({
        where: { action: "agent.taken_over" },
      });
      expect(audit?.actorId).toBe("staff-1");
    });
  });

  it("is idempotent — two presses do not announce twice", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const row = await conversation();
      await takeOver(row.id, "staff-1");
      await takeOver(row.id, "staff-2");

      expect(await db.agentMessage.count({ where: { conversationId: row.id } })).toBe(1);
      const after = await db.agentConversation.findUnique({ where: { id: row.id } });
      expect(after?.takenOverBy).toBe("staff-1");
    });
  });

  it("silences the agent from the next message on", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedBuyer();
      await saveGuardrails({ published: true }, "staff-1");
      const row = await conversation();
      await takeOver(row.id, "staff-1");

      const turn = await answerBuyerTurn(
        {
          message: "are you still there?",
          customerId: BUYER_ID,
          locale: "en",
          admin: fakeAdmin(),
          now: new Date(NOW.getTime() + 60_000),
        },
        { messages: conversationStub([routed("decline"), written("Sure.")]) },
      );

      expect(turn.failure).toBe("taken_over");
      // The buyer's words are still kept: a message that vanished is a message
      // the merchant never answers.
      const said = await db.agentMessage.findFirst({
        where: { conversationId: row.id, role: "BUYER" },
      });
      expect(said?.text).toBe("are you still there?");
    });
  });

  it("treats a reply as taking over, even without the button", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const row = await conversation();
      await replyAsMerchant(row.id, "  I'll price that today.  ", "staff-1");

      const after = await db.agentConversation.findUnique({ where: { id: row.id } });
      expect(after?.takenOverAt).not.toBeNull();
      expect(after?.outcome).toBe("ESCALATED");

      const sent = await db.agentMessage.findFirst({ where: { role: "MERCHANT" } });
      expect(sent?.text).toBe("I'll price that today.");
    });
  });

  it("refuses an empty reply, and refuses to join a rehearsal", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const row = await conversation();
      await expect(replyAsMerchant(row.id, "   ", "staff-1")).rejects.toBeInstanceOf(
        Response,
      );

      const rehearsal = await db.agentConversation.create({
        data: {
          ...tenant(),
          customerId: BUYER_ID,
          testMode: true,
          startedAt: NOW,
          lastMessageAt: NOW,
        },
      });
      // There is nobody on the other end of a rehearsal to hand to.
      await expect(takeOver(rehearsal.id, "staff-1")).rejects.toBeInstanceOf(Response);
      await expect(
        replyAsMerchant(rehearsal.id, "hello", "staff-1"),
      ).rejects.toBeInstanceOf(Response);
    });
  });
});

describe("the CSV export", () => {
  it("carries every turn, labels rehearsals, and defuses formulas", async () => {
    await installShop(ALPHA);

    const csv = await inAlpha(async () => {
      const row = await db.agentConversation.create({
        data: {
          ...tenant(),
          customerId: BUYER_ID,
          company: "Acme Ltd",
          outcome: "ANSWERED",
          testMode: true,
          startedAt: NOW,
          lastMessageAt: NOW,
        },
      });
      await db.agentMessage.create({
        data: {
          ...tenant(),
          conversationId: row.id,
          role: "BUYER",
          // A buyer's message is untrusted text, and a spreadsheet reads a
          // cell starting with "=" as a formula.
          text: '=HYPERLINK("http://evil.test","click")',
          createdAt: NOW,
        },
      });
      return exportConversations();
    });

    const [header, line] = csv.split("\n");
    expect(header).toContain("test");
    expect(line).toContain('"yes"');
    expect(line).toContain(`"'=HYPERLINK`);
  });

  it("exports this shop's conversations and no other's", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(async () => {
      await seedConversations(1, { company: "Beta Buyer" });
    });

    await inAlpha(async () => {
      await seedConversations(1, { company: "Alpha Buyer" });
      const csv = await exportConversations();
      expect(csv).toContain("Alpha Buyer");
      expect(csv).not.toContain("Beta Buyer");
    });
  });
});

/* -------------------------------------------------------------------------- */
/* What the screens read                                                       */
/* -------------------------------------------------------------------------- */

describe("what the screens read", () => {
  it("chips a rehearsal and a conversation a person joined", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await seedConversations(1, { testMode: true });
      const view = logView(await listConversations(), {
        now: NOW,
        locale: "en",
        t,
        published: false,
        entitled: true,
        requiredPlan: null,
        filters: { outcome: "", search: "" },
      });

      expect(view.rows[0]?.testMode).toBe(true);
      expect(view.rows[0]?.takenOver).toBe(false);
      expect(view.neverAny).toBe(false);
    });
  });

  it("shows a turn nobody could answer as exactly that", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const row = await db.agentConversation.create({
        data: {
          ...tenant(),
          customerId: BUYER_ID,
          company: "Acme Ltd",
          outcome: "FAILED",
          startedAt: NOW,
          lastMessageAt: NOW,
        },
      });
      await db.agentMessage.create({
        data: {
          ...tenant(),
          conversationId: row.id,
          role: "AGENT",
          text: "",
          refusal: "timeout",
          toolCalls: { tool: "price_for", facts: ["sku: MUG"], unknownSkus: ["NOPE"] },
          createdAt: NOW,
        },
      });

      const transcript = await readConversation(row.id);
      const view = transcriptView(transcript!, {
        now: NOW,
        locale: "en",
        t,
        entitled: true,
      });

      expect(view.turns[0]?.text).toBe("");
      expect(view.turns[0]?.refusal).toBe("timeout");
      expect(view.turns[0]?.tool).toBe("price_for");
      expect(view.turns[0]?.facts).toContain("unknown_sku: NOPE");
    });
  });
});
