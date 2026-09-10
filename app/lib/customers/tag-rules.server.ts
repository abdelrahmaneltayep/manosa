import { money } from "@mannon/pricing-engine";
import type { Customer, CustomerTagRule, Prisma } from "@prisma/client";

import { db } from "~/db.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import { assertFeature } from "~/lib/billing/gate.server";
import { applyTagChange } from "~/lib/customers/admin-graphql.server";
import {
  deserializeConditions,
  evaluateTagRules,
  normalizeTags,
  validateTagRule,
  type BuyerFacts,
  type TagCondition,
  type TagDecision,
  type TagRule,
  type TagRuleIssue,
} from "~/lib/customers/tagging";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { publishBuyerTerms } from "~/lib/terms/ledger.server";
import { tenant } from "~/lib/tenant/shop-context.server";

/**
 * Storage and execution for the auto-tagging engine.
 *
 * The deciding is done by the pure module; everything here is about getting
 * rules in and out of the database and turning a decision into writes that are
 * audited. Keeping the two apart is what lets the preview a merchant sees and
 * the sweep that runs at 3am be the same answer.
 */

/** How many buyers one sweep touches before it hands back. */
export const SWEEP_BATCH = 200;

export class TagRuleValidationError extends Error {
  constructor(readonly issues: TagRuleIssue[]) {
    super(`Tag rule is not valid: ${issues.map((issue) => issue.code).join(", ")}`);
    this.name = "TagRuleValidationError";
  }
}

export interface StoredTagRule extends CustomerTagRule {
  parsed: TagCondition[];
  /** Conditions that could not be read. The rule still runs without them —
   *  minus a condition it can only match *less*, never more. */
  unreadable: string[];
}

function toStored(row: CustomerTagRule): StoredTagRule {
  const { conditions, errors } = deserializeConditions(row.conditions);
  return { ...row, parsed: conditions, unreadable: errors };
}

export function toEngineRule(row: StoredTagRule): TagRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled && row.unreadable.length === 0,
    priority: row.priority,
    matchMode: row.matchMode === "any" ? "any" : "all",
    conditions: row.parsed,
    addTags: row.addTags,
    removeTags: row.removeTags,
  };
}

