import Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { resetAnthropicClient, type MessagesApi } from "~/lib/ai/client.server";
import { askForJson } from "~/lib/ai/json.server";
import { askForText } from "~/lib/ai/run.server";
import { streamText, type StreamChunk } from "~/lib/ai/stream.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * The AI wrapper, against a stubbed Anthropic client.
 *
 * There is no API key in this environment, so nothing here reaches Anthropic.
 * What is being proved is the contract every feature depends on: a timeout, one
 * retry and only where a retry helps, a recorded run, a manual path on every
 * failure, and never a throw into a caller that is mid-way through a merchant's
 * request.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

/** A message the SDK would return. */
function reply(text: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_01test",
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 100 },
    ...overrides,
  };
}

/**
 * A stand-in for the SDK's messages API.
 *
 * Injected rather than mocked into the module, the same way a webhook handler
 * takes an `AdminForShop`: it is the seam the app already uses, and it keeps
 * these tests honest about what they replace.
 */
function stubMessages(
  create: (...args: unknown[]) => unknown,
  stream?: (...args: unknown[]) => unknown,
): MessagesApi {
  return { create, stream: stream ?? (() => {}) } as unknown as MessagesApi;
}

async function installShop(shop: string) {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        planKey: "agentic",
        billingStatus: "ACTIVE",
        currencyCode: "USD",
      },
    }),
  );
}

const ask = () => ({
  feature: "email_draft" as const,
  system: "You write short emails.",
  user: "Draft a reminder.",
});

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  resetAnthropicClient();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  resetAnthropicClient();
});

