import Anthropic from "@anthropic-ai/sdk";

import { AI_TIMEOUT_MS, type EnvLike } from "~/lib/ai/model";

/**
 * The Anthropic client. Server-only, and constructed once.
 *
 * **The key never reaches the browser.** This module is `.server.ts`, so Remix
 * refuses to bundle it into a client build — and nothing in `app/components`
 * imports it. `qa/4.1/REPORT.md` records the bundle check.
 *
 * The product works with the key unset. `isAiAvailable()` is what every screen
 * asks before offering an AI control, and the run wrapper refuses cleanly
 * rather than throwing, so a store with no key gets the manual path.
 */

let client: Anthropic | null = null;

export function apiKey(env: EnvLike = process.env): string | null {
  return env.ANTHROPIC_API_KEY?.trim() || null;
}

export function isAiAvailable(env: EnvLike = process.env): boolean {
  return apiKey(env) !== null;
}

/**
 * The client, or null when there is no key.
 *
 * Null rather than a throw: "no key" is a supported state of this product, not
 * an error, and every caller already has a path for it.
 */
export function anthropic(): Anthropic | null {
  if (client) return client;

  const key = apiKey();
  if (!key) return null;

  client = new Anthropic({
    apiKey: key,
    // Milliseconds in this SDK. The wrapper also races its own timer, because
    // the SDK's timeout does not cover time spent inside a stream.
    timeout: AI_TIMEOUT_MS,
    // Retries are the wrapper's job: it decides what is worth retrying, counts
    // the attempt in the run log, and stops at one.
    maxRetries: 0,
  });

  return client;
}

/**
 * The slice of the SDK this app uses.
 *
 * Injectable, the same way a webhook handler takes an `AdminForShop`: it is how
 * the timeout, the retry rule and the failure paths get driven in a test
 * without a key and without reaching Anthropic. Nothing in the app passes it.
 */
export type MessagesApi = Pick<Anthropic["messages"], "create" | "stream">;

/** The messages API, or null when there is no key. */
export function messagesApi(): MessagesApi | null {
  return anthropic()?.messages ?? null;
}

/** Drop the cached client. For tests, and for a key rotated at runtime. */
export function resetAnthropicClient(): void {
  client = null;
}
