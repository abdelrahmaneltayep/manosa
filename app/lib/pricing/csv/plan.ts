import {
  parseMoney,
  validateRule,
  type PricingRule,
  type Targeting,
} from "@mannon/pricing-engine";

import type { CsvDocument, CsvRow } from "~/lib/pricing/csv/parse";
import type { TemplateKey } from "~/lib/pricing/csv/templates";

/**
 * Turn a parsed CSV into a plan: what would be created, what is wrong, and what
 * is worth a warning.
 *
 * Pure, and it never imports anything — the merchant sees this report and
 * decides. Nothing about a file is acted on before they have read what it
 * would do.
 */

export type ImportIssueCode =
  | "missing_required"
  | "unknown_type"
  | "bad_number"
  | "bad_money"
  | "bad_date"
  | "unknown_sku"
  | "invalid_rule"
  | "ragged_row"
  | "duplicate_row";

export interface ImportIssue {
  line: number;
  column: string | null;
  code: ImportIssueCode;
  /** Values the message needs — never a pre-built sentence. */
  params?: Record<string, string | number>;
}

export type ImportWarningCode =
  "zero_value" | "duplicate_name" | "existing_name" | "last_wins" | "ragged_row";

export interface ImportWarning {
  line: number | null;
  code: ImportWarningCode;
  params?: Record<string, string | number>;
}

export interface PlannedRule {
  rule: PricingRule;
  /** Lines that contributed, so the report can point back at the file. */
  lines: number[];
}

export interface ImportPlan {
  template: TemplateKey;
  totalRows: number;
  planned: PlannedRule[];
  errors: ImportIssue[];
  warnings: ImportWarning[];
}

export interface PlanContext {
  currencyCode: string;
  /** SKU → variant id, resolved against Shopify before planning. */
  skuToVariantId: Map<string, string>;
  /** Names already in use, so the report can warn about collisions. */
  existingNames: Set<string>;
  now: Date;
}

/** Only these three make sense as a one-row rule; tiers have their own sheet. */
type SingleValueKind = "percentage" | "amount_off" | "fixed_price";

const TYPE_ALIASES: Record<string, SingleValueKind> = {
  percentage: "percentage",
  percent: "percentage",
  "%": "percentage",
  amount_off: "amount_off",
  amount: "amount_off",
  fixed_price: "fixed_price",
  price: "fixed_price",
  custom_price: "fixed_price",
};

const normalize = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

const splitList = (value: string) =>
  value
    .split(/[;|]/)
    .map((item) => item.trim())
    .filter(Boolean);

function readBoolean(value: string): boolean {
  return ["yes", "y", "true", "1", "on"].includes(normalize(value));
}

function readTargets(
  row: CsvRow,
  context: PlanContext,
  errors: ImportIssue[],
): Targeting {
  const mode = normalize(row.cells.applies_to ?? "") || "all";
  const skus = splitList(row.cells.skus ?? "");

  if (mode === "all" || skus.length === 0) return { mode: "all" };

  const variantIds: string[] = [];
  for (const sku of skus) {
    const variantId = context.skuToVariantId.get(sku);
    if (!variantId) {
      // Listed, never silently skipped: a dropped SKU is a price that quietly
      // does not apply, which the merchant finds out from a buyer.
      errors.push({
        line: row.line,
        column: "skus",
        code: "unknown_sku",
        params: { sku },
      });
      continue;
    }
    variantIds.push(variantId);
  }

  return { mode: "variants", variantIds };
}

function readAudience(row: CsvRow): PricingRule["audience"] {
  const tags = splitList(row.cells.customer_tags ?? "");
  return tags.length > 0 ? { mode: "tags", tags } : { mode: "all" };
}

function readDate(
  value: string,
  row: CsvRow,
  column: string,
  errors: ImportIssue[],
): Date | null {
  if (!value.trim()) return null;
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) {
    errors.push({ line: row.line, column, code: "bad_date", params: { value } });
    return null;
  }
  return date;
}