afterAll(async () => {
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */
/* With no key at all                                                          */
/* -------------------------------------------------------------------------- */

describe("with no API key", () => {
  it("refuses cleanly rather than throwing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    resetAnthropicClient();
    await installShop(ALPHA);

    await inAlpha(async () => {
      const result = await askForText(ask(), { messages: null });

      // The whole product works in this state. It is a verdict, not a crash.
      expect(result).toMatchObject({ ok: false, reason: "no_key", attempts: 0 });
    });
  });

  it("still writes the reason down, so a quiet feature is not a mystery", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    resetAnthropicClient();
    await installShop(ALPHA);

    await inAlpha(async () => {
      await askForText(ask(), { messages: null });
      const run = await db.aiRun.findFirstOrThrow();
      expect(run.status).toBe("NO_KEY");
      expect(run.feature).toBe("email_draft");
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The happy path                                                              */
/* -------------------------------------------------------------------------- */

describe("a successful call", () => {
  it("returns the text and records what it cost", async () => {
    await installShop(ALPHA);
    const messages = stubMessages(async () => reply("Dear buyer,"));

    await inAlpha(async () => {
      const result = await askForText(ask(), { messages });
      expect(result).toMatchObject({ ok: true, value: "Dear buyer,", attempts: 1 });

      const run = await db.aiRun.findFirstOrThrow();
      expect(run).toMatchObject({
        status: "OK",
        feature: "email_draft",
        inputTokens: 120,
        outputTokens: 40,
        cachedTokens: 100,
        attempts: 1,
        promptVersion: "1",
      });
    });
  });

  it("never writes the prompt or the answer down", async () => {
    await installShop(ALPHA);
    const secret = "Acme Ltd, buyer@acme.test, owes $12,000";
    const messages = stubMessages(async () => reply(`Reply mentioning ${secret}`));

    await inAlpha(async () => {
      await askForText({ ...ask(), user: secret }, { messages });

      // A merchant's product data and their buyers' names are not operational
      // telemetry. Token counts answer "what is this costing me" without them.
      const row = JSON.stringify(await db.aiRun.findFirstOrThrow());
      expect(row).not.toContain("Acme");
      expect(row).not.toContain("buyer@acme.test");
      expect(row).not.toContain("12,000");
    });
  });

  it("caches the stable half of the prompt, not the merchant's question", async () => {
    await installShop(ALPHA);
    const calls: Record<string, unknown>[] = [];
    const messages = stubMessages(async (body) => {
      calls.push(body as Record<string, unknown>);
      return reply("ok");
    });

    await inAlpha(() => askForText(ask(), { messages }));

    const system = calls[0]?.system as { cache_control?: unknown }[];
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("joins several text blocks rather than taking the first", async () => {
    await installShop(ALPHA);
    const messages = stubMessages(async () =>
      reply("", {
        content: [
          { type: "text", text: "Part one. " },
          { type: "thinking", thinking: "…" },
          { type: "text", text: "Part two." },
        ],
      }),
    );

    await inAlpha(async () => {
      const result = await askForText(ask(), { messages });
      expect(result).toMatchObject({ ok: true, value: "Part one. Part two." });
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Failure, and what a caller gets                                             */
/* -------------------------------------------------------------------------- */

describe("failures", () => {
  it("times out, and does not wait for the model", async () => {
    await installShop(ALPHA);
    // Never settles. Without a timer of our own this hangs a merchant's request.
    const messages = stubMessages(() => new Promise(() => {}));

    await inAlpha(async () => {
      const result = await askForText({ ...ask(), timeoutMs: 30 }, { messages });
      expect(result).toMatchObject({ ok: false, reason: "timeout" });
      expect((await db.aiRun.findFirstOrThrow()).status).toBe("TIMEOUT");
    });
  });

  it("retries a timeout once, and only once", async () => {
    await installShop(ALPHA);
    let attempts = 0;
    const messages = stubMessages(() => {
      attempts += 1;
      return new Promise(() => {});
    });

    await inAlpha(async () => {
      const result = await askForText({ ...ask(), timeoutMs: 20 }, { messages });
      expect(attempts).toBe(2);
      expect(result).toMatchObject({ ok: false, reason: "timeout", attempts: 2 });
    });
  });

  it("succeeds on the retry when the first attempt was a blip", async () => {
    await installShop(ALPHA);
    let attempts = 0;
    const messages = stubMessages(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("socket hang up");
      return reply("Second time lucky.");
    });

    await inAlpha(async () => {
      const result = await askForText(ask(), { messages });
      expect(result).toMatchObject({
        ok: true,
        value: "Second time lucky.",
        attempts: 2,
      });
      // One run row for the call, not one per attempt.
      expect(await db.aiRun.count()).toBe(1);
      expect((await db.aiRun.findFirstOrThrow()).attempts).toBe(2);
    });
  });

  it("does not retry a refusal — it would refuse identically", async () => {
    await installShop(ALPHA);
    let attempts = 0;
    const messages = stubMessages(async () => {
      attempts += 1;
      return reply("", { stop_reason: "refusal" });
    });

    await inAlpha(async () => {
      const result = await askForText(ask(), { messages });
      expect(attempts).toBe(1);
      expect(result).toMatchObject({ ok: false, reason: "refused" });
      expect((await db.aiRun.findFirstOrThrow()).status).toBe("REFUSED");
    });
  });

  it("does not retry a rejected key, which is how an account gets locked", async () => {
    await installShop(ALPHA);
    let attempts = 0;
    const messages = stubMessages(async () => {
      attempts += 1;
      throw new Anthropic.AuthenticationError(
        401,
        undefined,
        "invalid x-api-key",
        new Headers(),
      );
    });

    await inAlpha(async () => {
      const result = await askForText(ask(), { messages });
      expect(attempts).toBe(1);
      expect(result).toMatchObject({ ok: false, reason: "no_key" });
    });
  });

  it("treats an empty answer as unusable rather than rendering a blank draft", async () => {
    await installShop(ALPHA);
    const messages = stubMessages(async () => reply("   "));

    await inAlpha(async () => {
      const result = await askForText(ask(), { messages });
      expect(result).toMatchObject({ ok: false, reason: "invalid_output" });
    });
  });

  it("never throws, whatever comes back", async () => {
    await installShop(ALPHA);

    for (const fault of [
      new Error("boom"),
      "a string nobody should throw",
      null,
      { weird: true },
    ]) {
      const messages = stubMessages(async () => {
        throw fault;
      });

      await inAlpha(async () => {
        // A merchant mid-way through pricing their catalogue does not get a
        // stack trace because a model had a bad minute.
        const result = await askForText({ ...ask(), timeoutMs: 50 }, { messages });
        expect(result.ok).toBe(false);
      });
    }
  });

  it("answers even when the run cannot be recorded", async () => {
    await installShop(ALPHA);
    const messages = stubMessages(async () => reply("Still useful."));
    // Injected rather than mocked onto `db`: a Prisma delegate resolves its
    // methods through a proxy, so `vi.spyOn` on one cannot be restored — it
    // leaves the method `undefined` for every later test in the file.
    const record = async () => {
      throw new Error("disk full");
    };

    await inAlpha(async () => {
      // A log this app could not write is a worse reason to deny an answer
      // than no answer at all.
      const result = await askForText(ask(), { messages, record });
      expect(result).toMatchObject({ ok: true, value: "Still useful." });
      expect(await db.aiRun.count()).toBe(0);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* JSON                                                                        */
/* -------------------------------------------------------------------------- */

describe("askForJson", () => {
  const validate = (value: unknown) => {
    const record = value as { name?: unknown; percentage?: unknown };
    if (typeof record.name !== "string") {
      return { ok: false as const, error: "`name` must be a string." };
    }
    if (typeof record.percentage !== "number") {
      return { ok: false as const, error: "`percentage` must be a number." };
    }
    return {
      ok: true as const,
      value: { name: record.name, percentage: record.percentage },
    };
  };

  it("parses and validates a good answer", async () => {
    await installShop(ALPHA);
    const messages = stubMessages(async () => reply('{"name":"Gold","percentage":35}'));

    await inAlpha(async () => {
      const result = await askForJson({ ...ask(), validate }, { messages });
      expect(result).toMatchObject({ ok: true, value: { name: "Gold", percentage: 35 } });
    });
  });

  it("unwraps a fenced answer without spending a repair", async () => {
    await installShop(ALPHA);
    let calls = 0;
    const messages = stubMessages(async () => {
      calls += 1;
      return reply('```json\n{"name":"Gold","percentage":35}\n```');
    });

    await inAlpha(async () => {
      const result = await askForJson({ ...ask(), validate }, { messages });
      expect(result.ok).toBe(true);
      expect(calls).toBe(1);
    });
  });

  it("repairs once, handing back what was wrong", async () => {
    await installShop(ALPHA);
    const prompts: string[] = [];
    let calls = 0;
    const messages = stubMessages(async (body) => {
      calls += 1;
      const sent = (body as { messages: { content: string }[] }).messages;
      prompts.push(sent[0]!.content);
      return calls === 1
        ? reply('{"name":"Gold"}')
        : reply('{"name":"Gold","percentage":35}');
    });

    await inAlpha(async () => {
      const result = await askForJson({ ...ask(), validate }, { messages });
      expect(result).toMatchObject({ ok: true, value: { name: "Gold", percentage: 35 } });
      expect(calls).toBe(2);
      // The repair says what a correct answer looks like, not just "wrong".
      expect(prompts[1]).toContain("`percentage` must be a number.");
    });
  });

  it("gives up after one repair, so a merchant is not billed for a loop", async () => {
    await installShop(ALPHA);
    let calls = 0;
    const messages = stubMessages(async () => {
      calls += 1;
      return reply("not json at all");
    });

    await inAlpha(async () => {
      const result = await askForJson({ ...ask(), validate }, { messages });
      expect(result).toMatchObject({ ok: false, reason: "invalid_output" });
      expect(calls).toBe(2);
    });
  });

  it("never returns a value that failed the caller's own check", async () => {
    await installShop(ALPHA);
    const messages = stubMessages(async () =>
      reply('{"name":"Gold","percentage":"thirty-five"}'),
    );

    await inAlpha(async () => {
      const result = await askForJson({ ...ask(), validate }, { messages });
      // A half-valid rule reaching a merchant's pricing is what the invariants
      // forbid; the caller gets the manual path instead.
      expect(result.ok).toBe(false);
    });
  });

  it("passes a transport failure straight through", async () => {
    await installShop(ALPHA);
    const messages = stubMessages(() => new Promise(() => {}));

    await inAlpha(async () => {
      const result = await askForJson(
        { ...ask(), timeoutMs: 20, validate },
        { messages },
      );
      expect(result).toMatchObject({ ok: false, reason: "timeout" });
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Streaming                                                                   */
/* -------------------------------------------------------------------------- */

describe("streamText", () => {
  /** A stream the SDK would hand back. */
  function fakeStream(parts: string[], final: Record<string, unknown> = {}) {
    return () => ({
      async *[Symbol.asyncIterator]() {
        for (const text of parts) {
          yield { type: "content_block_delta", delta: { type: "text_delta", text } };
        }
      },
      finalMessage: async () => reply(parts.join(""), final),
      abort: () => {},
    });
  }

  const collect = async (messages: MessagesApi | null) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamText(
      {
        feature: "buyer_agent",
        system: "You are a concierge.",
        user: "What is my price for 100 mugs?",
        timeoutMs: 500,
      },
      { messages },
    )) {
      chunks.push(chunk);
    }
    return chunks;
  };

  it("yields each delta and then the whole answer", async () => {
    await installShop(ALPHA);
    const messages = stubMessages(
      async () => reply(""),
      fakeStream(["Your ", "price ", "is $6.50."]),
    );

    await inAlpha(async () => {
      const chunks = await collect(messages);
      expect(chunks.filter((chunk) => chunk.type === "text")).toHaveLength(3);
      expect(chunks.at(-1)).toMatchObject({
        type: "done",
        text: "Your price is $6.50.",
      });
      expect((await db.aiRun.findFirstOrThrow()).status).toBe("OK");
    });
  });

  it("ends with a failure chunk rather than throwing into the caller's loop", async () => {
    await installShop(ALPHA);
    const messages = stubMessages(
      async () => reply(""),
      () => {
        throw new Error("stream refused to open");
      },
    );

    await inAlpha(async () => {
      const chunks = await collect(messages);
      expect(chunks).toEqual([
        { type: "failed", reason: "error", detail: "stream refused to open" },
      ]);
      expect((await db.aiRun.findFirstOrThrow()).status).toBe("ERROR");
    });
  });

  it("keeps what already arrived when the stream dies mid-sentence", async () => {
    await installShop(ALPHA);
    const messages = stubMessages(
      async () => reply(""),
      () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Your " },
          };
          throw new Error("connection reset");
        },
        finalMessage: async () => reply(""),
        abort: () => {},
      }),
    );

    await inAlpha(async () => {
      const chunks = await collect(messages);
      // Something is on screen, and the UI decides whether to keep it.
      expect(chunks[0]).toEqual({ type: "text", text: "Your " });
      expect(chunks.at(-1)).toMatchObject({ type: "failed", reason: "error" });
    });
  });

  it("reports a refusal as a failure, not as an empty answer", async () => {
    await installShop(ALPHA);
    const messages = stubMessages(
      async () => reply(""),
      fakeStream([], { stop_reason: "refusal" }),
    );

    await inAlpha(async () => {
      const chunks = await collect(messages);
      expect(chunks.at(-1)).toMatchObject({ type: "failed", reason: "refused" });
    });
  });

  it("refuses cleanly with no key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    resetAnthropicClient();
    await installShop(ALPHA);

    await inAlpha(async () => {
      const chunks = await collect(null);
      expect(chunks).toEqual([
        {
          type: "failed",
          reason: "no_key",
          detail: "No Anthropic API key is configured.",
        },
      ]);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The tenant boundary                                                         */
/* -------------------------------------------------------------------------- */

describe("tenant boundary", () => {
  it("refuses to run at all outside a shop scope", async () => {
    await installShop(ALPHA);
    const messages = stubMessages(async () => reply("ok"));

    // An AI call with no tenant is a call whose run row would land nowhere and
    // whose buyer facts could come from anyone.
    await expect(askForText(ask(), { messages })).rejects.toThrow();
  });

  it("never shows one shop's runs to another", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const messages = stubMessages(async () => reply("ok"));

    await inAlpha(() => askForText(ask(), { messages }));

    await inBeta(async () => {
      expect(await db.aiRun.count()).toBe(0);
    });
    await inAlpha(async () => {
      expect(await db.aiRun.count()).toBe(1);
    });
  });
});