export async function listTagRules(): Promise<StoredTagRule[]> {
  const rows = await db.customerTagRule.findMany({
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toStored);
}

export async function getTagRule(id: string): Promise<StoredTagRule | null> {
  const row = await db.customerTagRule.findUnique({ where: { id } });
  return row ? toStored(row) : null;
}

export interface TagRuleInput {
  name: string;
  enabled?: boolean;
  priority?: number;
  matchMode?: "all" | "any";
  conditions: TagCondition[];
  addTags: string[];
  removeTags: string[];
}

function ruleData(input: TagRuleInput) {
  return {
    name: input.name.trim(),
    enabled: input.enabled ?? true,
    priority: input.priority ?? 100,
    matchMode: input.matchMode === "any" ? "any" : "all",
    conditions: input.conditions as unknown as Prisma.InputJsonValue,
    addTags: normalizeTags(input.addTags),
    removeTags: normalizeTags(input.removeTags),
  };
}

export async function createTagRule(input: TagRuleInput, actor: AuditActor) {
  // Auto-tagging is a paid capability. Gated here rather than only in the UI:
  // the teaser is courtesy, this is the enforcement.
  await assertFeature("auto_tagging");

  const issues = validateTagRule(input);
  if (issues.length > 0) throw new TagRuleValidationError(issues);

  const created = await db.customerTagRule.create({
    data: { ...tenant(), ...ruleData(input), createdBy: actor.id ?? null },
  });

  await recordAudit({
    actor,
    action: "customer_tag_rule.created",
    summary: `Created the auto-tagging rule “${created.name}”.`,
    subject: { type: "CustomerTagRule", id: created.id },
    metadata: { addTags: created.addTags, removeTags: created.removeTags },
  });

  return created;
}

export async function updateTagRule(id: string, input: TagRuleInput, actor: AuditActor) {
  await assertFeature("auto_tagging");

  const current = await db.customerTagRule.findUnique({ where: { id } });
  if (!current) throw new Response("Tag rule not found", { status: 404 });

  const issues = validateTagRule(input);
  if (issues.length > 0) throw new TagRuleValidationError(issues);

  const updated = await db.customerTagRule.update({
    where: { id },
    data: ruleData(input),
  });

  await recordAudit({
    actor,
    action: "customer_tag_rule.updated",
    summary: `Updated the auto-tagging rule “${updated.name}”.`,
    subject: { type: "CustomerTagRule", id },
  });

  return updated;
}

export async function deleteTagRule(id: string, actor: AuditActor) {
  const current = await db.customerTagRule.findUnique({ where: { id } });
  if (!current) throw new Response("Tag rule not found", { status: 404 });

  await db.customerTagRule.delete({ where: { id } });

  await recordAudit({
    actor,
    action: "customer_tag_rule.deleted",
    // Deleting a rule does not untag anyone: the tags it already applied are
    // now the merchant's to keep or remove, and silently stripping them could
    // change prices for hundreds of buyers at once.
    summary: `Deleted the auto-tagging rule “${current.name}”. Tags it already applied were left in place.`,
    subject: { type: "CustomerTagRule", id },
  });
}

/* -------------------------------------------------------------------------- */
/* Running them                                                                */
/* -------------------------------------------------------------------------- */

export function factsFor(customer: Customer): BuyerFacts {
  return {
    lifetimeSpend: money(customer.lifetimeSpend, customer.currencyCode),
    orderCount: customer.orderCount,
    countryCode: customer.countryCode,
    lastOrderAt: customer.lastOrderAt,
    tags: customer.tags,
    // Form answers arrive with the registration forms in phase 2.2. Until
    // then a rule that reads an answer matches nobody, which is the honest
    // behaviour — the alternative is matching everybody.
    answers: {},
  };
}

export interface SweepResult {
  /** Buyers looked at. */
  examined: number;
  /** Buyers whose tags actually changed. */
  changed: number;
  /** Matches per rule id, for the rule list's "N customers match". */
  matchesByRule: Record<string, number>;
  /** Buyers whose Shopify write failed. The sweep continues past them. */
  failed: number;
}

/**
 * Work out what would change, without writing anything.
 *
 * The same function backs the preview and the dry half of the sweep, so a
 * merchant shown "12 customers match" and then seeing 9 tagged would be a bug
 * in one place rather than a disagreement between two implementations.
 */
export async function previewTagRules(
  now: Date = new Date(),
  limit = 1000,
): Promise<{
  decisions: { customer: Customer; decision: TagDecision }[];
  result: SweepResult;
}> {
  const stored = await listTagRules();
  const rules = stored.map(toEngineRule);
  const customers = await db.customer.findMany({
    where: { deletedInShopifyAt: null },
    take: limit,
    orderBy: { createdAt: "asc" },
  });

  const matchesByRule: Record<string, number> = {};
  const decisions: { customer: Customer; decision: TagDecision }[] = [];

  for (const customer of customers) {
    const decision = evaluateTagRules(rules, factsFor(customer), now);
    for (const ruleId of decision.matched) {
      matchesByRule[ruleId] = (matchesByRule[ruleId] ?? 0) + 1;
    }
    if (!decision.unchanged) decisions.push({ customer, decision });
  }

  return {
    decisions,
    result: {
      examined: customers.length,
      changed: decisions.length,
      matchesByRule,
      failed: 0,
    },
  };
}

/**
 * Apply the rules for real.
 *
 * A buyer whose Shopify write fails is skipped, not retried in a loop and not
 * allowed to stop the sweep: one customer Shopify refuses must not leave the
 * other four hundred untagged.
 */
export async function runTagSweep(
  admin: AdminGraphql,
  actor: AuditActor,
  now: Date = new Date(),
  limit = SWEEP_BATCH,
): Promise<SweepResult> {
  await assertFeature("auto_tagging");

  const stored = await listTagRules();
  const rules = stored.map(toEngineRule);
  const customers = await db.customer.findMany({
    where: { deletedInShopifyAt: null },
    take: limit,
    orderBy: { createdAt: "asc" },
  });

  const matchesByRule: Record<string, number> = {};
  let changed = 0;
  let failed = 0;

  for (const customer of customers) {
    const decision = evaluateTagRules(rules, factsFor(customer), now);
    for (const ruleId of decision.matched) {
      matchesByRule[ruleId] = (matchesByRule[ruleId] ?? 0) + 1;
    }
    if (decision.unchanged) continue;

    try {
      await applyTagChange(admin, customer.customerId, {
        add: decision.add,
        remove: decision.remove,
      });
      const updated = await db.customer.update({
        where: { id: customer.id },
        data: { tags: decision.tags },
      });
      await publishBuyerTerms(admin, {
        ...updated,
        group: updated.groupId
          ? await db.customerGroup.findUnique({ where: { id: updated.groupId } })
          : null,
      });
      changed += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `[mannon] auto-tagging could not update ${customer.customerId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const ran = new Date(now);
  for (const rule of stored) {
    await db.customerTagRule.update({
      where: { id: rule.id },
      data: { lastRunAt: ran, lastMatchCount: matchesByRule[rule.id] ?? 0 },
    });
  }

  if (changed > 0 || failed > 0) {
    await recordAudit({
      actor,
      action: "customer_tag_rule.applied",
      summary:
        failed === 0
          ? `Auto-tagging updated ${changed} customers.`
          : `Auto-tagging updated ${changed} customers; ${failed} could not be updated in Shopify.`,
      metadata: { examined: customers.length, changed, failed, matchesByRule },
    });
  }

  return { examined: customers.length, changed, matchesByRule, failed };
}