function readNumber(
  value: string,
  row: CsvRow,
  column: string,
  errors: ImportIssue[],
  fallback: number,
): number {
  if (!value.trim()) return fallback;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    errors.push({ line: row.line, column, code: "bad_number", params: { value } });
    return fallback;
  }
  return parsed;
}

function baseFields(row: CsvRow, context: PlanContext, errors: ImportIssue[]) {
  return {
    // Replaced with the real id on create; a placeholder keeps the rule
    // shape valid so it can be validated and previewed before it exists.
    id: "import",
    name: (row.cells.rule_name ?? "").trim(),
    status: (normalize(row.cells.status ?? "") === "active" ? "active" : "draft") as
      "active" | "draft",
    priority: readNumber(row.cells.priority ?? "", row, "priority", errors, 100),
    combinable: readBoolean(row.cells.combinable ?? ""),
    targets: readTargets(row, context, errors),
    audience: readAudience(row),
    markets: { mode: "all" as const, marketIds: [] },
    schedule: {
      startsAt: readDate(row.cells.starts_at ?? "", row, "starts_at", errors),
      endsAt: readDate(row.cells.ends_at ?? "", row, "ends_at", errors),
    },
    createdAt: context.now,
  };
}

function planRulesTemplate(
  doc: CsvDocument,
  context: PlanContext,
  errors: ImportIssue[],
  warnings: ImportWarning[],
): PlannedRule[] {
  const planned: PlannedRule[] = [];
  const seenNames = new Map<string, number>();

  for (const row of doc.rows) {
    const before = errors.length;
    const base = baseFields(row, context, errors);

    if (!base.name) {
      errors.push({ line: row.line, column: "rule_name", code: "missing_required" });
      continue;
    }

    const rawType = normalize(row.cells.type ?? "");
    const kind = TYPE_ALIASES[rawType];
    if (!kind) {
      errors.push({
        line: row.line,
        column: "type",
        code: "unknown_type",
        params: { value: row.cells.type ?? "" },
      });
      continue;
    }

    const rawValue = (row.cells.value ?? "").trim();
    let rule: PricingRule;

    if (kind === "percentage") {
      const percentage = readNumber(rawValue, row, "value", errors, Number.NaN);
      rule = { ...base, kind: "percentage", value: { percentage } };
    } else {
      try {
        const amount = parseMoney(rawValue || "0", context.currencyCode);
        rule = { ...base, kind, value: { base: amount, overrides: {} } };
      } catch {
        errors.push({
          line: row.line,
          column: "value",
          code: "bad_money",
          params: { value: rawValue },
        });
        continue;
      }
    }

    // A price of zero may well be intended — free samples, a placeholder the
    // merchant will fill in — so it is a warning, not a refusal.
    if (rawValue === "0" || rawValue === "0.00") {
      warnings.push({ line: row.line, code: "zero_value" });
    }

    const issues = validateRule(rule);
    if (issues.length > 0) {
      for (const issue of issues) {
        errors.push({
          line: row.line,
          column: issue.field,
          code: "invalid_rule",
          params: { issue: issue.code, ...(issue.params ?? {}) },
        });
      }
      continue;
    }

    if (errors.length > before) continue;

    const key = base.name.toLowerCase();
    if (seenNames.has(key)) {
      warnings.push({
        line: row.line,
        code: "duplicate_name",
        params: { name: base.name },
      });
    }
    seenNames.set(key, row.line);

    if (context.existingNames.has(key)) {
      warnings.push({
        line: row.line,
        code: "existing_name",
        params: { name: base.name },
      });
    }

    planned.push({
      rule: { ...rule, id: `import-${planned.length}` },
      lines: [row.line],
    });
  }

  return planned;
}

