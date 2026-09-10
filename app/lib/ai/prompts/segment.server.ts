import { parseMoney } from "@mannon/pricing-engine";

import { askForJson } from "~/lib/ai/json.server";
import type { AiDeps, AiResult } from "~/lib/ai/run.server";
import {
  readCondition,
  validateSegment,
  type SegmentCondition,
} from "~/lib/customers/segments";

/**
 * ✦ A segment from a sentence.
 *
 * Checklist §3: "Query streamed to visible filter chips (spend > $5k · last
 * order > 45d) — chips editable after generation (AI output is inspectable, not
 * a black box)."
 *
 * The inspectability is the feature. What comes back is not a query, it is a
 * short list of conditions the merchant can read, remove and re-run — and every
 * one of them is checked by `readCondition`, the same reader that guards a
 * segment typed by hand and one loaded from the database.
 *
 * Group names in, group ids out, resolved here — never by the model. Same rule
 * as ✦ Describe a rule: a model asked for an id will produce one that looks
 * right, and there is no way to tell it from a real one except by looking it up.
 */

export interface SegmentGrounding {
  currencyCode: string;
  groups: { id: string; name: string }[];
  /** Customer tags in use, so the model names ones that exist. */
  tags: string[];
}

export interface NamedSegment {
  /** A short name for the segment, in the merchant's words. */
  name: string;
  /** Conditions with group **names** where ids belong. */
  conditions: SegmentCondition[];
  notes: string | null;
}

export const SEGMENT_SYSTEM = `You turn one sentence from a Shopify merchant into a customer filter for the Mannon wholesale app.

Answer with a single JSON object and nothing else:

{
  "name": string,          // short, in the merchant's words, under 60 characters
  "conditions": [ ... ],   // 1 to 8 conditions, all of which must be true
  "notes": string | null   // one sentence: anything you assumed or could not express
}

Every condition is exactly one of these shapes:

  { "field": "lifetime_spend",  "op": "gt"|"gte"|"lt"|"lte", "amount": "5000.00" }
  { "field": "order_count",     "op": "gt"|"gte"|"lt"|"lte", "value": 3 }
  { "field": "last_order_days", "op": "gt"|"gte"|"lt"|"lte", "value": 45 }
  { "field": "never_ordered" }
  { "field": "tag",     "op": "has"|"not_has", "value": "wholesale" }
  { "field": "group",   "op": "is"|"is_not",   "group": "Gold" }
  { "field": "country", "op": "is"|"is_not",   "value": "SA" }
  { "field": "tax_exempt", "value": true }
  { "field": "status",  "value": "PENDING"|"APPROVED"|"REJECTED" }

Rules:
- Conditions are ANDed. There is no OR and no nesting. If the sentence needs one, get as close as you can with AND and say what you dropped in "notes".
- "last_order_days" counts days since their last order. "No order in 45 days" is op "gt", value 45. "Ordered in the last week" is op "lt", value 7.
- Someone who has never ordered is not "quiet for 45 days" — that is "never_ordered". Use it when the merchant means people who have never bought.
- "amount" is a plain decimal in the shop's currency, as a string. No symbol, no thousands separator. "$5k" is "5000.00".
- Use only group names and tags from the lists you are given. If the merchant means something that is not there, use their words anyway and say so in "notes" — they will be asked which they meant.
- "country" is a two-letter ISO country code.
- Never use the same field twice, except "tag", which may appear more than once.
- Only include a condition the sentence actually asks for. Do not add a "status is APPROVED" nobody asked for.`;

