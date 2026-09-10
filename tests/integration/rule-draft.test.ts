import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { resetAnthropicClient, type MessagesApi } from "~/lib/ai/client.server";
import {
  draftRuleFromSentence,
  type RuleGrounding,
} from "~/lib/ai/prompts/rule-from-sentence.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { loadGrounding, prepareDraft, envelopeFor } from "~/lib/pricing/describe.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * Asking Claude for a rule, against a stubbed client.
 *
 * No key reaches Anthropic from here. What is proved is the contract the
 * pricing page depends on: the request is deterministic, the answer is checked
 * before it is believed, one repair and then the manual path, and a run in the
 * log whichever way it went.
 */

const ALPHA = "alpha.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const NOW = new Date("2026-09-10T12:00:00Z");

const grounding: RuleGrounding = {
  currencyCode: "USD",
  collections: [{ id: "gid://shopify/Collection/1", title: "Sale" }],
  groups: [{ id: "grp_gold", name: "Gold" }],
  tags: ["wholesale"],
};

const RULE = JSON.stringify({
  name: "Wholesale tiers",
  kind: "volume_tier",
  tiers: [
    { minQuantity: 10, maxQuantity: 49, kind: "percentage", percentage: 5 },
    { minQuantity: 50, maxQuantity: null, kind: "percentage", percentage: 12 },
  ],
  cartTiers: [],
  targets: { mode: "all", collections: [], excludeCollections: ["Sale"] },
  audience: { mode: "tags", tags: ["wholesale"], groups: [] },
  schedule: { startsAt: null, endsAt: null },
  combinable: false,
  notes: null,
});

/** Shape-complete, but naming a rule type the engine has never heard of. */
const BAD_KIND = JSON.stringify({ ...JSON.parse(RULE), kind: "nope" });

function reply(text: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_01test",
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
    ...overrides,
  };
}

function stubMessages(create: (...args: unknown[]) => unknown): MessagesApi {
  return { create, stream: () => {} } as unknown as MessagesApi;
}

const ask = (sentence = "Buy 10 get 5%, buy 50 get 12%, exclude sale items") => ({
  sentence,
  grounding,
  actorId: "staff-1",
  now: NOW,
});

async function installShop() {
  await inAlpha(() =>
    db.shop.create({
      data: { ...tenant(), planKey: "pro", billingStatus: "ACTIVE", currencyCode: "USD" },
    }),
  );
}

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  resetAnthropicClient();
  await installShop();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  resetAnthropicClient();
});

