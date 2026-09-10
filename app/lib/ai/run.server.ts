import Anthropic from "@anthropic-ai/sdk";
import type { AiRunStatus } from "@prisma/client";

import { isAiAvailable, messagesApi, type MessagesApi } from "~/lib/ai/client.server";
import {
  AI_MAX_ATTEMPTS,
  AI_MAX_TOKENS,
  AI_TIMEOUT_MS,
  modelId,
  PROMPT_VERSIONS,
  type AiFeature,
} from "~/lib/ai/model";
import { recordRun, recordSafely, type RecordRun } from "~/lib/ai/runs.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * The one way this app talks to Claude.
 *
 * Everything the invariants ask for lives here, so no feature can forget it:
 * a timeout, one retry, a manual fallback, and a recorded run. Nothing in
 * `app/lib/ai/*` throws on a model failure — a caller always gets a verdict it
 * can act on, because "the model is down" has to be an ordinary state of a
 * product a merchant is trying to price their catalogue with.
 *
 * What is deliberately **not** here: any way to write to the database on the
 * model's say-so. This module returns text. Turning that into a change is the
 * feature's job, and `recordAudit` refuses an AI-assisted entry with no
 * approver — see `docs/adr/0018`.
 */

/** Why a call did not produce an answer. Each one has a manual path. */
export type AiFailure =
  "no_key" | "timeout" | "rate_limited" | "refused" | "invalid_output" | "error";

export interface AiSuccess<T> {
  ok: true;
  value: T;
  model: string;
  promptVersion: string;
  requestId: string | null;
  latencyMs: number;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
}

export interface AiRefusal {
  ok: false;
  reason: AiFailure;
  /** Operator-facing. Never shown to a merchant verbatim. */
  detail: string;
  latencyMs: number;
  attempts: number;
}

export type AiResult<T> = AiSuccess<T> | AiRefusal;

const STATUS: Readonly<Record<AiFailure, AiRunStatus>> = {
  no_key: "NO_KEY",
  timeout: "TIMEOUT",
  rate_limited: "RATE_LIMITED",
  refused: "REFUSED",
  invalid_output: "INVALID_OUTPUT",
  error: "ERROR",
};

/** Only these are worth a second attempt. */
const RETRYABLE: ReadonlySet<AiFailure> = new Set(["timeout", "rate_limited", "error"]);

/**
 * The two seams every AI path has.
 *
 * The same idiom a webhook handler uses for `AdminForShop`: the app never
 * passes these, and a test drives the timeout, the retry rule and the
 * failure paths without a key and without reaching Anthropic.
 */
export interface AiDeps {
  /** Null means "no key", which is a supported state, not an error. */
  messages?: MessagesApi | null;
  record?: RecordRun;
}

export interface AskOptions {
  feature: AiFeature;
  /** The stable half of the prompt. Cached, so it goes first and does not move. */
  system: string;
  /** The volatile half — this merchant's question. */
  user: string;
  /** Who asked. Null for scheduled work. */
  actorId?: string | null;
  maxTokens?: number;
  /**
   * Left unset unless a feature has a reason.
   *
   * `docs/spec/brand.md` asks for temperature 0 on the surfaces where Claude
   * pre-fills a form the merchant then approves: the same sentence should draft
   * the same rule twice, or "why did it suggest that?" has no answer. Anything
   * that reads back to a person as writing is better left at the model's own
   * default.
   */
  temperature?: number;
  /** Overrides the deployment timeout. Only a test should need this. */
  timeoutMs?: number;
}

/* -------------------------------------------------------------------------- */