export function segmentUser(sentence: string, grounding: SegmentGrounding): string {
  const list = (items: string[]) =>
    items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none)";

  return [
    `Shop currency: ${grounding.currencyCode}`,
    "",
    "Customer groups in this shop:",
    list(grounding.groups.map((group) => group.name)),
    "",
    "Customer tags in use:",
    list(grounding.tags),
    "",
    "The merchant's sentence:",
    sentence,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The model's JSON → conditions, with group **names** still in the id slots.
 *
 * Money arrives as a decimal string and goes through `parseMoney`, which is the
 * only thing in this codebase allowed to make minor units out of one. A
 * hardcoded ×100 has been written three times here and is wrong in KWD both
 * times it shipped.
 */
export function readNamedSegment(
  value: unknown,
  grounding: SegmentGrounding,
): { ok: true; value: NamedSegment } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "The answer was not a JSON object." };

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!Array.isArray(value.conditions)) {
    return { ok: false, error: `"conditions" must be an array.` };
  }

  const conditions: SegmentCondition[] = [];

  for (const [index, raw] of value.conditions.entries()) {
    if (!isRecord(raw)) {
      return { ok: false, error: `conditions[${index}] must be an object.` };
    }

    // Two shapes the model answers in that the reader does not take: money as a
    // decimal string, and a group by name. Both are converted here, so
    // everything downstream sees one shape.
    const prepared: Record<string, unknown> = { ...raw };

    if (raw.field === "lifetime_spend") {
      if (typeof raw.amount !== "string") {
        return {
          ok: false,
          error: `conditions[${index}].amount must be a decimal amount in a string, e.g. "5000.00".`,
        };
      }
      try {
        prepared.amount = parseMoney(raw.amount, grounding.currencyCode);
      } catch {
        return {
          ok: false,
          error: `conditions[${index}].amount was "${raw.amount}", which is not a plain decimal amount.`,
        };
      }
    }

    if (raw.field === "group") {
      const named = typeof raw.group === "string" ? raw.group.trim() : "";
      if (!named) {
        return { ok: false, error: `conditions[${index}].group must be a group name.` };
      }
      // The name travels in the id slot and is resolved by `resolveSegment`.
      prepared.groupId = named;
    }

    const condition = readCondition(prepared);
    if (!condition) {
      return {
        ok: false,
        error: `conditions[${index}] is not a condition this app understands: ${JSON.stringify(raw)}`,
      };
    }
    conditions.push(condition);
  }

  const issues = validateSegment(name, conditions);
  if (issues.length > 0) {
    return {
      ok: false,
      error: `It failed validation — ${issues.map((issue) => issue.code).join(", ")}.`,
    };
  }

  return {
    ok: true,
    value: {
      name,
      conditions,
      notes: typeof value.notes === "string" ? value.notes.trim() || null : null,
    },
  };
}

export interface SegmentClarification {
  index: number;
  term: string;
  options: { id: string; label: string }[];
}

export interface ResolvedSegment {
  name: string;
  conditions: SegmentCondition[];
  clarifications: SegmentClarification[];
  notes: string | null;
}

const normalise = (value: string) => value.trim().toLowerCase();

/**
 * Group names → group ids, and a question for anything that does not resolve.
 *
 * A guess here builds a segment for the wrong tier, which then prices the wrong
 * buyers. The condition is dropped and the chip asks instead.
 */
export function resolveSegment(
  draft: NamedSegment,
  grounding: SegmentGrounding,
  choices: Readonly<Record<string, string>> = {},
): ResolvedSegment {
  const clarifications: SegmentClarification[] = [];
  const conditions: SegmentCondition[] = [];

  draft.conditions.forEach((condition, index) => {
    if (condition.field !== "group") {
      conditions.push(condition);
      return;
    }

    const term = choices[condition.groupId] ?? condition.groupId;
    // An id the merchant already picked, or one that was never a name.
    const byId = grounding.groups.find((group) => group.id === term);
    if (byId) {
      conditions.push({ ...condition, groupId: byId.id });
      return;
    }

    const exact = grounding.groups.filter(
      (group) => normalise(group.name) === normalise(term),
    );
    if (exact.length === 1) {
      conditions.push({ ...condition, groupId: exact[0]!.id });
      return;
    }

    const near =
      exact.length > 1
        ? exact
        : grounding.groups.filter(
            (group) =>
              normalise(group.name).includes(normalise(term)) ||
              normalise(term).includes(normalise(group.name)),
          );

    clarifications.push({
      index,
      term,
      options: near.slice(0, 3).map((group) => ({ id: group.id, label: group.name })),
    });
  });

  return { name: draft.name, conditions, clarifications, notes: draft.notes };
}

export interface SegmentDraftOptions {
  sentence: string;
  grounding: SegmentGrounding;
  actorId?: string | null;
}

/** Ask Claude for a segment. Never throws; never writes. */
export function draftSegment(
  options: SegmentDraftOptions,
  deps: AiDeps = {},
): Promise<AiResult<NamedSegment>> {
  return askForJson<NamedSegment>(
    {
      feature: "segment_builder",
      system: SEGMENT_SYSTEM,
      user: segmentUser(options.sentence, options.grounding),
      actorId: options.actorId,
      temperature: 0,
      validate: (value) => readNamedSegment(value, options.grounding),
    },
    deps,
  );
}
