import { money, type Money } from "@mannon/pricing-engine";

/**
 * Customer segments: a saved filter, not a saved list.
 *
 * "Spend over $5,000 and no order in 45 days" stays true as the customers
 * change, which is the whole point — a list of 84 people captured in March is
 * wrong by April and nothing says so.
 *
 * Pure. Every condition is a closed shape with a closed operator, so a segment
 * that came from a sentence Claude read is the same kind of object as one the
 * merchant built by hand, and both are checked by the same function before
 * anything is stored or run.
 */

export const SEGMENT_FIELDS = [
  "lifetime_spend",
  "order_count",
  "last_order_days",
  "never_ordered",
  "tag",
  "group",
  "country",
  "tax_exempt",
  "status",
] as const;

export type SegmentField = (typeof SEGMENT_FIELDS)[number];

export type NumericOperator = "gt" | "gte" | "lt" | "lte";

export const BUYER_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type BuyerStatusValue = (typeof BUYER_STATUSES)[number];

export type SegmentCondition =
  | { field: "lifetime_spend"; op: NumericOperator; amount: Money }
  | { field: "order_count"; op: NumericOperator; value: number }
  /** Days since their last order. "no order in 45 days" is `gt` 45. */
  | { field: "last_order_days"; op: NumericOperator; value: number }
  | { field: "never_ordered" }
  | { field: "tag"; op: "has" | "not_has"; value: string }
  | { field: "group"; op: "is" | "is_not"; groupId: string }
  | { field: "country"; op: "is" | "is_not"; value: string }
  | { field: "tax_exempt"; value: boolean }
  | { field: "status"; value: BuyerStatusValue };

/**
 * Conditions are ANDed.
 *
 * Deliberately not a tree. "Spend over $5k · last order over 45 days ago" is
 * what a merchant means and what fits in a row of chips; an OR nested three
 * deep is a query builder, and a query builder is what this feature exists to
 * avoid. A merchant who needs one saves two segments.
 */
export const MAX_CONDITIONS = 8;

export type SegmentIssueCode =
  | "no_conditions"
  | "too_many_conditions"
  | "duplicate_field"
  | "unknown_field"
  | "bad_operator"
  | "bad_value"
  | "name_required"
  | "name_too_long";

export interface SegmentIssue {
  code: SegmentIssueCode;
  /** Index into the condition list, or null for a whole-segment problem. */
  index: number | null;
  params?: Record<string, string | number>;
}

export const MAX_NAME = 60;

const NUMERIC_OPS: ReadonlySet<string> = new Set(["gt", "gte", "lt", "lte"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMoney = (value: unknown): value is Money =>
  isRecord(value) &&
  Number.isSafeInteger(value.amount) &&
  typeof value.currencyCode === "string" &&
  value.currencyCode.length === 3;

/**
 * Read one condition from unknown data.
 *
 * Used on the way in from a form, from stored JSON, and from a model's answer.
 * One reader, so a segment cannot mean one thing when it is saved and another
 * when it is run.
 */
export function readCondition(value: unknown): SegmentCondition | null {
  if (!isRecord(value)) return null;

  switch (value.field) {
    case "lifetime_spend":
      if (typeof value.op !== "string" || !NUMERIC_OPS.has(value.op)) return null;
      if (!isMoney(value.amount) || value.amount.amount < 0) return null;
      return {
        field: "lifetime_spend",
        op: value.op as NumericOperator,
        amount: money(value.amount.amount, value.amount.currencyCode),
      };

    case "order_count":
    case "last_order_days": {
      if (typeof value.op !== "string" || !NUMERIC_OPS.has(value.op)) return null;
      const n = Number(value.value);
      if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(n)) return null;
      return { field: value.field, op: value.op as NumericOperator, value: n };
    }

    case "never_ordered":
      return { field: "never_ordered" };

    case "tag": {
      const tag = typeof value.value === "string" ? value.value.trim() : "";
      if (!tag) return null;
      if (value.op !== "has" && value.op !== "not_has") return null;
      return { field: "tag", op: value.op, value: tag };
    }

    case "group": {
      const groupId = typeof value.groupId === "string" ? value.groupId.trim() : "";
      if (!groupId) return null;
      if (value.op !== "is" && value.op !== "is_not") return null;
      return { field: "group", op: value.op, groupId };
    }

    case "country": {
      const code =
        typeof value.value === "string" ? value.value.trim().toUpperCase() : "";
      if (!/^[A-Z]{2}$/.test(code)) return null;
      if (value.op !== "is" && value.op !== "is_not") return null;
      return { field: "country", op: value.op, value: code };
    }

    case "tax_exempt":
      if (typeof value.value !== "boolean") return null;
      return { field: "tax_exempt", value: value.value };

    case "status": {
      const status = value.value;
      if (typeof status !== "string") return null;
      if (!(BUYER_STATUSES as readonly string[]).includes(status)) return null;
      return { field: "status", value: status as BuyerStatusValue };
    }

    default:
      return null;
  }
}

/** Read a whole list, dropping nothing silently — see `validateSegment`. */
export function readConditions(value: unknown): SegmentCondition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const condition = readCondition(entry);
    return condition ? [condition] : [];
  });
}

export function validateSegment(
  name: string,
  conditions: readonly SegmentCondition[],
): SegmentIssue[] {
  const issues: SegmentIssue[] = [];

  if (name.trim() === "") issues.push({ code: "name_required", index: null });
  if (name.trim().length > MAX_NAME) {
    issues.push({ code: "name_too_long", index: null, params: { max: MAX_NAME } });
  }

  if (conditions.length === 0) {
    issues.push({ code: "no_conditions", index: null });
  }
  if (conditions.length > MAX_CONDITIONS) {
    issues.push({
      code: "too_many_conditions",
      index: null,
      params: { max: MAX_CONDITIONS },
    });
  }

  // Two conditions on the same field are almost always a mistake and are always
  // confusing: "spend over $5k and spend over $200" is one condition badly.
  // Tags are the exception — "has wholesale and not has lapsed" is a real ask.
  const seen = new Set<string>();
  conditions.forEach((condition, index) => {
    if (condition.field === "tag") return;
    if (seen.has(condition.field)) {
      issues.push({
        code: "duplicate_field",
        index,
        params: { field: condition.field },
      });
    }
    seen.add(condition.field);
  });

  return issues;
}

/**
 * Which condition is doing the excluding.
 *
 * When a segment matches nobody, the merchant needs to know which chip to
 * loosen — the checklist's "No one matches — loosen which condition?". Answered
 * by counting without each one in turn and picking the one whose absence helps
 * most, which is arithmetic, not a guess.
 */
export function tightestCondition(
  counts: readonly { index: number; countWithout: number }[],
): number | null {
  let best: { index: number; countWithout: number } | null = null;

  for (const entry of counts) {
    if (entry.countWithout <= 0) continue;
    if (!best || entry.countWithout > best.countWithout) best = entry;
  }

  return best?.index ?? null;
}
