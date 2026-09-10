import {
  deserializeRule,
  serializeRule,
  type PricingRule,
  type SerializedRule,
} from "@mannon/pricing-engine";

import type {
  Clarification,
  NamedRuleDraft,
  RuleGrounding,
} from "~/lib/ai/prompts/rule-from-sentence.server";
import { resolveDraft } from "~/lib/ai/prompts/rule-from-sentence.server";
import { db } from "~/db.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { fetchCollections } from "~/lib/pricing/catalog.server";
import { formViewFromRule } from "~/lib/pricing/view-model.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * The ✦ Describe a rule round trip, without a table.
 *
 * A draft lives in a hidden field on the page rather than in the database:
 * the merchant either approves it — at which point it becomes an ordinary
 * pricing rule with an audit entry — or leaves, at which point it should be
 * gone. Persisting every abandoned draft would mean a retention policy, a
 * cleanup job and a second place a half-made rule can be found, all to store
 * something nobody asked to keep.
 *
 * Everything in the envelope is re-validated on the way back in. It carries no
 * more authority than the manual builder's own form fields, which the same
 * merchant could type by hand.
 */

/** How many customer tags the model is told about. */
const TAG_LIMIT = 40;

export interface DraftProvenance {
  model: string;
  promptVersion: string;
  requestId: string | null;
}

export interface DraftEnvelope {
  sentence: string;
  /** The model's rule, with collection and group **names** in the id slots. */
  rule: SerializedRule;
  notes: string | null;
  provenance: DraftProvenance;
  /** Answers to the amber chips: the model's term → the id the merchant picked. */
  choices: Record<string, string>;
}

export function encodeDraft(envelope: DraftEnvelope): string {
  return JSON.stringify(envelope);
}

/** Read a draft back. Returns null for anything unreadable — never throws. */
export function decodeDraft(raw: string | null | undefined): DraftEnvelope | null {
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;

    const envelope = parsed as Partial<DraftEnvelope>;
    const read = deserializeRule(envelope.rule);
    if (!("rule" in read)) return null;
    if (typeof envelope.sentence !== "string") return null;

    const provenance = envelope.provenance;
    if (!provenance || typeof provenance.model !== "string") return null;

    return {
      sentence: envelope.sentence,
      rule: envelope.rule as SerializedRule,
      notes: typeof envelope.notes === "string" ? envelope.notes : null,
      provenance: {
        model: provenance.model,
        promptVersion: String(provenance.promptVersion ?? ""),
        requestId: typeof provenance.requestId === "string" ? provenance.requestId : null,
      },
      choices: readChoices(envelope.choices),
    };
  } catch {
    return null;
  }
}

function readChoices(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};

  const choices: Record<string, string> = {};
  for (const [term, id] of Object.entries(value as Record<string, unknown>)) {
    if (typeof id === "string" && id !== "") choices[term] = id;
  }
  return choices;
}

/** The envelope's rule, as the model gave it — names, not ids. */
export function namedDraftOf(
  envelope: DraftEnvelope,
  fallbackDate: Date,
): NamedRuleDraft {
  const read = deserializeRule(envelope.rule);
  if (!("rule" in read)) {
    // decodeDraft already refused anything unreadable; this is the type guard.
    throw new Error(`Draft could not be read: ${read.error.message}`);
  }
  return { rule: { ...read.rule, createdAt: fallbackDate }, notes: envelope.notes };
}

export function envelopeFor(
  sentence: string,
  draft: NamedRuleDraft,
  provenance: DraftProvenance,
  choices: Record<string, string> = {},
): DraftEnvelope {
  return {
    sentence,
    rule: serializeRule(draft.rule),
    notes: draft.notes,
    provenance,
    choices,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * What Claude is told about this shop.
 *
 * Names only, and only the merchant's own: collection titles, group names and
 * the customer tags already in use. No customer, no order, no email address
 * ever goes into a prompt from here.
 */
export async function loadGrounding(
  admin: AdminGraphql,
  currencyCode: string,
): Promise<RuleGrounding> {
  const [collections, groups, tagRows] = await Promise.all([
    fetchCollections(admin),
    db.customerGroup.findMany({
      select: { id: true, name: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    db.customer.findMany({ select: { tags: true }, take: 500 }),
  ]);

  const tags = new Set<string>();
  for (const row of tagRows) {
    for (const tag of row.tags) {
      if (tags.size < TAG_LIMIT) tags.add(tag);
    }
  }

  return {
    currencyCode,
    collections: collections.map((one) => ({ id: one.id, title: one.title })),
    groups,
    tags: [...tags].sort(),
  };
}

/** The shop's currency, which every amount in a draft is in. */
export async function shopCurrency(): Promise<string> {
  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("describe rule") },
  });
  return shop?.currencyCode ?? "USD";
}

/* -------------------------------------------------------------------------- */

export interface PreparedDraft {
  envelope: DraftEnvelope;
  /** Ids resolved, ready for the guard and for saving. */
  rule: PricingRule;
  clarifications: Clarification[];
}

/**
 * Envelope + the merchant's answers → the rule that would actually be saved.
 *
 * Runs on every round trip, including the approve, so the rule that is created
 * is derived from the same inputs the merchant was looking at rather than from
 * anything the page sent back about it.
 */
export function prepareDraft(
  envelope: DraftEnvelope,
  grounding: RuleGrounding,
  now: Date,
): PreparedDraft {
  const named = namedDraftOf(envelope, now);
  const { rule, clarifications } = resolveDraft(named, grounding, envelope.choices);
  return { envelope, rule, clarifications };
}

/**
 * The drafted rule as the manual builder's own form fields.
 *
 * "Edit" posts these to the builder, so a merchant who wants to change one tier
 * gets the full builder with everything else already filled in — rather than a
 * second, worse editor built into the draft card.
 */
export function builderFields(
  rule: PricingRule,
  currencyCode: string,
): { name: string; value: string }[] {
  const form = formViewFromRule(rule, { currencyCode });
  const fields: { name: string; value: string }[] = [
    { name: "name", value: form.name },
    { name: "kind", value: form.kind },
    { name: "status", value: form.status },
    { name: "priority", value: String(form.priority) },
    { name: "percentage", value: form.percentage },
    { name: "amount", value: form.amount },
    { name: "cartMinimum", value: form.cartMinimum },
    { name: "targetMode", value: form.targetMode },
    { name: "targetCollectionIds", value: form.targetCollectionIds },
    { name: "targetProductIds", value: form.targetProductIds },
    { name: "targetVariantIds", value: form.targetVariantIds },
    { name: "excludeCollectionIds", value: form.excludeCollectionIds },
    { name: "audienceMode", value: form.audienceMode },
    { name: "audienceTags", value: form.audienceTags },
    { name: "audienceCustomerIds", value: form.audienceCustomerIds },
    { name: "audienceCompanyIds", value: form.audienceCompanyIds },
    { name: "marketMode", value: form.marketMode },
    { name: "marketIds", value: form.marketIds },
    { name: "startsAt", value: form.startsAt },
    { name: "endsAt", value: form.endsAt },
  ];

  // A checkbox that is off is simply absent, the way a browser posts one.
  if (form.combinable) fields.push({ name: "combinable", value: "on" });

  // Parallel arrays, exactly as the builder's own tier rows post them.
  for (const tier of form.tiers) {
    fields.push(
      { name: "tierMin", value: tier.minQuantity },
      { name: "tierMax", value: tier.maxQuantity },
      { name: "tierKind", value: tier.kind },
      { name: "tierValue", value: tier.value },
    );
  }

  return fields;
}
