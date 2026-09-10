import {
  parseMoney,
  validateRule,
  type Audience,
  type CartValueTier,
  type PricingRule,
  type RuleIssue,
  type Targeting,
  type VolumeTier,
} from "@mannon/pricing-engine";

import { askForJson } from "~/lib/ai/json.server";
import type { AiDeps, AiResult } from "~/lib/ai/run.server";

/**
 * "Buy 10 get 5%, buy 50 get 12%, wholesale customers only, not sale items."
 *
 * One sentence in, a rule the merchant reviews out. Three things make this
 * safe enough to put in front of someone's live prices:
 *
 * 1. **Claude never sees an id and never returns one.** It is given the
 *    merchant's collection and group *names* and answers in names; turning a
 *    name into a `gid://` is this module's job, deterministically. A model
 *    inventing a plausible-looking id is the failure mode that would quietly
 *    target the wrong collection.
 * 2. **The answer is validated by the same `validateRule` the manual builder
 *    uses**, before anything renders. An answer that does not validate gets
 *    one repair attempt carrying the reason, then the manual path.
 * 3. **Nothing here writes.** It returns a draft. `createRule` and its audit
 *    entry are the merchant's, on their click — see `docs/adr/0019`.
 */

/** What the model is allowed to target. Products and variants need ids. */
const TARGET_MODES = ["all", "collections"] as const;
const AUDIENCE_MODES = ["all", "tags", "groups", "guests"] as const;

type DraftTargetMode = (typeof TARGET_MODES)[number];
type DraftAudienceMode = (typeof AUDIENCE_MODES)[number];

export interface RuleGrounding {
  currencyCode: string;
  collections: { id: string; title: string }[];
  groups: { id: string; name: string }[];
  /** Customer tags already in use in this shop. */
  tags: string[];
}

/**
 * A rule as the model gave it: shape-valid, but with **names** where the engine
 * expects ids. Not safe to save, and not meant to be — `resolveDraft` turns it
 * into something that is.
 */
export interface NamedRuleDraft {
  rule: PricingRule;
  notes: string | null;
}

export type ClarificationField =
  "targets.collectionIds" | "targets.excludeCollectionIds" | "audience.groupIds";

export interface Clarification {
  field: ClarificationField;
  /** What the model said. */
  term: string;
  /** Best guesses, closest first. Empty means nothing in the shop is close. */
  options: { id: string; label: string }[];
}

export interface ResolvedDraft {
  rule: PricingRule;
  clarifications: Clarification[];
}

/* -------------------------------------------------------------------------- */
/* The prompt                                                                  */
/* -------------------------------------------------------------------------- */

export const RULE_FROM_SENTENCE_SYSTEM = `You turn one sentence from a Shopify merchant into a wholesale pricing rule for the Mannon app.

Answer with a single JSON object and nothing else. No prose, no code fence.

{
  "name": string,                      // short, in the merchant's words
  "kind": "percentage" | "amount_off" | "fixed_price" | "volume_tier" | "cart_value_tier",
  "percentage": number | null,         // 0-100, for kind "percentage"
  "amount": string | null,             // decimal, e.g. "12.50", for "amount_off" and "fixed_price"
  "tiers": [                           // for kind "volume_tier", else []
    {
      "minQuantity": integer,          // 1 or more
      "maxQuantity": integer | null,   // null means "and up"
      "kind": "percentage" | "amount_off" | "fixed_price",
      "percentage": number | null,
      "amount": string | null
    }
  ],
  "cartTiers": [                       // for kind "cart_value_tier", else []
    {
      "minSubtotal": string,           // decimal
      "maxSubtotal": string | null,
      "kind": "percentage" | "fixed_price",
      "percentage": number | null,
      "amount": string | null
    }
  ],
  "targets": {
    "mode": "all" | "collections",
    "collections": [string],           // collection NAMES, from the list you are given
    "excludeCollections": [string]     // NAMES to leave out, e.g. sale items
  },
  "audience": {
    "mode": "all" | "tags" | "groups" | "guests",
    "tags": [string],                  // customer tags
    "groups": [string]                 // customer group NAMES, from the list you are given
  },
  "schedule": { "startsAt": string | null, "endsAt": string | null },  // ISO dates
  "combinable": boolean,               // may this stack with other Mannon rules
  "notes": string | null               // one sentence: anything you assumed or could not tell
}

Rules you must follow:
- Never invent an id. You are given names; answer in names.
- Only name a collection or group that appears in the lists you are given. If the merchant means something that is not there, put their words in the list anyway and say so in "notes" — the merchant will be asked which one they meant.
- Quantity breaks must not overlap and must ascend: 10-49, then 50 and up.
- A percentage is the discount *off*, not the price paid: "10% off" is 10.
- "fixed_price" is what the buyer pays. "amount_off" is what comes off.
- Amounts are plain decimals in the shop's currency, with no symbol and no thousands separator.
- Targeting everything is "all" with an empty "collections" list — do not list every collection.
- If the sentence does not say who the rule is for, use audience mode "all" and say so in "notes".
- Products and variants cannot be targeted here. If the merchant names specific products, target "all", and say in "notes" that they should narrow it in the builder.
- If the sentence asks for something this shape cannot express, get as close as you can and say what you could not do in "notes". Never leave a field out.`;

