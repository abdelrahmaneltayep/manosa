import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { resetAnthropicClient, type MessagesApi } from "~/lib/ai/client.server";
import { answerFrom, chartsWithData } from "~/lib/analytics/answer.server";
import { askYourData } from "~/lib/analytics/ask.server";
import { loadAnalytics } from "~/lib/analytics/charts.server";
import { generateMonthlyReview } from "~/lib/analytics/review-run.server";
import { monthFacts } from "~/lib/analytics/review.server";
import { factsFromWebhook, upsertOrder } from "~/lib/orders/sync.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * The two ✦ analytics features, against a real database and a stubbed model.
 *
 * The question all of these ask: can the model put a number in front of a
 * merchant that this app did not compute? It routes and it writes prose; every
 * figure comes from the same module that draws the chart.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const NOW = new Date("2026-09-30T12:00:00Z");
const t = (key: string) => key;
const labels = {
  rest: "Everyone else",
  retail: "Retail",
  ungrouped: "No group",
  unnamedBuyer: "Unnamed",
};

function reply(text: string) {
  return {
    id: "msg_01data",
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 60, output_tokens: 30, cache_read_input_tokens: 0 },
  };
}

const stub = (create: (...args: unknown[]) => unknown): MessagesApi =>
  ({ create, stream: () => {} }) as unknown as MessagesApi;

const queue = (answers: string[]) => {
  const rest = [...answers];
  return stub(async () => reply(rest.shift() ?? rest[rest.length - 1] ?? "{}"));
};

async function installShop(shop: string, planKey = "growth") {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        planKey,
        billingStatus: "ACTIVE",
        currencyCode: "USD",
        ianaTimezone: "UTC",
        primaryLocale: "en",
        installedAt: new Date("2026-01-01T00:00:00Z"),
      },
    }),
  );
}

