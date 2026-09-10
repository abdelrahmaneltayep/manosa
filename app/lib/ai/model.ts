/**
 * Which model Mannon asks, and how hard.
 *
 * One constant, read from the environment with a documented default, so moving
 * to a newer model is a deploy setting rather than a search through the app.
 *
 * `docs/spec/pages-features.md` and `CLAUDE.md` name `claude-sonnet-4-5`, which
 * is what ships here. It is a previous-generation id — the current equivalent
 * is `claude-sonnet-5`, and `claude-opus-5` is the more capable default — so
 * the choice is recorded in `DECISIONS.md` and flagged to the merchant's
 * operator rather than silently upgraded.
 *
 * Pure: no client, no environment mutation, importable from a test.
 */

/** Only what a lookup needs — narrower than `ProcessEnv`, so a test can pass two keys. */
export type EnvLike = Record<string, string | undefined>;

export const DEFAULT_MODEL = "claude-sonnet-4-5";

/** The model this deployment uses. */
export function modelId(env: EnvLike = process.env): string {
  return env.MANNON_AI_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * Every place Mannon asks Claude something.
 *
 * A closed list rather than a free string: it is what the run log is grouped
 * by, what a rate limit counts, and what a merchant sees when they ask what
 * the app has been doing on their behalf. A typo would quietly become a new
 * feature nobody can find.
 */
/*
 * `margin_guard` is deliberately absent. The guard is arithmetic over real
 * prices and real costs — `guardMargins` in the pricing engine — and the model
 * never computes what a module can (CLAUDE.md, appendix B). Claude drafts the
 * rule; the guard decides whether the draft loses money.
 */
export const AI_FEATURES = [
  "rule_from_sentence",
  "registration_screening",
  "email_draft",
  "segment_builder",
  "csv_whisperer",
  "merchant_briefing",
  "ask_mannon",
  "po_to_order",
  "quote_response",
  "buyer_agent",
  "reorder_prediction",
  "terms_risk",
] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

/**
 * How long any one call may take.
 *
 * Twenty seconds, from `CLAUDE.md`. Long enough for a considered answer, short
 * enough that a merchant who has been staring at a spinner gets the manual path
 * instead — which is the whole point of having one.
 */
export const AI_TIMEOUT_MS = 20_000;

/**
 * One retry, and only for failures a retry could fix.
 *
 * A malformed request or a refusal will fail identically the second time; all
 * retrying it does is make the merchant wait twice as long for the same manual
 * fallback.
 */
export const AI_MAX_ATTEMPTS = 2;

/** Ceiling on a single response. Generous — truncation mid-JSON is expensive. */
export const AI_MAX_TOKENS = 8_000;

/**
 * The version of the prompt that produced an answer.
 *
 * Recorded on every run and on every audit entry, so "why did it suggest that?"
 * has an answer six months later, after the wording has changed twice.
 */
export const PROMPT_VERSIONS: Readonly<Record<AiFeature, string>> = {
  rule_from_sentence: "1",
  registration_screening: "1",
  email_draft: "1",
  segment_builder: "1",
  csv_whisperer: "1",
  merchant_briefing: "1",
  ask_mannon: "1",
  po_to_order: "1",
  quote_response: "1",
  buyer_agent: "1",
  reorder_prediction: "1",
  terms_risk: "1",
};