export function ruleFromSentenceUser(sentence: string, grounding: RuleGrounding): string {
  const list = (items: string[]) =>
    items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none)";

  return [
    `Shop currency: ${grounding.currencyCode}`,
    "",
    "Collections in this shop:",
    list(grounding.collections.map((collection) => collection.title)),
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
/* Reading the answer                                                          */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringsIn = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim() !== "")
        .map((item) => item.trim())
    : [];

class DraftError extends Error {}

function requireNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DraftError(`"${what}" must be a number.`);
  }
  return value;
}

function requireMoney(value: unknown, what: string, currencyCode: string) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DraftError(`"${what}" must be a decimal amount in a string, e.g. "12.50".`);
  }
  try {
    return parseMoney(value, currencyCode);
  } catch {
    throw new DraftError(
      `"${what}" was "${value}", which is not a plain decimal amount. No currency symbol, no thousands separator.`,
    );
  }
}

function readDate(value: unknown, what: string): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string")
    throw new DraftError(`"${what}" must be an ISO date or null.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new DraftError(`"${what}" was "${value}", which is not a date.`);
  }
  return date;
}

function readVolumeTiers(value: unknown, currencyCode: string): VolumeTier[] {
  if (!Array.isArray(value)) throw new DraftError(`"tiers" must be an array.`);

  return value.map((raw, index) => {
    if (!isRecord(raw)) throw new DraftError(`"tiers[${index}]" must be an object.`);
    const min = requireNumber(raw.minQuantity, `tiers[${index}].minQuantity`);
    const max =
      raw.maxQuantity === null || raw.maxQuantity === undefined
        ? null
        : requireNumber(raw.maxQuantity, `tiers[${index}].maxQuantity`);
    const kind = raw.kind;

    if (kind === "percentage") {
      return {
        minQuantity: min,
        maxQuantity: max,
        kind: "percentage" as const,
        percentage: requireNumber(raw.percentage, `tiers[${index}].percentage`),
      };
    }
    if (kind === "amount_off" || kind === "fixed_price") {
      return {
        minQuantity: min,
        maxQuantity: max,
        kind,
        amount: requireMoney(raw.amount, `tiers[${index}].amount`, currencyCode),
      };
    }
    throw new DraftError(
      `"tiers[${index}].kind" was ${JSON.stringify(kind)}; it must be "percentage", "amount_off" or "fixed_price".`,
    );
  });
}

function readCartTiers(value: unknown, currencyCode: string): CartValueTier[] {
  if (!Array.isArray(value)) throw new DraftError(`"cartTiers" must be an array.`);

  return value.map((raw, index) => {
    if (!isRecord(raw)) throw new DraftError(`"cartTiers[${index}]" must be an object.`);
    const minSubtotal = requireMoney(
      raw.minSubtotal,
      `cartTiers[${index}].minSubtotal`,
      currencyCode,
    );
    const maxSubtotal =
      raw.maxSubtotal === null || raw.maxSubtotal === undefined
        ? null
        : requireMoney(raw.maxSubtotal, `cartTiers[${index}].maxSubtotal`, currencyCode);

    if (raw.kind === "percentage") {
      return {
        minSubtotal,
        maxSubtotal,
        kind: "percentage" as const,
        percentage: requireNumber(raw.percentage, `cartTiers[${index}].percentage`),
      };
    }
    if (raw.kind === "fixed_price") {
      return {
        minSubtotal,
        maxSubtotal,
        kind: "fixed_price" as const,
        amount: requireMoney(raw.amount, `cartTiers[${index}].amount`, currencyCode),
      };
    }
    throw new DraftError(
      `"cartTiers[${index}].kind" was ${JSON.stringify(raw.kind)}; it must be "percentage" or "fixed_price".`,
    );
  });
}

function readTargets(value: unknown): Targeting {
  if (!isRecord(value)) throw new DraftError(`"targets" must be an object.`);
  const mode = value.mode;
  if (!TARGET_MODES.includes(mode as DraftTargetMode)) {
    throw new DraftError(
      `"targets.mode" was ${JSON.stringify(mode)}; it must be "all" or "collections".`,
    );
  }

  return {
    mode: mode as DraftTargetMode,
    collectionIds: stringsIn(value.collections),
    excludeCollectionIds: stringsIn(value.excludeCollections),
  };
}

function readAudience(value: unknown): Audience {
  if (!isRecord(value)) throw new DraftError(`"audience" must be an object.`);
  const mode = value.mode;
  if (!AUDIENCE_MODES.includes(mode as DraftAudienceMode)) {
    throw new DraftError(
      `"audience.mode" was ${JSON.stringify(mode)}; it must be "all", "tags", "groups" or "guests".`,
    );
  }

  return {
    mode: mode as DraftAudienceMode,
    tags: stringsIn(value.tags),
    groupIds: stringsIn(value.groups),
  };
}

function readValue(raw: Record<string, unknown>, currencyCode: string) {
  const empty = { base: parseMoney("0", currencyCode), overrides: {} };

  switch (raw.kind) {
    case "percentage":
      return {
        kind: "percentage" as const,
        value: { percentage: requireNumber(raw.percentage, "percentage") },
      };
    case "amount_off":
      return {
        kind: "amount_off" as const,
        value: { ...empty, base: requireMoney(raw.amount, "amount", currencyCode) },
      };
    case "fixed_price":
      return {
        kind: "fixed_price" as const,
        value: { ...empty, base: requireMoney(raw.amount, "amount", currencyCode) },
      };
    case "volume_tier":
      return {
        kind: "volume_tier" as const,
        value: { tiers: readVolumeTiers(raw.tiers, currencyCode) },
      };
    case "cart_value_tier":
      return {
        kind: "cart_value_tier" as const,
        value: { tiers: readCartTiers(raw.cartTiers, currencyCode) },
      };
    default:
      throw new DraftError(
        `"kind" was ${JSON.stringify(raw.kind)}; it must be one of "percentage", "amount_off", "fixed_price", "volume_tier", "cart_value_tier".`,
      );
  }
}

/** Issue codes, as a sentence the model can act on. */
function describeIssues(issues: RuleIssue[]): string {
  return issues
    .map(
      (issue) =>
        `${issue.field}: ${issue.code}${issue.params ? ` ${JSON.stringify(issue.params)}` : ""}`,
    )
    .join("; ");
}

/**
 * The model's JSON → a shape-valid rule, with names still in the id slots.
 *
 * Validated here rather than after resolution on purpose: `no_targets` because
 * the merchant has no collection by that name is not something a second model
 * call can fix, and asking it to try burns twenty seconds of the merchant's
 * time to arrive at the same place.
 */
export function readNamedDraft(
  value: unknown,
  grounding: RuleGrounding,
  now: Date,
): { ok: true; value: NamedRuleDraft } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "The answer was not a JSON object." };

  try {
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const schedule = isRecord(value.schedule) ? value.schedule : {};

    const rule: PricingRule = {
      id: "draft",
      name,
      status: "draft",
      priority: 100,
      combinable: value.combinable === true,
      targets: readTargets(value.targets),
      audience: readAudience(value.audience),
      markets: { mode: "all", marketIds: [] },
      schedule: {
        startsAt: readDate(schedule.startsAt, "schedule.startsAt"),
        endsAt: readDate(schedule.endsAt, "schedule.endsAt"),
      },
      createdAt: now,
      ...readValue(value, grounding.currencyCode),
    };

    const issues = validateRule(rule);
    if (issues.length > 0) {
      return { ok: false, error: `It failed validation — ${describeIssues(issues)}.` };
    }

    return {
      ok: true,
      value: {
        rule,
        notes: typeof value.notes === "string" ? value.notes.trim() || null : null,
      },
    };
  } catch (error) {
    if (error instanceof DraftError) return { ok: false, error: error.message };
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Names → ids                                                                 */
/* -------------------------------------------------------------------------- */

const normalise = (value: string) => value.trim().toLowerCase();

/** Up to this many guesses per chip. More is a menu, not a question. */
const MAX_OPTIONS = 3;

function resolveNames(
  terms: string[],
  known: { id: string; label: string }[],
  field: ClarificationField,
  clarifications: Clarification[],
): string[] {
  const resolved: string[] = [];

  for (const term of terms) {
    // An id the merchant already picked passes through untouched — resolution
    // runs again on every round trip, and must be idempotent.
    if (known.some((one) => one.id === term)) {
      resolved.push(term);
      continue;
    }

    const exact = known.filter((one) => normalise(one.label) === normalise(term));
    if (exact.length === 1) {
      resolved.push(exact[0]!.id);
      continue;
    }

    const near =
      exact.length > 1
        ? exact
        : known.filter(
            (one) =>
              normalise(one.label).includes(normalise(term)) ||
              normalise(term).includes(normalise(one.label)),
          );

    clarifications.push({ field, term, options: near.slice(0, MAX_OPTIONS) });
  }

  return resolved;
}

/**
 * Turn the names into ids, and ask about the ones that do not resolve.
 *
 * A term that matches nothing, or matches two collections equally, becomes a
 * question rather than a guess. Guessing here means a rule that targets the
 * wrong products at the right discount, which nobody notices until the orders
 * arrive.
 */
export function resolveDraft(
  draft: NamedRuleDraft,
  grounding: RuleGrounding,
  choices: Readonly<Record<string, string>> = {},
): ResolvedDraft {
  const collections = grounding.collections.map((one) => ({
    id: one.id,
    label: one.title,
  }));
  const groups = grounding.groups.map((one) => ({ id: one.id, label: one.name }));
  const clarifications: Clarification[] = [];

  // A merchant's answer to a chip replaces the term before resolution, so the
  // chip disappears rather than being answered and asked again.
  const answered = (terms: string[]) => terms.map((term) => choices[term] ?? term);

  const targets: Targeting = {
    ...draft.rule.targets,
    collectionIds: resolveNames(
      answered(draft.rule.targets.collectionIds ?? []),
      collections,
      "targets.collectionIds",
      clarifications,
    ),
    excludeCollectionIds: resolveNames(
      answered(draft.rule.targets.excludeCollectionIds ?? []),
      collections,
      "targets.excludeCollectionIds",
      clarifications,
    ),
  };

  const audience: Audience = {
    ...draft.rule.audience,
    groupIds: resolveNames(
      answered(draft.rule.audience.groupIds ?? []),
      groups,
      "audience.groupIds",
      clarifications,
    ),
  };

  return { rule: { ...draft.rule, targets, audience }, clarifications };
}

/* -------------------------------------------------------------------------- */

export interface DraftRuleOptions {
  sentence: string;
  grounding: RuleGrounding;
  actorId?: string | null;
  now: Date;
}

/** Ask Claude for a rule. Never throws; never writes. */
export function draftRuleFromSentence(
  options: DraftRuleOptions,
  deps: AiDeps = {},
): Promise<AiResult<NamedRuleDraft>> {
  return askForJson<NamedRuleDraft>(
    {
      feature: "rule_from_sentence",
      system: RULE_FROM_SENTENCE_SYSTEM,
      user: ruleFromSentenceUser(options.sentence, options.grounding),
      actorId: options.actorId,
      // brand.md, §5: a draft the merchant approves is pre-fill, not writing.
      // The same sentence should draft the same rule.
      temperature: 0,
      validate: (value) => readNamedDraft(value, options.grounding, options.now),
    },
    deps,
  );
}
