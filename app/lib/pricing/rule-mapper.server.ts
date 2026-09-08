import type { PricingRule as PricingRuleRow, Prisma } from "@prisma/client";
import {
  deserializeRule,
  serializeRule,
  type PricingRule,
  type RuleKind,
  type RuleStatus,
} from "@mannon/pricing-engine";

/**
 * Database row ↔ engine rule.
 *
 * The JSON columns hold the engine's own wire shapes, so a row becomes a rule
 * through exactly the code that reads the published ruleset at checkout. One
 * definition of a rule, not a storage one and an engine one that drift.
 */

const KIND_TO_DB = {
  fixed_price: "FIXED_PRICE",
  volume_tier: "VOLUME_TIER",
  cart_value_tier: "CART_VALUE_TIER",
  amount_off: "AMOUNT_OFF",
  percentage: "PERCENTAGE",
} as const satisfies Record<RuleKind, PricingRuleRow["kind"]>;

const KIND_FROM_DB = Object.fromEntries(
  Object.entries(KIND_TO_DB).map(([engine, db]) => [db, engine]),
) as Record<PricingRuleRow["kind"], RuleKind>;

const STATUS_TO_DB = {
  draft: "DRAFT",
  active: "ACTIVE",
  archived: "ARCHIVED",
} as const satisfies Record<RuleStatus, PricingRuleRow["status"]>;

const STATUS_FROM_DB = Object.fromEntries(
  Object.entries(STATUS_TO_DB).map(([engine, db]) => [db, engine]),
) as Record<PricingRuleRow["status"], RuleStatus>;

export function kindToDb(kind: RuleKind): PricingRuleRow["kind"] {
  return KIND_TO_DB[kind];
}

export function kindFromDb(kind: PricingRuleRow["kind"]): RuleKind {
  return KIND_FROM_DB[kind];
}

export function statusToDb(status: RuleStatus): PricingRuleRow["status"] {
  return STATUS_TO_DB[status];
}

export function statusFromDb(status: PricingRuleRow["status"]): RuleStatus {
  return STATUS_FROM_DB[status];
}

export class RuleDecodeError extends Error {
  constructor(
    readonly ruleId: string,
    readonly detail: string,
  ) {
    super(`Rule ${ruleId} could not be read: ${detail}`);
    this.name = "RuleDecodeError";
  }
}

/**
 * Turn a row into an engine rule.
 *
 * Throws rather than returning a partial rule: a row we cannot read is a bug
 * in a migration or a hand-edit, and pricing with half of it would be worse
 * than failing where someone can see it.
 */
export function toEngineRule(row: PricingRuleRow): PricingRule {
  const result = deserializeRule({
    id: row.id,
    name: row.name,
    status: statusFromDb(row.status),
    priority: row.priority,
    combinable: row.combinable,
    kind: kindFromDb(row.kind),
    value: row.value,
    targets: row.targets,
    audience: row.audience,
    markets: row.markets,
    startsAt: row.startsAt ? row.startsAt.toISOString() : null,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  });

  if ("error" in result) throw new RuleDecodeError(row.id, result.error.message);
  return result.rule;
}

/** Rows that can be read, and the ids of any that cannot. */
export function toEngineRules(rows: PricingRuleRow[]): {
  rules: PricingRule[];
  unreadable: { id: string; message: string }[];
} {
  const rules: PricingRule[] = [];
  const unreadable: { id: string; message: string }[] = [];

  for (const row of rows) {
    try {
      rules.push(toEngineRule(row));
    } catch (error) {
      unreadable.push({
        id: row.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { rules, unreadable };
}

/** The columns that make up a rule's definition, ready for create or update. */
export function toRowData(
  rule: PricingRule,
): Pick<
  Prisma.PricingRuleUncheckedCreateInput,
  | "name"
  | "status"
  | "kind"
  | "priority"
  | "combinable"
  | "value"
  | "targets"
  | "audience"
  | "markets"
  | "startsAt"
  | "endsAt"
> {
  const wire = serializeRule(rule);

  return {
    name: wire.name,
    status: statusToDb(wire.status),
    kind: kindToDb(wire.kind),
    priority: wire.priority,
    combinable: wire.combinable,
    value: wire.value as Prisma.InputJsonValue,
    targets: wire.targets as unknown as Prisma.InputJsonValue,
    audience: wire.audience as unknown as Prisma.InputJsonValue,
    markets: wire.markets as unknown as Prisma.InputJsonValue,
    startsAt: rule.schedule.startsAt,
    endsAt: rule.schedule.endsAt,
  };
}
