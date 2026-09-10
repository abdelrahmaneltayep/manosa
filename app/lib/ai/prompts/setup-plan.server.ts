import { parseMoney, type Money } from "@mannon/pricing-engine";

import { askForJson } from "~/lib/ai/json.server";
import type { AiDeps, AiResult } from "~/lib/ai/run.server";

/**
 * "We sell coffee equipment to about forty cafés. They order monthly and get
 * 25% off, and the big ones get 30%."
 *
 * Two minutes of typing, and the merchant has customer groups, a starter
 * pricing rule and a registration form to look at. What makes it safe to put
 * in front of someone's store on their first day is the same thing that makes
 * the rule drafter safe:
 *
 * 1. **Everything is a closed vocabulary.** Group names and a form's fields
 *    come back as our own field keys, not as arbitrary JSON that a form
 *    renderer would then have to trust. A key we do not know is dropped.
 * 2. **Nothing here writes.** This returns a plan. `applySetupPlan` is the
 *    merchant's click, and it records the approval `recordAudit` demands.
 * 3. **A shop that already has any of it is not offered it again** — the
 *    grounding says what exists, and the plan is filtered against it before
 *    anything is applied, so a second run cannot duplicate a merchant's work.
 */

/** Form fields the wizard may propose. Every one already exists in the builder. */
export const WIZARD_FIELD_KEYS = [
  "company",
  "email",
  "phone",
  "vat_number",
  "website",
  "business_type",
  "years_trading",
  "resale_certificate",
  "estimated_volume",
  "how_did_you_hear",
] as const;
export type WizardFieldKey = (typeof WIZARD_FIELD_KEYS)[number];

const isFieldKey = (value: string): value is WizardFieldKey =>
  (WIZARD_FIELD_KEYS as readonly string[]).includes(value);

/** The three shapes of starter rule. Anything richer belongs in the builder. */
export const WIZARD_RULE_KINDS = ["percentage", "amount_off", "volume_tier"] as const;
export type WizardRuleKind = (typeof WIZARD_RULE_KINDS)[number];

export interface SetupGrounding {
  currencyCode: string;
  /**
   * Groups that already exist, with the tag each one actually uses.
   *
   * The plan never proposes one of these again — but a rule may still be aimed
   * at one, in which case the tag comes from here rather than from the model.
   * A group the shop calls "Cafés" may be tagged `wholesale-cafe`, and a rule
   * aimed at the model's guess of `cafes` would price for nobody.
   */
  groups: { name: string; tag: string }[];
  /** True when this shop already has a live registration form. */
  hasForm: boolean;
  /** True when this shop already has any pricing rule. */
  hasRule: boolean;
}

export interface PlannedGroup {
  name: string;
  /** The customer tag that puts a buyer in it. */
  tag: string;
  /** One line the merchant reads: who belongs here. */
  description: string;
}

export interface PlannedTier {
  minQuantity: number;
  maxQuantity: number | null;
  percentage: number;
}

export interface PlannedRule {
  name: string;
  kind: WizardRuleKind;
  /** For `percentage`. 0-100, the discount off. */
  percentage: number | null;
  /** For `amount_off`. */
  amount: Money | null;
  /** For `volume_tier`. Ascending, non-overlapping. */
  tiers: PlannedTier[];
  /** The tag this rule prices for. Always one of the planned groups' tags. */
  audienceTag: string;
}

export interface PlannedForm {
  name: string;
  fields: WizardFieldKey[];
  /** The tag applied on approval, tying the form to the rule. */
  autoTag: string;
}

export interface SetupPlan {
  /** What the wizard understood, in its own words. Shown above the preview. */
  summary: string;
  groups: PlannedGroup[];
  rule: PlannedRule | null;
  form: PlannedForm | null;
  /** Anything it assumed or could not tell. Shown, never hidden. */
  notes: string | null;
}

/* -------------------------------------------------------------------------- */
/* The prompt                                                                  */
/* -------------------------------------------------------------------------- */