/** A timeout the SDK's own cannot miss — its clock does not cover a stream. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

class TimeoutError extends Error {
  constructor() {
    super("The model did not answer in time.");
    this.name = "TimeoutError";
  }
}

/** Turn whatever came back into one of the failures a caller handles. */
export function classify(error: unknown): { reason: AiFailure; detail: string } {
  if (error instanceof TimeoutError) {
    return { reason: "timeout", detail: error.message };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { reason: "rate_limited", detail: "Rate limited by Anthropic." };
  }
  if (error instanceof Anthropic.AuthenticationError) {
    // Not retried: a bad key fails identically every time, and hammering it is
    // how an account gets locked.
    return { reason: "no_key", detail: "The Anthropic API key was rejected." };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { reason: "error", detail: `Bad request: ${error.message}` };
  }
  if (error instanceof Anthropic.APIError) {
    return {
      reason: "error",
      detail: `Anthropic error ${error.status}: ${error.message}`,
    };
  }
  return {
    reason: "error",
    detail: error instanceof Error ? error.message : String(error),
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Ask Claude for text.
 *
 * Returns a verdict, never throws. One retry, and only for something a retry
 * could fix.
 */
export async function askForText(
  options: AskOptions,
  deps: AiDeps = {},
): Promise<AiResult<string>> {
  const messages = deps.messages === undefined ? messagesApi() : deps.messages;
  const record = deps.record ?? recordRun;

  shopScope.require("askForText");
  const started = Date.now();

  if (!messages) {
    // Not an error. A store with no key uses the manual path, and the screen
    // says so rather than offering a button that cannot work.
    await recordSafely(record, {
      feature: options.feature,
      status: "NO_KEY",
      latencyMs: 0,
      attempts: 0,
      actorId: options.actorId,
    });
    return {
      ok: false,
      reason: "no_key",
      detail: "No Anthropic API key is configured.",
      latencyMs: 0,
      attempts: 0,
    };
  }

  let last: { reason: AiFailure; detail: string } = {
    reason: "error",
    detail: "Never attempted.",
  };

  for (let attempt = 1; attempt <= AI_MAX_ATTEMPTS; attempt += 1) {
    try {
      const message = await withTimeout(
        messages.create({
          model: modelId(),
          max_tokens: options.maxTokens ?? AI_MAX_TOKENS,
          // The stable half first and cached: it is the same on every call for
          // a feature, and a cache miss on it is the difference between a fast
          // answer and a slow one.
          system: [
            {
              type: "text",
              text: options.system,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: options.user }],
          ...(options.temperature === undefined
            ? {}
            : { temperature: options.temperature }),
        }),
        options.timeoutMs ?? AI_TIMEOUT_MS,
      );

      const latencyMs = Date.now() - started;

      // A decline is an answer, not a failure to get one — and never retried.
      if (message.stop_reason === "refusal") {
        await recordSafely(record, {
          feature: options.feature,
          status: "REFUSED",
          latencyMs,
          attempts: attempt,
          requestId: message.id,
          actorId: options.actorId,
        });
        return {
          ok: false,
          reason: "refused",
          detail: "The model declined this request.",
          latencyMs,
          attempts: attempt,
        };
      }

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();

      const usage = {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cachedTokens: message.usage.cache_read_input_tokens ?? 0,
      };

      if (!text) {
        // An empty answer is not a usable one. Treated as invalid output so
        // the caller falls back rather than rendering a blank draft.
        last = { reason: "invalid_output", detail: "The model returned nothing." };
        await recordSafely(record, {
          feature: options.feature,
          status: "INVALID_OUTPUT",
          latencyMs,
          attempts: attempt,
          requestId: message.id,
          usage,
          error: last.detail,
          actorId: options.actorId,
        });
        return { ok: false, ...last, latencyMs, attempts: attempt };
      }

      await recordSafely(record, {
        feature: options.feature,
        status: "OK",
        latencyMs,
        attempts: attempt,
        requestId: message.id,
        usage,
        actorId: options.actorId,
      });

      return {
        ok: true,
        value: text,
        model: message.model,
        promptVersion: PROMPT_VERSIONS[options.feature],
        requestId: message.id,
        latencyMs,
        attempts: attempt,
        usage,
      };
    } catch (error) {
      last = classify(error);
      if (!RETRYABLE.has(last.reason) || attempt === AI_MAX_ATTEMPTS) break;
    }
  }

  const latencyMs = Date.now() - started;
  await recordSafely(record, {
    feature: options.feature,
    status: STATUS[last.reason],
    latencyMs,
    attempts: AI_MAX_ATTEMPTS,
    error: last.detail,
    actorId: options.actorId,
  });

  return { ok: false, ...last, latencyMs, attempts: AI_MAX_ATTEMPTS };
}

/** Availability, for a screen deciding whether to offer an AI control. */
export { isAiAvailable };