const order = (id: number, at: string, total: string, company = "Café Aroma") =>
  upsertOrder(
    {
      ...factsFromWebhook({
        admin_graphql_api_id: `gid://shopify/Order/${id}`,
        name: `#${id}`,
        currency: "USD",
        processed_at: at,
        current_total_price: total,
        customer: { id },
        discount_applications: [{ title: "Café trade price" }],
        line_items: [
          {
            admin_graphql_api_id: `gid://shopify/LineItem/${id}`,
            title: "House Blend 1kg",
            product_id: 1,
            quantity: 10,
            current_quantity: 10,
            price: "10.00",
            discount_allocations: [{ amount: "35.00", discount_application_index: 0 }],
          },
        ],
      })!,
      company,
    },
    true,
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

describe("asking your data", () => {
  it("answers from the chart it names, and links back to it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order(1, "2026-09-20T10:00:00Z", "100.00");

      const answer = await askYourData(
        {
          question: "who spends the most?",
          locale: "en",
          t,
          labels,
          actorId: null,
          now: NOW,
        },
        {
          messages: queue([
            JSON.stringify({ chart: "buyers", range: 30, focus: null }),
            JSON.stringify({ reply: "{{n1}} leads, at {{f1}}." }),
          ]),
        },
      );

      expect(answer.chart).toBe("buyers");
      expect(answer.href).toBe("/app/analytics?range=30#buyers");
      // The figure is this app's, substituted after the check.
      expect(answer.reply).toBe("Café Aroma leads, at $100.00.");
    });
  });

  it("throws away an answer that states a figure of its own", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order(1, "2026-09-20T10:00:00Z", "100.00");

      const answer = await askYourData(
        { question: "how much?", locale: "en", t, labels, actorId: null, now: NOW },
        {
          messages: queue([
            JSON.stringify({ chart: "revenue", range: 30, focus: null }),
            // Both attempts invent. The merchant gets the failure, not a
            // confident wrong number.
            JSON.stringify({ reply: "About $9,500 this month." }),
          ]),
        },
      );

      expect(answer.reply).toBeNull();
      expect(answer.failure).toBe("invalid_output");
    });
  });

  it("offers what can be answered when the chosen chart is empty", async () => {
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
      await db.formSubmission.create({
        data: {
          ...tenant(),
          formId: form.id,
          status: "PENDING",
          email: "one@acme.test",
          answers: {},
          createdAt: new Date("2026-09-20T10:00:00Z"),
        },
      });

      const create = vi.fn(async () =>
        reply(JSON.stringify({ chart: "products", range: 30, focus: null })),
      );
      const answer = await askYourData(
        { question: "top products?", locale: "en", t, labels, actorId: null, now: NOW },
        { messages: stub(create) },
      );

      expect(answer.reply).toBeNull();
      expect(answer.insteadTry).toContain("funnel");
      // No second call: there was nothing to write a sentence about.
      expect(create).toHaveBeenCalledTimes(1);
    });
  });

  it("says a focus matched nothing rather than answering about somebody else", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order(1, "2026-09-20T10:00:00Z", "100.00");
      const data = await loadAnalytics({ range: 30, now: NOW, labels });

      const answer = answerFrom(
        data,
        { chart: "buyers", range: 30, focus: "Nobody Ltd" },
        { locale: "en", t },
      );

      // "Your top buyer is X" in answer to "how did Nobody Ltd do" is a wrong
      // answer that reads like a right one.
      expect(answer.facts.join(" ")).toContain("Nobody Ltd");
      expect(answer.slots.f1).toBeUndefined();
    });
  });

  it("reads a shop's own charts and no other's", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(async () => {
      await order(1, "2026-09-20T10:00:00Z", "900.00", "Beta Buyer");
    });

    await inAlpha(async () => {
      const data = await loadAnalytics({ range: 30, now: NOW, labels });
      expect(chartsWithData(data)).toEqual([]);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("the monthly review", () => {
  const sections = JSON.stringify({
    quiet: false,
    sections: [
      {
        kind: "worked",
        headline: "{{n1}} led the month",
        body: "Wholesale took {{f1}} across {{q1}} orders.",
        action: "open_pricing",
        because: ["wholesale revenue: {{f1}}"],
      },
    ],
  });

  it("writes one, keeps the figures behind it, and substitutes ours", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order(1, "2026-08-10T10:00:00Z", "100.00");

      const run = await generateMonthlyReview(
        { month: "2026-08", now: NOW },
        { messages: queue([sections]) },
      );

      expect(run.review).not.toBeNull();
      const stored = run.review!.sections as { body: string }[];
      expect(stored[0]?.body).toBe("Wholesale took $100.00 across 1 orders.");
      // The data behind the sentence, stored beside it for the "why".
      expect(run.review!.facts).toMatchObject({ slots: { f1: "$100.00" } });
    });
  });

  it("is written once and never rewritten", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order(1, "2026-08-10T10:00:00Z", "100.00");

      const first = await generateMonthlyReview(
        { month: "2026-08", now: NOW },
        { messages: queue([sections]) },
      );
      const again = await generateMonthlyReview(
        { month: "2026-08", now: NOW },
        { messages: queue([sections]) },
      );

      // A merchant reading August in September and again in March must read
      // the same words.
      expect(again.skipped).toBe("exists");
      expect(again.review!.id).toBe(first.review!.id);
      expect(await db.monthlyReview.count()).toBe(1);
    });
  });

  it("writes nothing without the plan, and nothing without a key", async () => {
    await installShop(ALPHA, "free");

    await inAlpha(async () => {
      await order(1, "2026-08-10T10:00:00Z", "100.00");
      const gated = await generateMonthlyReview({ month: "2026-08", now: NOW });
      expect(gated.skipped).toBe("no_plan");
      expect(await db.monthlyReview.count()).toBe(0);
    });

    await installShop(BETA);
    delete process.env.ANTHROPIC_API_KEY;
    resetAnthropicClient();

    await inBeta(async () => {
      await order(2, "2026-08-10T10:00:00Z", "100.00");
      const keyless = await generateMonthlyReview({ month: "2026-08", now: NOW });
      expect(keyless.skipped).toBe("no_key");
    });

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    resetAnthropicClient();
  });

  it("does not call the model for a month in which nothing happened", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const create = vi.fn(async () => reply(sections));
      const run = await generateMonthlyReview(
        { month: "2026-08", now: NOW },
        { messages: stub(create) },
      );

      expect(run.skipped).toBe("nothing_to_review");
      expect(create).not.toHaveBeenCalled();
    });
  });

  it("refuses a review that states a figure of its own", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await order(1, "2026-08-10T10:00:00Z", "100.00");

      const run = await generateMonthlyReview(
        { month: "2026-08", now: NOW },
        {
          messages: queue([
            JSON.stringify({
              quiet: false,
              sections: [
                {
                  kind: "worked",
                  headline: "Revenue was up 30%",
                  body: "You took about $12,000.",
                  action: null,
                  because: [],
                },
              ],
            }),
          ]),
        },
      );

      expect(run.review).toBeNull();
      expect(run.failure).toBe("invalid_output");
      expect(await db.monthlyReview.count()).toBe(0);
    });
  });

  it("counts a calendar month in the shop's own timezone", async () => {
    await installShop(ALPHA);
    await shopScope.run(ALPHA, () =>
      db.shop.update({
        where: { shop: ALPHA },
        data: { ianaTimezone: "Australia/Sydney" },
      }),
    );

    await inAlpha(async () => {
      // 1pm UTC on 31 August is 11pm on the 31st in Sydney — August.
      await order(1, "2026-08-31T13:00:00Z", "100.00");
      // 3pm UTC on 31 August is 1am on 1 September in Sydney — September.
      await order(2, "2026-08-31T15:00:00Z", "50.00");

      const august = await monthFacts("2026-08", NOW);
      const september = await monthFacts("2026-09", NOW);

      expect(august.wholesaleRevenue.amount).toBe(10_000);
      expect(september.wholesaleRevenue.amount).toBe(5_000);
    });
  });

  it("is another shop's month, and never this one's", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(async () => {
      await order(1, "2026-08-10T10:00:00Z", "900.00", "Beta Buyer");
      await generateMonthlyReview(
        { month: "2026-08", now: NOW },
        { messages: queue([sections]) },
      );
    });

    await inAlpha(async () => {
      expect(await db.monthlyReview.count()).toBe(0);
      expect((await monthFacts("2026-08", NOW)).wholesaleRevenue.amount).toBe(0);
    });
  });
});