export const SETUP_PLAN_SYSTEM = `You set up the Mannon wholesale app for a Shopify merchant, from a few sentences about their business.

Answer with a single JSON object and nothing else. No prose, no code fence.

{
  "summary": string,                   // one or two sentences: what you understood
  "groups": [                          // 1-3 customer groups
    {
      "name": string,                  // the merchant's words, e.g. "Cafés"
      "tag": string,                   // lowercase, hyphenated, e.g. "cafes"
      "description": string            // one line: who belongs in this group
    }
  ],
  "rule": {                            // one starter pricing rule, or null
    "name": string,
    "kind": "percentage" | "amount_off" | "volume_tier",
    "percentage": number | null,       // 0-100, the discount OFF, for "percentage"
    "amount": string | null,           // decimal, no symbol, for "amount_off"
    "tiers": [                         // for "volume_tier", else []
      { "minQuantity": integer, "maxQuantity": integer | null, "percentage": number }
    ],
    "audienceTag": string              // must be one of the tags in "groups"
  },
  "form": {                            // one registration form, or null
    "name": string,
    "fields": [string],                // field keys, from the list below
    "autoTag": string                  // must be one of the tags in "groups"
  },
  "notes": string | null               // anything you assumed or could not tell
}

Field keys you may use, and nothing else:
company, email, phone, vat_number, website, business_type, years_trading, resale_certificate, estimated_volume, how_did_you_hear.

Rules you must follow:
- Never invent a field key. Use only the ten above. "email" and "company" belong on every form.
- Ask for the fewest fields that let the merchant decide: a form nobody finishes approves nobody.
- A percentage is the discount off, not the price paid: "25% off" is 25.
- Quantity breaks must ascend and must not overlap: 1-49, then 50 and up.
- Amounts are plain decimals in the shop's currency, with no symbol and no thousands separator.
- "audienceTag" and "autoTag" must each be a tag from "groups", or the tag of a group the shop already has — you are told those tags, and you must use them exactly rather than guessing.
- Do not propose a group the merchant already has — you are told which exist.
- If they already have pricing rules, set "rule" to null. If they already have a registration form, set "form" to null.
- If the description does not say enough to choose a discount, propose the simplest thing that is clearly implied and say what you assumed in "notes". Never invent a number they did not suggest without saying so.
- Never leave a field out. Use null and [] rather than omitting.`;

export function setupPlanUser(description: string, grounding: SetupGrounding): string {
  const list = (items: string[]) =>
    items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none)";

  return [
    `Shop currency: ${grounding.currencyCode}`,
    "",
    "Customer groups this shop already has:",
    list(grounding.groups.map((group) => `${group.name} (tag: ${group.tag})`)),
    "",
    `Pricing rules already set up: ${grounding.hasRule ? "yes" : "no"}`,
    `Registration form already published: ${grounding.hasForm ? "yes" : "no"}`,
    "",
    "What the merchant said about their wholesale business:",
    description,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Reading the answer                                                          */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class PlanError extends Error {}

/** Tags are ours to shape: a model-supplied tag becomes a tag we would write. */
export function normalizeTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function requireText(value: unknown, what: string, max = 120): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlanError(`"${what}" must be a non-empty string.`);
  }
  return value.trim().slice(0, max);
}

/**
 * The groups to create, and every tag a rule or form may be aimed at.
 *
 * Those are two different lists. A group the shop already has is not proposed
 * again — but its tag is still a tag this shop uses, so a rule may price for
 * it. The tag in that case is the shop's, not the model's guess at it.
 */
function readGroups(
  value: unknown,
  grounding: SetupGrounding,
): { groups: PlannedGroup[]; tags: Set<string> } {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PlanError('"groups" must hold at least one group.');
  }

  const existing = new Map(
    grounding.groups.map((group) => [group.name.toLowerCase(), group.tag]),
  );
  const tags = new Set<string>();
  const groups: PlannedGroup[] = [];

  for (const entry of value.slice(0, 3)) {
    if (!isRecord(entry))
      throw new PlanError('Each entry in "groups" must be an object.');
    const name = requireText(entry.name, "groups[].name", 60);
    const tag = normalizeTag(requireText(entry.tag, "groups[].tag", 40));
    if (tag === "") throw new PlanError('"groups[].tag" must contain a letter or digit.');

    // Filtered here rather than trusted to the prompt: a second run of the
    // wizard must not offer to create what the first one created.
    const already = existing.get(name.toLowerCase());
    if (already !== undefined) {
      tags.add(already);
      continue;
    }
    if (tags.has(tag)) continue;

    tags.add(tag);
    groups.push({
      name,
      tag,
      description: requireText(entry.description, "groups[].description", 200),
    });
  }

  return { groups, tags };
}

function readTiers(value: unknown): PlannedTier[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PlanError('"rule.tiers" must hold at least one break for a volume rule.');
  }

  const tiers: PlannedTier[] = [];
  let floor = 0;

  for (const entry of value.slice(0, 10)) {
    if (!isRecord(entry)) throw new PlanError('Each entry in "tiers" must be an object.');

    const minQuantity = Number(entry.minQuantity);
    if (!Number.isSafeInteger(minQuantity) || minQuantity < 1) {
      throw new PlanError('"tiers[].minQuantity" must be a whole number of 1 or more.');
    }
    if (minQuantity <= floor) {
      throw new PlanError(
        `"tiers" must ascend and must not overlap: ${minQuantity} comes after ${floor}.`,
      );
    }

    const rawMax = entry.maxQuantity;
    const maxQuantity = rawMax === null || rawMax === undefined ? null : Number(rawMax);
    if (maxQuantity !== null) {
      if (!Number.isSafeInteger(maxQuantity) || maxQuantity < minQuantity) {
        throw new PlanError(
          '"tiers[].maxQuantity" must be null or at least minQuantity.',
        );
      }
    }

    tiers.push({
      minQuantity,
      maxQuantity,
      percentage: readPercentage(entry.percentage),
    });
    floor = maxQuantity ?? Number.MAX_SAFE_INTEGER;
  }

  return tiers;
}

