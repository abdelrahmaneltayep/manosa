import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { resetAnthropicClient, type MessagesApi } from "~/lib/ai/client.server";
import { getFixedT } from "~/i18n.server";
import { translate, type Translate } from "~/i18n/translate";
import { answerAsk } from "~/lib/agent/ask.server";
import {
  generateBriefing,
  latestBriefing,
  linesFor,
  muteKind,
  mutedKinds,
} from "~/lib/agent/briefing.server";
import { briefingFacts } from "~/lib/agent/facts.server";
import { dailyBriefing } from "~/lib/jobs/handlers/daily-briefing.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * The Merchant Agent against a real database and a stubbed model.
 *
 * The facts are the product here — a briefing is only as trustworthy as the
 * numbers it points at, and those numbers are computed, not written.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const NOW = new Date("2026-06-01T09:00:00Z");
const DAY = 86_400_000;

function reply(text: string) {
  return {
    id: "msg_01brief",
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 90, output_tokens: 40, cache_read_input_tokens: 0 },
  };
}

const stub = (create: (...args: unknown[]) => unknown): MessagesApi =>
  ({ create, stream: () => {} }) as unknown as MessagesApi;

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

async function overdueOrder(overrides: Record<string, unknown> = {}) {
  return db.order.create({
    data: {
      ...tenant(),
      orderId: `gid://shopify/Order/${Math.random().toString(36).slice(2)}`,
      name: "#1001",
      company: "Acme Ltd",
      totalPrice: 120_000,
      amountPaid: 0,
      currencyCode: "USD",
      isWholesale: true,
      netTermsDueAt: new Date(NOW.getTime() - 5 * DAY),
      processedAt: new Date(NOW.getTime() - 40 * DAY),
      createdAt: new Date(NOW.getTime() - 40 * DAY),
      ...overrides,
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

describe("the facts", () => {
  it("counts what is actually true, with a link to the page that proves it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await overdueOrder();
      const facts = await briefingFacts(NOW);

      const overdue = facts.find((fact) => fact.kind === "invoices_overdue");
      expect(overdue?.count).toBe(1);
      expect(overdue?.amount).toEqual({ amount: 120_000, currencyCode: "USD" });
      expect(overdue?.href).toBe("/app/orders/terms");
    });
  });

  it("counts only what is still owed", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await overdueOrder({ amountPaid: 100_000 });
      const facts = await briefingFacts(NOW);
      expect(facts.find((fact) => fact.kind === "invoices_overdue")?.amount).toEqual({
        amount: 20_000,
        currencyCode: "USD",
      });
    });
  });

  it("will not add two currencies together", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await overdueOrder({ currencyCode: "JPY", totalPrice: 500_000 });
      const facts = await briefingFacts(NOW);
      const overdue = facts.find((fact) => fact.kind === "invoices_overdue");

      // Counted as an overdue invoice, but not summed into a figure that would
      // mean nothing. The count is honest, the amount is absent.
      expect(overdue?.count).toBe(1);
      expect(overdue?.amount).toBeNull();
    });
  });

  it("says only the one thing that is true of an empty shop", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      // A store with no live rules is not selling wholesale to anybody, which
      // is the one thing worth saying on day one.
      expect((await briefingFacts(NOW)).map((fact) => fact.kind)).toEqual([
        "no_active_rules",
      ]);
    });
  });

  it("never counts another shop's rows", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(() => overdueOrder());
    await inAlpha(async () => {
      expect(
        (await briefingFacts(NOW)).filter((fact) => fact.kind === "invoices_overdue"),
      ).toEqual([]);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("generating a briefing", () => {
  const good = JSON.stringify({
    items: [{ kind: "invoices_overdue", reason: "Money that is already late." }],
  });

  it("writes what the agent chose, and no figures", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await overdueOrder();
      const { briefing } = await generateBriefing(
        { locale: "en", now: NOW },
        { messages: stub(async () => reply(good)) },
      );

      expect(briefing?.quiet).toBe(false);
      expect(briefing?.aiModel).toBe("claude-sonnet-4-5");
      // The stored briefing holds kinds and reasons. Every figure on the screen
      // is recomputed when the page renders.
      expect(JSON.stringify(briefing?.items)).not.toContain("120");
    });
  });

  it("writes a quiet briefing when the agent says nothing deserves them", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await overdueOrder();
      const { briefing } = await generateBriefing(
        { locale: "en", now: NOW },
        { messages: stub(async () => reply(JSON.stringify({ items: [] }))) },
      );

      // A designed state, with a timestamp: "All quiet" is only believable if
      // the merchant can see when it was decided.
      expect(briefing?.quiet).toBe(true);
      expect(briefing?.generatedAt).toEqual(NOW);
    });
  });

  it("writes a quiet briefing without asking, when there is nothing to ask about", async () => {
    await installShop(ALPHA);
    const create = vi.fn(async (_body: unknown) => reply(good));

    await inAlpha(async () => {
      // Every fact muted, so there is nothing left to weigh.
      await muteKind("no_active_rules", "staff-1");

      const { briefing } = await generateBriefing(
        { locale: "en", now: NOW },
        { messages: stub(create) },
      );

      expect(briefing?.quiet).toBe(true);
      expect(briefing?.aiModel).toBeNull();
      expect(create).not.toHaveBeenCalled();
    });
  });

  it("writes nothing when the model fails, so yesterday's survives", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await overdueOrder();
      await generateBriefing(
        { locale: "en", now: NOW },
        { messages: stub(async () => reply(good)) },
      );

      const { briefing, failure } = await generateBriefing(
        { locale: "en", now: new Date(NOW.getTime() + DAY) },
        { messages: stub(async () => reply("I could not do that.")) },
      );

      expect(briefing).toBeNull();
      expect(failure).toBe("invalid_output");
      // Yesterday's is still the latest, which is what the card falls back to.
      const latest = await latestBriefing();
      expect(latest?.generatedAt).toEqual(NOW);
    });
  });

  it("does not spend a call on something the merchant muted", async () => {
    await installShop(ALPHA);
    const create = vi.fn(async (_body: unknown) => reply(good));

    await inAlpha(async () => {
      await overdueOrder();
      await muteKind("invoices_overdue", "staff-1");
      await muteKind("no_active_rules", "staff-1");

      const { briefing } = await generateBriefing(
        { locale: "en", now: NOW },
        { messages: stub(create) },
      );

      // Every fact was muted, so there was nothing to ask about.
      expect(briefing?.quiet).toBe(true);
      expect(create).not.toHaveBeenCalled();
      expect(await mutedKinds()).toEqual(["invoices_overdue", "no_active_rules"]);
    });
  });

  it("records who muted a kind", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await muteKind("rules_unused", "staff-1");
      const entry = await db.auditLog.findFirstOrThrow({
        where: { action: "briefing.muted" },
      });
      expect(entry.actorId).toBe("staff-1");
    });
  });

  it("refuses to mute something that is not a briefing item", async () => {
    await installShop(ALPHA);
    await expect(inAlpha(() => muteKind("everything", "staff-1"))).rejects.toBeInstanceOf(
      Response,
    );
  });
});

