import type { AiRunStatus } from "@prisma/client";

import { db } from "~/db.server";
import { modelId, PROMPT_VERSIONS, type AiFeature } from "~/lib/ai/model";
import { tenant } from "~/lib/tenant/shop-context.server";

/**
 * Writing down what the app asked Claude.
 *
 * Operational, not evidential. The audit log records what a *merchant* decided;
 * this records what the app asked and what it cost, so "what has this been
 * doing on my behalf" and "why is my bill that" both have answers.
 *
 * **No prompt and no completion are stored.** They carry the merchant's product
 * data and their buyers' names. Token counts and a feature name answer the
 * questions this table exists for without holding either.
 */

export interface AiRunEntry {
  feature: AiFeature;
  status: AiRunStatus;
  latencyMs: number;
  attempts: number;
  requestId?: string | null;
  usage?: { inputTokens: number; outputTokens: number; cachedTokens: number };
  /** The provider's own words. Never the prompt, never the answer. */
  error?: string | null;
  actorId?: string | null;
}

/** How a run gets written. Injectable so the failure path can be exercised. */
export type RecordRun = (entry: AiRunEntry) => Promise<void>;

/**
 * Write a run, whatever happens.
 *
 * The guarantee lives here rather than inside `recordRun`, so it holds for any
 * recorder — a log this app could not write is a worse reason to deny a
 * merchant an answer than no answer at all, and that must not depend on which
 * implementation is in play.
 */
export async function recordSafely(record: RecordRun, entry: AiRunEntry): Promise<void> {
  try {
    await record(entry);
  } catch (error) {
    console.warn(
      `[mannon] could not record an AI run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** The real recorder. */
export const recordRun: RecordRun = async (entry) => {
  await db.aiRun.create({
    data: {
      ...tenant(),
      feature: entry.feature,
      status: entry.status,
      model: modelId(),
      promptVersion: PROMPT_VERSIONS[entry.feature],
      requestId: entry.requestId ?? null,
      inputTokens: entry.usage?.inputTokens ?? 0,
      outputTokens: entry.usage?.outputTokens ?? 0,
      cachedTokens: entry.usage?.cachedTokens ?? 0,
      latencyMs: entry.latencyMs,
      attempts: entry.attempts,
      // Truncated: a provider's message is not a place for unbounded text.
      error: entry.error ? entry.error.slice(0, 500) : null,
      actorId: entry.actorId ?? null,
    },
  });
};
