import { askForJson } from "~/lib/ai/json.server";
import type { AiDeps, AiResult } from "~/lib/ai/run.server";
import { checkReply, fillSlots } from "~/lib/ai/prompts/buyer-agent.server";

/**
 * ✦ The monthly review.
 *
 * Checklist §7: "generated 1st of month, kept forever, diff vs previous month;
 * every recommendation has a one-click draft action + 'why' expander showing
 * the data behind it."
 *
 * Two rules hold it up, and both are already load-bearing elsewhere in this
 * app:
 *
 * - **The model writes no numbers.** It writes `{{f1}}` and this app
 *   substitutes — the same guard the Buyer Agent rests on, reused rather than
 *   re-implemented, because it is the check that must not be weakened twice.
 * - **A recommendation is a link, never a change.** `action` is one of a closed
 *   list of pages the merchant does it on. Nothing here writes; the "why"
 *   expander shows the stored facts, so a merchant can disagree with the advice
 *   by checking the figures it came from.
 */

export const MAX_SECTIONS = 5;
export const MAX_BODY = 320;

/**
 * Where a recommendation can send the merchant.
 *
 * A closed list of our own pages. There is no action that performs anything —
 * the most a wrong recommendation can do is open the wrong page.
 */
export const REVIEW_ACTIONS = [
  "open_pricing",
  "open_rule_builder",
  "open_segments",
  "open_applications",
  "open_terms",
  "open_quotes",
  "open_agent",
  "open_forms",
] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const REVIEW_KINDS = [
  /** What went well. */
  "worked",
  /** A rule earning nothing, a form nobody finishes. */
  "dead_weight",
  /** Something to try next month. */
  "experiment",
  /** A buyer going quiet, an invoice ageing. */
  "risk",
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export interface ReviewSection {
  kind: ReviewKind;
  /** A short line. May contain slots; never a figure the model invented. */
  headline: string;
  body: string;
  /** Null when the section is an observation rather than a recommendation. */
  action: ReviewAction | null;
  /** Which stored facts this section was written from, for the "why". */
  because: string[];
}

export interface ReviewAnswer {
  quiet: boolean;
  sections: ReviewSection[];
}

export const REVIEW_SYSTEM = `You write one month's review of a Shopify merchant's wholesale business, for the Mannon app. You are given figures that have already been computed. You never compute, estimate or state a figure yourself.

Answer with a single JSON object and nothing else:

{
  "quiet": boolean,
  "sections": [
    { "kind": string, "headline": string, "body": string, "action": string | null, "because": [string] }
  ]
}

"kind" is one of: worked, dead_weight, experiment, risk.

"action" is null, or exactly one of: open_pricing, open_rule_builder, open_segments, open_applications, open_terms, open_quotes, open_agent, open_forms.

"because" lists the fact lines you used, copied exactly as they were given to you.

**Numbers.** Every figure is a slot: write {{f1}}, {{q2}}, {{n1}} — the names you were given — and the app puts the value in. Never write a digit, a percentage, a currency symbol or a number in words ("nine hundred", "twice", "a third", "double"). A sentence with a number you typed yourself, in digits or in words, is thrown away.

**Last month's figures are separate slots, prefixed p_.** {{p_f1}} is last month's wholesale revenue, {{f1}} is this month's. Never use a this-month slot in a sentence about last month.

Rules:
- At most ${MAX_SECTIONS} sections. Fewer is better than padding.
- Lead with what changed against last month, where you were given last month's figures.
- A recommendation must be something the merchant does on one of the pages above. Never tell them you have done anything.
- If the month has nothing worth a merchant's attention, set "quiet" to true and return no sections. An empty month said plainly beats five paragraphs about nothing.
- Write in the merchant's language.`;

export function reviewUser(input: {
  month: string;
  locale: string;
  facts: string[];
  previous: string[];
  slots: Readonly<Record<string, string>>;
}): string {
  return [
    `Month: ${input.month}`,
    `Merchant's language: ${input.locale}`,
    "",
    "This month:",
    ...input.facts.map((fact) => `- ${fact}`),
    "",
    input.previous.length > 0
      ? "The month before (its slots are the p_ ones):"
      : "There is no previous month.",
    ...input.previous.map((fact) => `- ${fact}`),
    "",
    "Slots you may write, and nothing else:",
    ...Object.keys(input.slots).map((name) => `- {{${name}}}`),
  ].join("\n");
}

/* -------------------------------------------------------------------------- */

/**
 * `text` cut to `limit`, never mid-slot.
 *
 * If the cut leaves an unterminated `{{`, the whole partial slot goes with it.
 */
export function trimToSlotBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const open = cut.lastIndexOf("{{");
  if (open !== -1 && !cut.slice(open).includes("}}")) return cut.slice(0, open).trimEnd();
  return cut;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const KINDS: ReadonlySet<string> = new Set(REVIEW_KINDS);
const ACTIONS: ReadonlySet<string> = new Set(REVIEW_ACTIONS);

/**
 * Read a review, refusing any sentence that states a figure.
 *
 * The check runs inside the validator rather than after it, so a reply that
 * writes its own number is repaired by the one retry `askForJson` already has
 * — and if the repair does the same thing, the merchant gets the manual
 * fallback rather than a review with a made-up total in it.
 */
export function readReview(
  slots: Readonly<Record<string, string>>,
): (value: unknown) => { ok: true; value: ReviewAnswer } | { ok: false; error: string } {
  return (value) => {
    if (!isRecord(value))
      return { ok: false, error: "The answer was not a JSON object." };

    if (value.quiet === true) return { ok: true, value: { quiet: true, sections: [] } };

    const raw = value.sections;
    if (!Array.isArray(raw)) {
      return { ok: false, error: '"sections" must be an array.' };
    }

    const sections: ReviewSection[] = [];
    for (const entry of raw.slice(0, MAX_SECTIONS)) {
      if (!isRecord(entry)) return { ok: false, error: "A section was not an object." };

      const kind = entry.kind;
      if (typeof kind !== "string" || !KINDS.has(kind)) {
        return { ok: false, error: `"${String(kind)}" is not one of the kinds.` };
      }

      const headline = typeof entry.headline === "string" ? entry.headline.trim() : "";
      const body = typeof entry.body === "string" ? entry.body.trim() : "";
      if (headline === "" || body === "") {
        return { ok: false, error: "Every section needs a headline and a body." };
      }

      const because = Array.isArray(entry.because)
        ? entry.because
            .filter((line): line is string => typeof line === "string")
            .slice(0, 6)
        : [];

      // Truncated here, before the check and the substitution, and never
      // through a slot. Slicing a body after `checkReply` and before
      // `fillSlots` cut slots in half and stored a dangling "{{" that rendered
      // at the merchant and was kept forever; slicing through one before the
      // check is worse, because the orphaned "f1" then reads as an invented
      // figure and throws the whole review away.
      const trimmed = trimToSlotBoundary(body, MAX_BODY);

      // `because` is the audit trail — the one field Invariant 5 rests on. It
      // was checked by nothing, so a model-authored "$9,999,999" reached the
      // merchant on the same screen that promises it cannot.
      for (const text of [headline, trimmed, ...because]) {
        const checked = checkReply(text, slots);
        if (!checked.ok)
          return { ok: false, error: checked.error ?? "A figure was invented." };
      }

      const action = entry.action;
      if (action !== null && action !== undefined && typeof action !== "string") {
        return { ok: false, error: '"action" must be a string or null.' };
      }
      if (typeof action === "string" && !ACTIONS.has(action)) {
        return { ok: false, error: `"${action}" is not one of the actions.` };
      }

      sections.push({
        kind: kind as ReviewKind,
        headline,
        body: trimmed,
        action: typeof action === "string" ? (action as ReviewAction) : null,
        because,
      });
    }

    // A review with no sections and `quiet` unset is the model failing to
    // answer, not a quiet month — those are different and the screen shows
    // them differently.
    if (sections.length === 0) {
      return { ok: false, error: "Return at least one section, or set quiet to true." };
    }

    return { ok: true, value: { quiet: false, sections } };
  };
}

export async function writeMonthlyReview(
  input: {
    month: string;
    locale: string;
    facts: string[];
    previous: string[];
    slots: Readonly<Record<string, string>>;
    actorId: string | null;
  },
  deps: AiDeps = {},
): Promise<AiResult<ReviewAnswer>> {
  const answered = await askForJson<ReviewAnswer>(
    {
      feature: "monthly_review",
      system: REVIEW_SYSTEM,
      user: reviewUser(input),
      actorId: input.actorId,
      validate: readReview(input.slots),
    },
    deps,
  );

  if (!answered.ok) return answered;

  // Substituted only after the check passed, so what is stored is what a
  // merchant reads and the figures in it are this app's.
  return {
    ...answered,
    value: {
      quiet: answered.value.quiet,
      sections: answered.value.sections.map((section) => ({
        ...section,
        headline: fillSlots(section.headline, input.slots),
        body: fillSlots(section.body, input.slots),
        // The "why" expander showed "wholesale revenue: {{f1}}" to a merchant,
        // which is the audit trail rendering a placeholder.
        because: section.because.map((line) => fillSlots(line, input.slots)),
      })),
    },
  };
}