describe("rendering yesterday's briefing against today", () => {
  it("drops an item the merchant has already dealt with", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const order = await overdueOrder();
      const { briefing } = await generateBriefing(
        { locale: "en", now: NOW },
        {
          messages: stub(async () =>
            reply(
              JSON.stringify({
                items: [{ kind: "invoices_overdue", reason: "Late money." }],
              }),
            ),
          ),
        },
      );

      expect(linesFor(briefing, await briefingFacts(NOW))).toHaveLength(1);

      // Paid overnight. The card must not still be asking about it.
      await db.order.update({
        where: { id: order.id },
        data: { paidAt: NOW, amountPaid: 120_000 },
      });

      expect(linesFor(briefing, await briefingFacts(NOW))).toEqual([]);
    });
  });
});

describe("the daily job", () => {
  it("skips a shop whose plan does not include the agent", async () => {
    await installShop(ALPHA, "pro");
    await inAlpha(async () => {
      expect(await dailyBriefing()).toEqual({ skipped: "not on this plan" });
    });
  });

  it("skips a shop that has uninstalled", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await db.shop.updateMany({ data: { uninstalledAt: new Date() } });
      expect(await dailyBriefing()).toEqual({ skipped: "uninstalled" });
    });
  });

  it("queues tomorrow's even when today's failed", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await overdueOrder();
      await dailyBriefing();

      // No key reaches Anthropic in tests, so today's did not get written —
      // and the job must still have asked to be run again tomorrow.
      const queued = await db.scheduledJob.count({
        where: { kind: "agent.daily_briefing", status: "PENDING" },
      });
      expect(queued).toBe(1);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("answering a routed question", () => {
  const ask = (overrides: Record<string, unknown> = {}) => ({
    intent: "list_overdue" as const,
    sku: null,
    quantity: null,
    search: null,
    days: null,
    target: null,
    ...overrides,
  });

  // The real English catalogue, so a headline that needs a plural rule or an
  // interpolation gets one — a stub `t` would pass while the merchant reads a
  // raw key.
  let english: Translate | null = null;
  const askOptions = async () => ({
    locale: "en",
    t: (english ??= translate(await getFixedT("en"))),
    now: NOW,
  });

  it("answers from this shop's own rows", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await overdueOrder();
      const result = await answerAsk(ask(), await askOptions());

      expect(result.headline.params.count).toBe(1);
      expect(result.rows[0]?.label).toContain("#1001");
      expect(result.isBuilder).toBe(false);
    });
  });

  it("never sees another shop's rows", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    await inBeta(() => overdueOrder());

    await inAlpha(async () => {
      const result = await answerAsk(ask(), await askOptions());
      expect(result.headline.params.count).toBe(0);
      expect(result.rows).toEqual([]);
    });
  });

  it("answers a change with a link, and changes nothing", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
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

      const result = await answerAsk(
        ask({ intent: "open_builder", target: "pricing_rule" }),
        await askOptions(),
      );

      expect(result.isBuilder).toBe(true);
      expect(result.href).toBe("/app/pricing/describe");
      // The rule is exactly where it was. There is no code path from the bar
      // to a write at all.
      expect(await db.pricingRule.count({ where: { archivedAt: null } })).toBe(1);
    });
  });

  it("counts buyers, and only approved ones", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await db.customer.createMany({
        data: [
          {
            ...tenant(),
            customerId: "gid://shopify/Customer/1",
            email: "a@acme.test",
            status: "APPROVED",
          },
          {
            ...tenant(),
            customerId: "gid://shopify/Customer/2",
            email: "b@acme.test",
            status: "PENDING",
          },
        ],
      });

      const result = await answerAsk(ask({ intent: "count_buyers" }), await askOptions());
      expect(result.headline.params.count).toBe(1);
    });
  });
});
