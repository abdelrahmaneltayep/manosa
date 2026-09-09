import { rulesetPayload, RULESET_BYTE_LIMIT } from "~/lib/pricing/ruleset.server";
import { serializeRuleset, type PricingRule } from "@mannon/pricing-engine";

import { db } from "~/db.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import { assertWithinLimit } from "~/lib/billing/gate.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { toCsv } from "~/lib/pricing/csv/parse";
import type { ImportPlan } from "~/lib/pricing/csv/plan";
import { republish } from "~/lib/pricing/rules.server";
import { toRowData } from "~/lib/pricing/rule-mapper.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";

/** How long an import can be undone in one click. */
export const UNDO_WINDOW_MS = 60 * 60_000;

/** Guard rails on the file itself, before anything is parsed. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 50_000;

export class FileTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`The file is ${Math.round(bytes / 1024 / 1024)} MB; the limit is 10 MB.`);
    this.name = "FileTooLargeError";
  }
}

export class TooManyRowsError extends Error {
  constructor(readonly rows: number) {
    super(`The file has ${rows} rows; the limit is ${MAX_ROWS}.`);
    this.name = "TooManyRowsError";
  }
}

/**
 * Would this import produce a ruleset too big to publish?
 *
 * Worth knowing *before* importing rather than after: publishing fails on the
 * whole set, so a merchant would otherwise import two hundred rules and then
 * find checkout still on the old prices.
 */
export function estimatePublishedSize(existing: PricingRule[], planned: PricingRule[]) {
  const active = [...existing, ...planned].filter((rule) => rule.status === "active");
  const bytes = Buffer.byteLength(JSON.stringify(serializeRuleset(active)), "utf8");
  return { bytes, limit: RULESET_BYTE_LIMIT, exceeds: bytes > RULESET_BYTE_LIMIT };
}

export interface ImportResult {
  importId: string;
  created: number;
  undoableUntil: Date;
}

/**
 * Create the planned rules.
 *
 * Rows the merchant has already seen reported as errors are simply not in the
 * plan — nothing is decided here that they have not read.
 */
export async function runImport(
  plan: ImportPlan,
  options: { fileName: string; admin: AdminGraphql; actor: AuditActor },
): Promise<ImportResult> {
  const shop = shopScope.require("runImport");

  const existingCount = await db.pricingRule.count({ where: { archivedAt: null } });
  // Checked once for the whole batch: importing 200 rules on a plan that allows
  // one should fail before the first insert, not after the hundredth.
  await assertWithinLimit("pricingRules", existingCount + plan.planned.length - 1);

  const createdIds: string[] = [];

  await db.$transaction(async (tx) => {
    for (const item of plan.planned) {
      const created = await tx.pricingRule.create({
        data: {
          ...tenant(),
          ...toRowData(item.rule),
          createdBy: options.actor.id ?? null,
          updatedBy: options.actor.id ?? null,
        },
      });
      createdIds.push(created.id);
    }
  });

  const record = await db.ruleImport.create({
    data: {
      ...tenant(),
      fileName: options.fileName,
      template: plan.template,
      rowCount: plan.totalRows,
      createdCount: createdIds.length,
      errorCount: plan.errors.length,
      warningCount: plan.warnings.length,
      createdRuleIds: createdIds,
      undoableUntil: new Date(Date.now() + UNDO_WINDOW_MS),
      createdBy: options.actor.id ?? null,
    },
  });

  await recordAudit({
    actor: options.actor,
    action: "pricing_rule.imported",
    summary: `Imported ${createdIds.length} pricing rule${createdIds.length === 1 ? "" : "s"} from ${options.fileName}.`,
    subject: { type: "RuleImport", id: record.id },
    metadata: {
      fileName: options.fileName,
      created: createdIds.length,
      errors: plan.errors.length,
      warnings: plan.warnings.length,
    },
  });

  if (plan.planned.some((item) => item.rule.status === "active")) {
    await republish(options.admin);
  }

  void shop;
  return {
    importId: record.id,
    created: createdIds.length,
    undoableUntil: record.undoableUntil,
  };
}

export class UndoExpiredError extends Error {
  constructor(readonly expiredAt: Date) {
    super("This import can no longer be undone in one click.");
    this.name = "UndoExpiredError";
  }
}

/**
 * Undo an import.
 *
 * Deletes exactly the rules it created and nothing else. An import only ever
 * creates — a name collision is reported and imported alongside rather than
 * overwriting — so undo has nothing to restore and cannot lose a rule the
 * merchant wrote by hand.
 */
export async function undoImport(
  importId: string,
  options: { admin: AdminGraphql; actor: AuditActor; now?: Date },
) {
  const now = options.now ?? new Date();
  const record = await db.ruleImport.findUnique({ where: { id: importId } });
  if (!record) throw new Response("Import not found", { status: 404 });
  if (record.undoneAt) return { deleted: 0, alreadyUndone: true as const };
  if (record.undoableUntil <= now) throw new UndoExpiredError(record.undoableUntil);

  const { count } = await db.pricingRule.deleteMany({
    where: { id: { in: record.createdRuleIds } },
  });

  await db.ruleImport.update({ where: { id: importId }, data: { undoneAt: now } });

  await recordAudit({
    actor: options.actor,
    action: "pricing_rule.import_undone",
    summary: `Undid the import of ${record.fileName}. ${count} rule${count === 1 ? "" : "s"} removed.`,
    subject: { type: "RuleImport", id: importId },
    metadata: { deleted: count, fileName: record.fileName },
  });

  await republish(options.admin);

  return { deleted: count, alreadyUndone: false as const };
}

/**
 * The error report, as a CSV the merchant can open next to their file.
 *
 * Row numbers and reasons, so a two-hundred-row file with six problems is six
 * lines to fix rather than a hunt.
 */
export function errorCsv(
  plan: ImportPlan,
  translate: (code: string, params?: Record<string, unknown>) => string,
): string {
  const rows: (string | number | null)[][] = [];

  for (const issue of plan.errors) {
    rows.push([
      issue.line,
      issue.column ?? "",
      "error",
      translate(`csv.issue.${issue.code}`, issue.params),
    ]);
  }
  for (const warning of plan.warnings) {
    rows.push([
      warning.line ?? "",
      "",
      "warning",
      translate(`csv.warning.${warning.code}`, warning.params),
    ]);
  }

  rows.sort((a, b) => Number(a[0] ?? 0) - Number(b[0] ?? 0));

  return toCsv(["line", "column", "severity", "problem"], rows);
}

export { rulesetPayload };
