import type { PricingRule as PricingRuleRow, Prisma } from "@prisma/client";
import { validateRule, type PricingRule, type RuleIssue } from "@mannon/pricing-engine";

import { db } from "~/db.server";
import {
  recordAudit,
  type AiProvenance,
  type AuditActor,
} from "~/lib/audit/record.server";
import { assertWithinLimit } from "~/lib/billing/gate.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { toEngineRule, toEngineRules, toRowData } from "~/lib/pricing/rule-mapper.server";
import { publishRuleset } from "~/lib/pricing/ruleset.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";

/** Archived rules stay restorable for this long before they can be removed. */
export const ARCHIVE_RETENTION_DAYS = 30;

/** Rows per page in the rule list. */
export const RULES_PAGE_SIZE = 50;

export class RuleValidationError extends Error {
  constructor(readonly issues: RuleIssue[]) {
    super(`Rule is not valid: ${issues.map((issue) => issue.code).join(", ")}`);
    this.name = "RuleValidationError";
  }
}

/**
 * Raised when someone else changed the rule since this editor loaded it.
 *
 * Carries their version so the UI can show what changed and let the merchant
 * choose — overwriting a colleague's pricing change silently is not something
 * to discover from a customer.
 */
export class RuleConflictError extends Error {
  constructor(
    readonly ruleId: string,
    readonly expectedVersion: number,
    readonly current: PricingRuleRow,
  ) {
    super(
      `Rule ${ruleId} was changed by someone else: expected version ` +
        `${expectedVersion}, found ${current.version}.`,
    );
    this.name = "RuleConflictError";
  }
}

export interface ListRulesOptions {
  /** Archived rules live on their own tab. */
  archived?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: "priority" | "name" | "updatedAt" | "usage";
  direction?: "asc" | "desc";
}

export interface RuleListPage {
  rows: PricingRuleRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Total rules in this shop, ignoring search — drives the empty state. */
  totalUnfiltered: number;
}

function orderBy(
  options: ListRulesOptions,
): Prisma.PricingRuleOrderByWithRelationInput[] {
  const direction = options.direction ?? "asc";

  switch (options.sort) {
    case "name":
      return [{ name: direction }];
    case "updatedAt":
      return [{ updatedAt: direction }];
    case "usage":
      // Rules never measured sort last rather than being treated as zero.
      return [{ usageCount30d: { sort: direction, nulls: "last" } }, { priority: "asc" }];
    case "priority":
    default:
      // Priority then age, matching the order the engine resolves them in.
      return [{ priority: direction }, { createdAt: "asc" }];
  }
}