function planQuantityBreaks(
  doc: CsvDocument,
  context: PlanContext,
  errors: ImportIssue[],
  warnings: ImportWarning[],
): PlannedRule[] {
  const groups = new Map<string, { rows: CsvRow[]; name: string }>();

  for (const row of doc.rows) {
    const name = (row.cells.rule_name ?? "").trim();
    if (!name) {
      errors.push({ line: row.line, column: "rule_name", code: "missing_required" });
      continue;
    }
    const key = name.toLowerCase();
    const group = groups.get(key) ?? { rows: [], name };
    group.rows.push(row);
    groups.set(key, group);
  }

  const planned: PlannedRule[] = [];

  for (const [key, group] of groups) {
    const before = errors.length;
    // The first row carries the rule's own settings; later rows add breaks.
    const first = group.rows[0]!;
    const base = baseFields(first, context, errors);

    const tiers = [];
    const seenMinimums = new Map<number, number>();

    for (const row of group.rows) {
      const min = readNumber(
        row.cells.min_quantity ?? "",
        row,
        "min_quantity",
        errors,
        Number.NaN,
      );
      if (!Number.isFinite(min)) continue;

      const maxRaw = (row.cells.max_quantity ?? "").trim();
      const max =
        maxRaw === ""
          ? null
          : readNumber(maxRaw, row, "max_quantity", errors, Number.NaN);

      // The same starting quantity twice: the later row wins, which is what a
      // spreadsheet edit usually means — but say so rather than silently pick.
      if (seenMinimums.has(min)) {
        warnings.push({
          line: row.line,
          code: "last_wins",
          params: { quantity: min, previousLine: seenMinimums.get(min)! },
        });
        const index = tiers.findIndex((tier) => tier.minQuantity === min);
        if (index >= 0) tiers.splice(index, 1);
      }
      seenMinimums.set(min, row.line);

      const type = normalize(row.cells.discount_type ?? "percentage");
      const rawValue = (row.cells.discount_value ?? "").trim();

      if (type === "percentage") {
        tiers.push({
          minQuantity: min,
          maxQuantity: max,
          kind: "percentage" as const,
          percentage: readNumber(rawValue, row, "discount_value", errors, Number.NaN),
        });
        continue;
      }

      try {
        const amount = parseMoney(rawValue || "0", context.currencyCode);
        tiers.push(
          type === "fixed_price"
            ? { minQuantity: min, maxQuantity: max, kind: "fixed_price" as const, amount }
            : { minQuantity: min, maxQuantity: max, kind: "amount_off" as const, amount },
        );
      } catch {
        errors.push({
          line: row.line,
          column: "discount_value",
          code: "bad_money",
          params: { value: rawValue },
        });
      }
    }

    const rule: PricingRule = {
      ...base,
      id: `import-${planned.length}`,
      kind: "volume_tier",
      value: { tiers: tiers.sort((a, b) => a.minQuantity - b.minQuantity) },
    };

    const issues = validateRule(rule);
    if (issues.length > 0) {
      for (const issue of issues) {
        errors.push({
          line: first.line,
          column: issue.field,
          code: "invalid_rule",
          params: { issue: issue.code, ...(issue.params ?? {}) },
        });
      }
      continue;
    }

    if (errors.length > before) continue;

    if (context.existingNames.has(key)) {
      warnings.push({
        line: first.line,
        code: "existing_name",
        params: { name: group.name },
      });
    }

    planned.push({ rule, lines: group.rows.map((row) => row.line) });
  }

  return planned;
}

export function planImport(
  doc: CsvDocument,
  template: TemplateKey,
  context: PlanContext,
): ImportPlan {
  const errors: ImportIssue[] = [];
  const warnings: ImportWarning[] = [];

  for (const line of doc.raggedLines) {
    // Not fatal — a short row usually just means trailing commas — but the
    // merchant should know which lines the columns may have shifted on.
    warnings.push({ line, code: "ragged_row" });
  }

  const planned =
    template === "quantity_breaks"
      ? planQuantityBreaks(doc, context, errors, warnings)
      : planRulesTemplate(doc, context, errors, warnings);

  return {
    template,
    totalRows: doc.rows.length,
    planned,
    errors,
    warnings,
  };
}

/** Every SKU the file mentions, so they can be resolved in one round trip. */
export function skusIn(doc: CsvDocument): string[] {
  const skus = new Set<string>();
  for (const row of doc.rows) {
    for (const sku of splitList(row.cells.skus ?? "")) skus.add(sku);
  }
  return [...skus];
}