function readPercentage(value: unknown): number {
  const percentage = Number(value);
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage >= 100) {
    throw new PlanError(
      `"percentage" was ${JSON.stringify(value)}; it must be the discount off, between 0 and 100.`,
    );
  }
  return Math.round(percentage * 100) / 100;
}

function readRule(
  value: unknown,
  tags: Set<string>,
  grounding: SetupGrounding,
): PlannedRule | null {
  if (value === null || value === undefined) return null;
  // A shop with rules already gets none proposed, whatever the model said.
  if (grounding.hasRule) return null;
  if (!isRecord(value)) throw new PlanError('"rule" must be an object or null.');

  const kind = String(value.kind);
  if (!(WIZARD_RULE_KINDS as readonly string[]).includes(kind)) {
    throw new PlanError(
      `"rule.kind" was ${JSON.stringify(value.kind)}; it must be one of ${WIZARD_RULE_KINDS.join(", ")}.`,
    );
  }

  const audienceTag = normalizeTag(
    requireText(value.audienceTag, "rule.audienceTag", 40),
  );
  if (!tags.has(audienceTag)) {
    // Named, so the repair round can fix it: the shop's own tag for a group
    // that already exists is not one the model can guess at.
    throw new PlanError(
      `"rule.audienceTag" was "${audienceTag}". Use one of: ${[...tags].join(", ")}.`,
    );
  }

  return {
    name: requireText(value.name, "rule.name", 80),
    kind: kind as WizardRuleKind,
    percentage: kind === "percentage" ? readPercentage(value.percentage) : null,
    amount:
      kind === "amount_off" ? readAmount(value.amount, grounding.currencyCode) : null,
    tiers: kind === "volume_tier" ? readTiers(value.tiers) : [],
    audienceTag,
  };
}

function readAmount(value: unknown, currencyCode: string): Money {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlanError(
      '"rule.amount" must be a decimal amount in a string, e.g. "5.00".',
    );
  }
  try {
    return parseMoney(value, currencyCode);
  } catch {
    throw new PlanError(
      `"rule.amount" was "${value}", which is not a plain decimal amount. No currency symbol, no thousands separator.`,
    );
  }
}

function readForm(
  value: unknown,
  tags: Set<string>,
  grounding: SetupGrounding,
): PlannedForm | null {
  if (value === null || value === undefined) return null;
  if (grounding.hasForm) return null;
  if (!isRecord(value)) throw new PlanError('"form" must be an object or null.');

  const keys = Array.isArray(value.fields) ? value.fields : [];
  const fields: WizardFieldKey[] = [];
  for (const key of keys) {
    // A key we do not know is dropped rather than rejected: one hallucinated
    // field should not cost the merchant the whole plan.
    if (typeof key === "string" && isFieldKey(key) && !fields.includes(key)) {
      fields.push(key);
    }
  }
  for (const required of ["company", "email"] as const) {
    if (!fields.includes(required)) fields.unshift(required);
  }

  const autoTag = normalizeTag(requireText(value.autoTag, "form.autoTag", 40));
  if (!tags.has(autoTag)) {
    throw new PlanError(
      `"form.autoTag" was "${autoTag}". Use one of: ${[...tags].join(", ")}.`,
    );
  }

  return { name: requireText(value.name, "form.name", 80), fields, autoTag };
}

export function readSetupPlan(
  value: unknown,
  grounding: SetupGrounding,
): { ok: true; value: SetupPlan } | { ok: false; error: string } {
  try {
    if (!isRecord(value)) throw new PlanError("The answer must be a JSON object.");

    const { groups, tags } = readGroups(value.groups, grounding);

    return {
      ok: true,
      value: {
        summary: requireText(value.summary, "summary", 400),
        groups,
        rule: readRule(value.rule, tags, grounding),
        form: readForm(value.form, tags, grounding),
        notes:
          typeof value.notes === "string" && value.notes.trim() !== ""
            ? value.notes.trim().slice(0, 400)
            : null,
      },
    };
  } catch (error) {
    if (error instanceof PlanError) return { ok: false, error: error.message };
    throw error;
  }
}

/** How much of a description is worth reading. Beyond this it is an essay. */
export const MAX_DESCRIPTION_CHARS = 2_000;

export function draftSetupPlan(
  options: { description: string; grounding: SetupGrounding; actorId?: string | null },
  deps: AiDeps = {},
): Promise<AiResult<SetupPlan>> {
  return askForJson<SetupPlan>(
    {
      feature: "setup_wizard",
      system: SETUP_PLAN_SYSTEM,
      user: setupPlanUser(
        options.description.slice(0, MAX_DESCRIPTION_CHARS),
        options.grounding,
      ),
      actorId: options.actorId,
      // The same description should plan the same shop.
      temperature: 0,
      validate: (value) => readSetupPlan(value, options.grounding),
    },
    deps,
  );
}