afterAll(async () => {
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */

describe("draftRuleFromSentence", () => {
  it("reads a good answer into a draft rule", async () => {
    const messages = stubMessages(async () => reply(RULE));

    await inAlpha(async () => {
      const result = await draftRuleFromSentence(ask(), { messages });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rule.name).toBe("Wholesale tiers");
      expect(result.value.rule.status).toBe("draft");
      expect(result.attempts).toBe(1);
    });
  });

  it("asks the same question the same way, every time", async () => {
    const create = vi.fn(async (_body: unknown) => reply(RULE));

    await inAlpha(async () => {
      await draftRuleFromSentence(ask(), { messages: stubMessages(create) });
    });

    const sent = create.mock.calls[0]?.[0] as { temperature?: number };
    // brand.md, §5. Two merchants typing the same sentence should not get two
    // different rules, and neither should the same merchant twice.
    expect(sent.temperature).toBe(0);
  });

  it("never puts an id in the prompt", async () => {
    const create = vi.fn(async (_body: unknown) => reply(RULE));

    await inAlpha(async () => {
      await draftRuleFromSentence(ask(), { messages: stubMessages(create) });
    });

    const sent = create.mock.calls[0]?.[0] as {
      messages: { content: string }[];
      system: { text: string }[];
    };
    const prompt = sent.system[0]!.text + sent.messages[0]!.content;

    expect(prompt).toContain("Sale");
    expect(prompt).not.toContain("gid://");
    expect(prompt).not.toContain("grp_gold");
  });

  it("repairs one bad answer, carrying the reason back", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(reply(BAD_KIND))
      .mockResolvedValueOnce(reply(RULE));

    await inAlpha(async () => {
      const result = await draftRuleFromSentence(ask(), {
        messages: stubMessages(create),
      });
      expect(result.ok).toBe(true);
    });

    const repair = create.mock.calls[1]?.[0] as { messages: { content: string }[] };
    expect(repair.messages[0]!.content).toContain("could not be used");
    expect(repair.messages[0]!.content).toContain("nope");
  });

  it("gives up after one repair rather than looping on the merchant's time", async () => {
    const create = vi.fn(async () => reply(BAD_KIND));

    await inAlpha(async () => {
      const result = await draftRuleFromSentence(ask(), {
        messages: stubMessages(create),
      });

      expect(result).toMatchObject({ ok: false, reason: "invalid_output" });
    });

    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not believe a rule that fails the engine's own validation", async () => {
    const overlapping = JSON.stringify({
      ...JSON.parse(RULE),
      tiers: [
        { minQuantity: 10, maxQuantity: 60, kind: "percentage", percentage: 5 },
        { minQuantity: 40, maxQuantity: null, kind: "percentage", percentage: 12 },
      ],
    });
    const create = vi.fn(async () => reply(overlapping));

    await inAlpha(async () => {
      const result = await draftRuleFromSentence(ask(), {
        messages: stubMessages(create),
      });
      expect(result).toMatchObject({ ok: false, reason: "invalid_output" });
    });
  });

  it("takes a refusal as an answer and does not retry it", async () => {
    const create = vi.fn(async () => reply("", { stop_reason: "refusal" }));

    await inAlpha(async () => {
      const result = await draftRuleFromSentence(ask(), {
        messages: stubMessages(create),
      });
      expect(result).toMatchObject({ ok: false, reason: "refused" });
    });

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses cleanly with no key, and the page still has a manual path", async () => {
    await inAlpha(async () => {
      const result = await draftRuleFromSentence(ask(), { messages: null });
      expect(result).toMatchObject({ ok: false, reason: "no_key", attempts: 0 });
    });
  });

  it("records the run under its own feature, either way", async () => {
    await inAlpha(async () => {
      await draftRuleFromSentence(ask(), {
        messages: stubMessages(async () => reply(RULE)),
      });

      const run = await db.aiRun.findFirstOrThrow();
      expect(run.feature).toBe("rule_from_sentence");
      expect(run.status).toBe("OK");
      expect(run.actorId).toBe("staff-1");
    });
  });

  it("keeps the merchant's sentence out of the run log", async () => {
    await inAlpha(async () => {
      await draftRuleFromSentence(ask("Buy 10 get 5% for Acme Ltd"), {
        messages: stubMessages(async () => reply(RULE)),
      });

      const run = await db.aiRun.findFirstOrThrow();
      // The run log is a cost and latency record. The sentence belongs to the
      // audit entry, next to the rule it made — not in a table of metrics.
      expect(JSON.stringify(run)).not.toContain("Acme");
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("grounding, and the shop it belongs to", () => {
  const BETA = "beta.myshopify.com";
  const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

  const collectionsAdmin: AdminGraphql = {
    graphql: async () => ({
      json: async () => ({
        data: {
          collections: {
            nodes: [{ id: "gid://shopify/Collection/1", title: "Sale", handle: "sale" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    }),
  };

  it("tells Claude about this shop's groups and nobody else's", async () => {
    await inBeta(() =>
      db.shop.create({
        data: {
          ...tenant(),
          planKey: "pro",
          billingStatus: "ACTIVE",
          currencyCode: "USD",
        },
      }),
    );

    const mine = await inAlpha(() =>
      db.customerGroup.create({
        data: { ...tenant(), name: "Gold", handle: "gold", tag: "gold" },
      }),
    );
    await inBeta(() =>
      db.customerGroup.create({
        data: { ...tenant(), name: "Platinum", handle: "platinum", tag: "platinum" },
      }),
    );

    const grounded = await inAlpha(() => loadGrounding(collectionsAdmin, "USD"));

    expect(grounded.groups.map((one) => one.name)).toEqual(["Gold"]);
    expect(grounded.groups[0]?.id).toBe(mine.id);
  });

  it("will not resolve a group id belonging to another shop", async () => {
    await inBeta(() =>
      db.shop.create({
        data: {
          ...tenant(),
          planKey: "pro",
          billingStatus: "ACTIVE",
          currencyCode: "USD",
        },
      }),
    );
    const theirs = await inBeta(() =>
      db.customerGroup.create({
        data: { ...tenant(), name: "Platinum", handle: "platinum", tag: "platinum" },
      }),
    );

    const draft = await inAlpha(async () => {
      const result = await draftRuleFromSentence(ask("Platinum group pays 30% off"), {
        messages: stubMessages(async () =>
          reply(
            JSON.stringify({
              ...JSON.parse(RULE),
              audience: { mode: "groups", tags: [], groups: ["Platinum"] },
            }),
          ),
        ),
      });
      if (!result.ok) throw new Error(result.detail);
      return result.value;
    });

    // Forged the way a tampered hidden field would: their id, in our shop.
    const forged = envelopeFor(
      "Platinum group pays 30% off",
      draft,
      { model: "m", promptVersion: "1", requestId: null },
      { Platinum: theirs.id },
    );

    const grounded = await inAlpha(() => loadGrounding(collectionsAdmin, "USD"));
    const prepared = prepareDraft(forged, grounded, NOW);

    // Not an error and not a leak — it reads as a term this shop cannot place.
    expect(prepared.rule.audience.groupIds).toEqual([]);
    expect(prepared.clarifications).toHaveLength(1);
    expect(JSON.stringify(prepared.rule)).not.toContain(theirs.id);
  });
});
