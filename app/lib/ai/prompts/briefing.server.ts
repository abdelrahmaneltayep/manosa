import { askForJson } from "~/lib/ai/json.server";
import type { AiDeps, AiResult } from "~/lib/ai/run.server";
import { isFactKind, type AgentFact, type FactKind } from "~/lib/agent/facts.server";

/**
 * ✦ The Merchant Agent's daily briefing.
 *
 * Checklist §1: "max 3 items, each with one action button", and "briefing never
 * invents a metric — every number linked to its Analytics source."
 *
 * That second line is why this module returns **kinds, not sentences**. The
 * model is given the facts this app computed and answers with which three
 * matter most, in what order, and why. Every number on the screen came from
 * `briefingFacts`; the model never supplies one, and cannot, because there is
 * nowhere in the answer to put one.
 *
 * The "why" is one short line in the merchant's language — the only free text
 * in the briefing, and it is shown as the agent's words rather than as a fact.
 */

export const MAX_ITEMS = 3;
/** A reason longer than this is a paragraph, and nobody reads it at 9am. */
export const MAX_REASON = 140;

export interface BriefingItem {
  kind: FactKind;
  /** One short line, in the merchant's language. Never a number. */
  reason: string;
}

export interface BriefingAnswer {
  items: BriefingItem[];
}

export const BRIEFING_SYSTEM = `You are the Merchant Agent in Mannon, a Shopify wholesale-pricing app. Each morning you tell one merchant what needs them today.

You are given everything the app currently knows about their shop, as a list of facts. Choose at most three that deserve their attention, most important first.

Answer with a single JSON object and nothing else:

{ "items": [ { "kind": string, "reason": string } ] }

"kind" must be the kind of a fact you were given, exactly as written. You may not invent one, and you may not repeat one.

"reason" is one short line — under 140 characters — saying why it matters today. Rules for it:
- Never put a number in it. The app renders its own figures next to your line; a number you write would be a second, competing one.
- Never state a fact you were not given. No trends, no forecasts, no comparisons to other shops.
- Say what it means for them, not what it is. The screen already says what it is.
- Write in the merchant's language, named below.
- Plain and calm. No exclamation marks, no urgency the facts do not support, no "Don't miss out".

Choosing:
- Money at risk and people waiting come before tidiness. An overdue invoice or an application sitting for days matters more than an unused rule.
- Something the merchant can act on today beats something that is merely true.
- Fewer is fine. If only one fact deserves them, return one. If none does, return an empty list — a quiet morning is a real answer and they will trust you more for it.`;

export function briefingUser(
  facts: readonly AgentFact[],
  options: { locale: string; muted: readonly string[] },
): string {
  const lines = facts.map((fact) => {
    const parts = [`kind: ${fact.kind}`, `count: ${fact.count}`];
    if (fact.amount)
      parts.push(
        `amount: ${fact.amount.amount} minor units of ${fact.amount.currencyCode}`,
      );
    if (fact.subject) parts.push(`about: ${fact.subject}`);
    return `- ${parts.join(" · ")}`;
  });

  return [
    `Merchant's language: ${options.locale}`,
    options.muted.length > 0
      ? `They have asked not to hear about: ${options.muted.join(", ")}`
      : "They have not muted anything.",
    "",
    "What the app knows right now:",
    lines.length > 0 ? lines.join("\n") : "- (nothing at all)",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Digits in a reason mean the model supplied a figure. It may not.
 *
 * `/\d/` is ASCII-only, and the prompt is handed the merchant's locale — so an
 * Arabic-language shop is precisely where a model writes ٦ and walks past the
 * one rule this feature rests on. Arabic-Indic and Extended Arabic-Indic digits
 * are here for that reason.
 *
 * Spelled-out numerals still get through. That is a real limit, and the reason
 * the figure beside the line is ours: a sentence saying "six" next to our own
 * "6 applications" is redundant, not wrong.
 */
const HAS_NUMBER = /[\d\u0660-\u0669\u06F0-\u06F9]/u;

/**
 * Narrow the answer against the facts it was given.
 *
 * A kind that was not offered is refused rather than dropped: it means the
 * model is talking about something that is not true of this shop, and the next
 * thing it says cannot be trusted either.
 */
export function readBriefing(
  value: unknown,
  facts: readonly AgentFact[],
): { ok: true; value: BriefingAnswer } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "The answer was not a JSON object." };
  if (!Array.isArray(value.items)) {
    return { ok: false, error: `"items" must be an array.` };
  }

  const offered = new Set(facts.map((fact) => fact.kind));
  const seen = new Set<string>();
  const items: BriefingItem[] = [];

  for (const raw of value.items) {
    if (!isRecord(raw)) return { ok: false, error: "Every item must be an object." };

    const kind = raw.kind;
    if (typeof kind !== "string" || !isFactKind(kind)) {
      return { ok: false, error: `"${String(kind)}" is not one of the kinds.` };
    }
    if (!offered.has(kind)) {
      return {
        ok: false,
        error: `"${kind}" is not true of this shop today. Only use the kinds you were given.`,
      };
    }
    if (seen.has(kind)) continue;
    seen.add(kind);

    const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
    if (!reason) return { ok: false, error: `"${kind}" needs a reason.` };
    if (reason.length > MAX_REASON) {
      return {
        ok: false,
        error: `The reason for "${kind}" must be under ${MAX_REASON} characters.`,
      };
    }
    if (HAS_NUMBER.test(reason)) {
      // The one rule the whole feature rests on. The app renders the figure;
      // a second number written by the model is the one that can be wrong.
      return {
        ok: false,
        error: `The reason for "${kind}" contains a number. The app shows its own figures — say why it matters, not how many.`,
      };
    }

    items.push({ kind, reason });
  }

  return { ok: true, value: { items: items.slice(0, MAX_ITEMS) } };
}

/** Ask for a briefing. Never throws; never writes. */
export function draftBriefing(
  facts: readonly AgentFact[],
  options: { locale: string; muted: readonly string[] },
  deps: AiDeps = {},
): Promise<AiResult<BriefingAnswer>> {
  return askForJson<BriefingAnswer>(
    {
      feature: "merchant_briefing",
      system: BRIEFING_SYSTEM,
      user: briefingUser(facts, options),
      // Nobody's click: the briefing is generated by a job.
      actorId: null,
      temperature: 0,
      maxTokens: 1_000,
      validate: (value) => readBriefing(value, facts),
    },
    deps,
  );
}