export async function listRules(options: ListRulesOptions = {}): Promise<RuleListPage> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = options.pageSize ?? RULES_PAGE_SIZE;
  const archived = options.archived ?? false;

  const where: Prisma.PricingRuleWhereInput = {
    archivedAt: archived ? { not: null } : null,
    ...(options.search
      ? { name: { contains: options.search, mode: "insensitive" as const } }
      : {}),
  };

  const [rows, total, totalUnfiltered] = await Promise.all([
    db.pricingRule.findMany({
      where,
      orderBy: orderBy(options),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.pricingRule.count({ where }),
    db.pricingRule.count({ where: { archivedAt: archived ? { not: null } : null } }),
  ]);

  return { rows, total, page, pageSize, totalUnfiltered };
}

export async function getRule(id: string): Promise<PricingRuleRow | null> {
  return db.pricingRule.findUnique({ where: { id } });
}

/**
 * Every rule that can price something right now — what checkout gets.
 *
 * **A paused shop has none.** This is the single place every pricing surface
 * reads from — the ruleset publish, quotes, PO-to-order, quick order and the
 * Buyer Agent — so pausing here is the only way "pause the app" can mean what
 * the Danger zone says it means. Nothing is deleted: the rules are still in
 * the table and resuming is one write.
 *
 * Shopify's Function is the exception, because it reads a metafield rather
 * than calling us. Pausing republishes an empty ruleset for it; see
 * `app/lib/settings/pause.server.ts`.
 */
export async function activeEngineRules() {
  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("activeEngineRules") },
    select: { pausedAt: true },
  });
  if (shop?.pausedAt) return toEngineRules([]);

  const rows = await db.pricingRule.findMany({
    where: { status: "ACTIVE", archivedAt: null },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  return toEngineRules(rows);
}

/**
 * Rules whose names are already taken.
 *
 * Duplicates are allowed — a merchant may genuinely want two "Summer tiers" —
 * but the builder warns, because two identically named rules in a support
 * conversation is its own kind of pain.
 */
export async function findDuplicateName(name: string, exceptId?: string) {
  return db.pricingRule.findFirst({
    where: {
      name: { equals: name.trim(), mode: "insensitive" },
      archivedAt: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true, name: true },
  });
}

/**
 * Where a saved rule came from, when Claude drafted it.
 *
 * `approvedById` is not optional: an AI-assisted entry with no approver is
 * exactly what `recordAudit` refuses, and requiring it here means a future
 * caller that forgets does not compile rather than throwing in production.
 */
export interface SaveProvenance {
  ai: AiProvenance;
  /** The merchant who pressed the button. */
  approvedById: string;
  /** Merged into the audit entry — the sentence, and what the guard found. */
  metadata?: Prisma.InputJsonObject;
}

export interface SaveContext {
  admin: AdminGraphql;
  actor: AuditActor;
  /** Absent for a rule the merchant built by hand, which is most of them. */
  provenance?: SaveProvenance;
}

/**
 * Push the current active ruleset to Shopify.
 *
 * Called after every change. Nothing else keeps checkout in step with the
 * admin: a rule that is not published simply does not exist at checkout, so
 * this is not an optimisation to defer.
 */
export async function republish(admin: AdminGraphql) {
  const { rules, unreadable } = await activeEngineRules();
  for (const row of unreadable) {
    console.error(`[mannon] rule ${row.id} could not be published: ${row.message}`);
  }
  return publishRuleset(admin, rules);
}

export async function createRule(
  rule: PricingRule,
  { admin, actor, provenance }: SaveContext,
): Promise<PricingRuleRow> {
  const issues = validateRule(rule);
  if (issues.length > 0) throw new RuleValidationError(issues);

  // Free allows one rule. Counted here rather than by the caller so the check
  // and the insert cannot drift apart.
  const activeCount = await db.pricingRule.count({ where: { archivedAt: null } });
  await assertWithinLimit("pricingRules", activeCount);

  // The rule and the entry that says who made it commit together. Without the
  // transaction an audit failure — an AI-assisted entry with no approver, most
  // of all — leaves a live pricing rule nobody is recorded as having approved.
  const created = await db.$transaction(async (tx) => {
    const row = await tx.pricingRule.create({
      data: {
        ...tenant(),
        ...toRowData(rule),
        createdBy: actor.id ?? null,
        updatedBy: actor.id ?? null,
      },
    });

    await recordAudit(
      {
        actor,
        action: "pricing_rule.created",
        summary: provenance
          ? `Approved Claude's draft and created the pricing rule “${row.name}”.`
          : `Created the pricing rule “${row.name}”.`,
        subject: { type: "PricingRule", id: row.id },
        metadata: { kind: row.kind, status: row.status, ...provenance?.metadata },
        ai: provenance?.ai ?? null,
        // Live pricing, changed on Claude's suggestion. The approval is the point.
        aiAssisted: Boolean(provenance),
        approval: provenance ? { byId: provenance.approvedById } : null,
      },
      tx,
    );

    return row;
  });

  if (created.status === "ACTIVE") await republish(admin);

  return created;
}

export async function updateRule(
  id: string,
  rule: PricingRule,
  expectedVersion: number,
  { admin, actor }: SaveContext,
): Promise<PricingRuleRow> {
  const issues = validateRule(rule);
  if (issues.length > 0) throw new RuleValidationError(issues);

  const current = await db.pricingRule.findUnique({ where: { id } });
  if (!current) throw new Response("Rule not found", { status: 404 });
  if (current.version !== expectedVersion) {
    throw new RuleConflictError(id, expectedVersion, current);
  }

  // The version check and the write are one statement: two staff saving at the
  // same instant must not both believe they won.
  const { count } = await db.pricingRule.updateMany({
    where: { id, version: expectedVersion },
    data: {
      ...toRowData(rule),
      version: { increment: 1 },
      updatedBy: actor.id ?? null,
    },
  });

  if (count !== 1) {
    const latest = await db.pricingRule.findUniqueOrThrow({ where: { id } });
    throw new RuleConflictError(id, expectedVersion, latest);
  }

  const updated = await db.pricingRule.findUniqueOrThrow({ where: { id } });

  await recordAudit({
    actor,
    action: "pricing_rule.updated",
    summary: `Updated the pricing rule “${updated.name}”.`,
    subject: { type: "PricingRule", id },
    metadata: { kind: updated.kind, status: updated.status, version: updated.version },
  });

  // Republish whenever the rule is or was live at checkout.
  if (updated.status === "ACTIVE" || current.status === "ACTIVE") await republish(admin);

  return updated;
}

/** Soft delete. Restorable for 30 days. */
export async function archiveRule(id: string, { admin, actor }: SaveContext) {
  const current = await db.pricingRule.findUnique({ where: { id } });
  if (!current) throw new Response("Rule not found", { status: 404 });

  const archived = await db.pricingRule.update({
    where: { id },
    data: { archivedAt: new Date(), status: "ARCHIVED", version: { increment: 1 } },
  });

  await recordAudit({
    actor,
    action: "pricing_rule.archived",
    summary: `Archived “${current.name}”. It stops applying now and can be restored for ${ARCHIVE_RETENTION_DAYS} days.`,
    subject: { type: "PricingRule", id },
  });

  if (current.status === "ACTIVE") await republish(admin);

  return archived;
}

// `admin` is unused on purpose: a rule comes back as a draft, so it is not in
// the published ruleset and checkout needs no update.
export async function restoreRule(id: string, { actor }: SaveContext) {
  const current = await db.pricingRule.findUnique({ where: { id } });
  if (!current) throw new Response("Rule not found", { status: 404 });

  const restored = await db.pricingRule.update({
    where: { id },
    // Restored as a draft, never straight back to live: a rule that stopped
    // applying weeks ago should not start charging again on one click.
    data: { archivedAt: null, status: "DRAFT", version: { increment: 1 } },
  });

  await recordAudit({
    actor,
    action: "pricing_rule.restored",
    summary: `Restored “${current.name}” as a draft.`,
    subject: { type: "PricingRule", id },
  });

  return restored;
}

/**
 * Permanent delete. The UI asks for the rule's name first.
 *
 * Only archived rules can be destroyed, so there is always a deliberate step
 * between "live" and "gone".
 */
// `admin` is unused on purpose: only an already-archived rule can be deleted,
// and archiving is what removed it from the published ruleset.
export async function deleteRule(id: string, { actor }: SaveContext) {
  const current = await db.pricingRule.findUnique({ where: { id } });
  if (!current) throw new Response("Rule not found", { status: 404 });

  if (!current.archivedAt) {
    throw new Error("Archive a rule before deleting it permanently.");
  }

  await db.pricingRule.delete({ where: { id } });

  await recordAudit({
    actor,
    action: "pricing_rule.deleted",
    summary: `Permanently deleted “${current.name}”.`,
    subject: { type: "PricingRule", id },
    metadata: { kind: current.kind },
  });

  // No republish: only an already-archived rule can be deleted, and archiving
  // is what took it out of the published ruleset.
}

/** Drag-to-reorder: rewrite priorities in the order the merchant left them. */
export async function reorderRules(orderedIds: string[], { admin, actor }: SaveContext) {
  const shop = shopScope.require("reorderRules");

  await db.$transaction(
    orderedIds.map((id, index) =>
      db.pricingRule.updateMany({
        where: { id },
        // Spaced so a rule can later be dropped between two without a rewrite.
        data: { priority: (index + 1) * 10 },
      }),
    ),
  );

  await recordAudit({
    actor,
    action: "pricing_rule.reordered",
    summary: `Changed which pricing rules win when more than one matches.`,
    subject: { type: "Shop", id: shop },
    metadata: { order: orderedIds },
  });

  await republish(admin);
}

export { toEngineRule };
