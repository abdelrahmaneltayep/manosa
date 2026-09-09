import { formatMoney, type PricingRule } from "@mannon/pricing-engine";
import type { PricingRule as PricingRuleRow } from "@prisma/client";

import { toCsv } from "~/lib/pricing/csv/parse";
import { TEMPLATES, type TemplateKey } from "~/lib/pricing/csv/templates";
import { toEngineRule } from "~/lib/pricing/rule-mapper.server";

/**
 * Export rules in the same shape the importer reads.
 *
 * Export and import are the same format on purpose: a merchant can export,
 * edit in a spreadsheet, and import the result. A format that only goes one way
 * is a dead end at exactly the moment someone needs to make fifty edits.
 */

const yesNo = (value: boolean) => (value ? "yes" : "no");
const isoDate = (value: Date | null | undefined) =>
  value ? value.toISOString().slice(0, 10) : "";

function targetsColumns(rule: PricingRule): [string, string] {
  if (rule.targets.mode === "all") return ["all", ""];
  // SKUs are not stored on the rule, so a variant-targeted rule exports its
  // ids. Round-tripping those needs the id column, which the importer accepts.
  const ids =
    rule.targets.variantIds ??
    rule.targets.productIds ??
    rule.targets.collectionIds ??
    [];
  return [rule.targets.mode, ids.join(";")];
}

function audienceColumn(rule: PricingRule): string {
  return rule.audience.mode === "tags" ? (rule.audience.tags ?? []).join(";") : "";
}

export function exportRules(rows: PricingRuleRow[]): string {
  const columns = TEMPLATES.rules.columns.map((column) => column.key);
  const out: (string | number | null)[][] = [];

  for (const row of rows) {
    const rule = toEngineRule(row);
    // Volume rules do not fit one row; they have their own sheet.
    if (rule.kind === "volume_tier" || rule.kind === "cart_value_tier") continue;

    const [appliesTo, ids] = targetsColumns(rule);
    const value =
      rule.kind === "percentage"
        ? String(rule.value.percentage)
        : formatMoney(rule.value.base);

    out.push([
      rule.name,
      rule.kind,
      value,
      appliesTo,
      ids,
      audienceColumn(rule),
      rule.status,
      rule.priority,
      yesNo(rule.combinable),
      isoDate(rule.schedule.startsAt),
      isoDate(rule.schedule.endsAt),
    ]);
  }

  return toCsv(columns, out);
}

export function exportQuantityBreaks(rows: PricingRuleRow[]): string {
  const columns = TEMPLATES.quantity_breaks.columns.map((column) => column.key);
  const out: (string | number | null)[][] = [];

  for (const row of rows) {
    const rule = toEngineRule(row);
    if (rule.kind !== "volume_tier") continue;

    const [appliesTo, ids] = targetsColumns(rule);

    for (const tier of rule.value.tiers) {
      out.push([
        rule.name,
        appliesTo,
        ids,
        audienceColumn(rule),
        tier.minQuantity,
        tier.maxQuantity ?? "",
        tier.kind,
        tier.kind === "percentage" ? String(tier.percentage) : formatMoney(tier.amount),
        rule.status,
        rule.priority,
      ]);
    }
  }

  return toCsv(columns, out);
}

export function exportFor(template: TemplateKey, rows: PricingRuleRow[]): string {
  return template === "quantity_breaks" ? exportQuantityBreaks(rows) : exportRules(rows);
}

/** A blank template with one worked example, so the shape is obvious. */
export function templateCsv(template: TemplateKey): string {
  const definition = TEMPLATES[template];
  return toCsv(
    definition.columns.map((column) => column.key),
    definition.exampleRows,
  );
}
