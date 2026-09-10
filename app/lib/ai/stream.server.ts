import { messagesApi } from "~/lib/ai/client.server";
import { AI_MAX_TOKENS, AI_TIMEOUT_MS, modelId, type AiFeature } from "~/lib/ai/model";
import { classify, type AiDeps, type AiFailure } from "~/lib/ai/run.server";
import { recordRun, recordSafely } from "~/lib/ai/runs.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Streaming, for the two places a merchant watches an answer arrive: the
 * ✦ rule builder and the agents.
 *
 * Non-streaming is right for everything else — a rule the merchant will approve
 * does not need to appear a word at a time, and a single response is simpler to
 * validate. This exists because a chat that pauses for eight seconds reads as
 * broken, and a builder that types out its reasoning is legible in a way a
 * spinner is not.
 *
 * The same rules hold: a timeout, a recorded run, and never a throw into the
 * caller's loop. A stream that dies mid-sentence yields a failure chunk and
 * stops, so the UI can fall back to the manual path with something on screen.
 */

export interface StreamOptions {
  feature: AiFeature;
  system: string;
  user: string;
  actorId?: string | null;
  maxTokens?: number;
  timeoutMs?: number;
}

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "done"; text: string; requestId: string | null }
  | { type: "failed"; reason: AiFailure; detail: string };

/**
 * Yield the answer as it arrives.
 *
 * The timeout is on the whole stream, not on each chunk: a model that emits one
 * word every nineteen seconds is not working, however alive the connection is.
 */
export async function* streamText(
  options: StreamOptions,
  deps: AiDeps = {},
): AsyncGenerator<StreamChunk, void, undefined> {
  const messages = deps.messages === undefined ? messagesApi() : deps.messages;
  const record = deps.record ?? recordRun;

  shopScope.require("streamText");
  const started = Date.now();

  if (!messages) {
    await recordSafely(record, {
      feature: options.feature,
      status: "NO_KEY",
      latencyMs: Date.now() - started,
      attempts: 0,
      actorId: options.actorId,
    });
    yield {
      type: "failed",
      reason: "no_key",
      detail: "No Anthropic API key is configured.",
    };
    return;
  }

  const deadline = started + (options.timeoutMs ?? AI_TIMEOUT_MS);
  let text = "";

  try {
    const stream = messages.stream({
      model: modelId(),
      max_tokens: options.maxTokens ?? AI_MAX_TOKENS,
      system: [
        { type: "text", text: options.system, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: options.user }],
    });

    for await (const event of stream) {
      if (Date.now() > deadline) {
        // Abort rather than leave a request running that nobody will read.
        stream.abort();
        await recordSafely(record, {
          feature: options.feature,
          status: "TIMEOUT",
          latencyMs: Date.now() - started,
          attempts: 1,
          actorId: options.actorId,
        });
        yield {
          type: "failed",
          reason: "timeout",
          detail: "The model did not finish in time.",
        };
        return;
      }

      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta" &&
        event.delta.text
      ) {
        text += event.delta.text;
        yield { type: "text", text: event.delta.text };
      }
    }

    const message = await stream.finalMessage();
    const latencyMs = Date.now() - started;

    if (message.stop_reason === "refusal") {
      await recordSafely(record, {
        feature: options.feature,
        status: "REFUSED",
        latencyMs,
        attempts: 1,
        requestId: message.id,
        actorId: options.actorId,
      });
      yield {
        type: "failed",
        reason: "refused",
        detail: "The model declined this request.",
      };
      return;
    }

    await recordSafely(record, {
      feature: options.feature,
      status: "OK",
      latencyMs,
      attempts: 1,
      requestId: message.id,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cachedTokens: message.usage.cache_read_input_tokens ?? 0,
      },
      actorId: options.actorId,
    });

    yield { type: "done", text, requestId: message.id };
  } catch (error) {
    const { reason, detail } = classify(error);
    await recordSafely(record, {
      feature: options.feature,
      status: statusFor(reason),
      latencyMs: Date.now() - started,
      attempts: 1,
      error: detail,
      actorId: options.actorId,
    });
    // Whatever arrived before the fault is already on screen; the UI decides
    // whether to keep it or offer the manual path.
    yield { type: "failed", reason, detail };
  }
}

const statusFor = (reason: AiFailure) =>
  reason === "timeout"
    ? "TIMEOUT"
    : reason === "rate_limited"
      ? "RATE_LIMITED"
      : reason === "refused"
        ? "REFUSED"
        : reason === "no_key"
          ? "NO_KEY"
          : "ERROR";
