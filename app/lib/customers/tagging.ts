import { compareMoney, money, type Money } from "@mannon/pricing-engine";

/**
 * The auto-tagging engine.
 *
 * Pure and deterministic, in the same spirit as the pricing engine: no clock,
 * no database, no network. `now` is a parameter because a rule that says "no
 * order in 60 days" must give the same answer in a preview as it does in the
 * nightly sweep — a merchant who is shown "12 customers match" and then sees 9
 * tagged has no reason to trust the feature again.
 *
 * It decides which tags to add and remove. It does not write anything; the
 * caller does that, and audits it.
 */

/** Facts about a buyer that a condition can look at. */
export interface BuyerFacts {
  /** Shopify's lifetime total for this customer. Not a price we computed. */
  lifetimeSpend: Money;
  orderCount: number;
  /** ISO 3166-1 alpha-2, uppercased, or null when Shopify has no address. */
  countryCode: string | null;
  lastOrderAt: Date | null;
  /** Current tags, normalised. */
  tags: string[];
  /**
   * Answers from the registration form, keyed by field. Empty until forms land
   * in phase 2.2 — a rule that reads an answer simply does not match until
   * there is an answer to read, which is the honest behaviour.
   */
  answers: Record<string, string>;
}

export type NumericOperator = "gte" | "lte";
export type SetOperator = "in" | "not_in";
export type TextOperator = "equals" | "contains";

export type TagCondition =
  | { field: "lifetime_spend"; op: NumericOperator; amount: Money }
  | { field: "order_count"; op: NumericOperator; value: number }
  | { field: "days_since_last_order"; op: NumericOperator; value: number }
  | { field: "country"; op: SetOperator; values: string[] }
  | { field: "has_tag"; tag: string }
  | { field: "lacks_tag"; tag: string }
  | { field: "form_answer"; key: string; op: TextOperator; value: string };

export const CONDITION_FIELDS = [
  "lifetime_spend",
  "order_count",
  "days_since_last_order",
  "country",
  "has_tag",
  "lacks_tag",
  "form_answer",
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

export interface TagRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  matchMode: "all" | "any";
  conditions: TagCondition[];
  addTags: string[];
  removeTags: string[];
}

export interface TagDecision {
  /** Tags the buyer should gain, sorted, none of which they already have. */
  add: string[];
  /** Tags the buyer should lose, sorted, all of which they currently have. */
  remove: string[];
  /** The resulting tag list, sorted. */
  tags: string[];
  /** Ids of the rules that matched, in the order they ran. */
  matched: string[];
  /** True when nothing would change — the caller can skip the write. */
  unchanged: boolean;
}

const DAY_MS = 86_400_000;

/** Tags differ only by spacing and case as far as merchants are concerned. */
export function normalizeTag(tag: string): string {
  return tag.trim();
}

export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map(normalizeTag).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "en"),
  );
}

const sameTag = (a: string, b: string) =>
  normalizeTag(a).toLowerCase() === normalizeTag(b).toLowerCase();

function compareNumber(op: NumericOperator, left: number, right: number): boolean {
  return op === "gte" ? left >= right : left <= right;
}

export function matchesCondition(
  condition: TagCondition,
  facts: BuyerFacts,
  now: Date,
): boolean {
  switch (condition.field) {
    case "lifetime_spend": {
      // Comparing across currencies would mean inventing an exchange rate.
      // A rule written in USD simply does not apply to a EUR buyer.
      if (facts.lifetimeSpend.currencyCode !== condition.amount.currencyCode)
        return false;
      const order = compareMoney(facts.lifetimeSpend, condition.amount);
      return condition.op === "gte" ? order >= 0 : order <= 0;
    }
    case "order_count":
      return compareNumber(condition.op, facts.orderCount, condition.value);
    case "days_since_last_order": {
      // A buyer who has never ordered has no "days since" — treating that as
      // infinity would sweep every new signup into a win-back segment.
      if (!facts.lastOrderAt) return false;
      const days = Math.floor((now.getTime() - facts.lastOrderAt.getTime()) / DAY_MS);
      return compareNumber(condition.op, days, condition.value);
    }
    case "country": {
      if (!facts.countryCode) return condition.op === "not_in";
      const listed = condition.values.some(
        (value) => value.trim().toUpperCase() === facts.countryCode,
      );
      return condition.op === "in" ? listed : !listed;
    }
    case "has_tag":
      return facts.tags.some((tag) => sameTag(tag, condition.tag));
    case "lacks_tag":
      return !facts.tags.some((tag) => sameTag(tag, condition.tag));
    case "form_answer": {
      const answer = facts.answers[condition.key];
      if (answer === undefined) return false;
      const left = answer.trim().toLowerCase();
      const right = condition.value.trim().toLowerCase();
      return condition.op === "equals" ? left === right : left.includes(right);
    }
  }
}

export function matchesRule(rule: TagRule, facts: BuyerFacts, now: Date): boolean {
  // A rule with no conditions matches nobody. The alternative — matching
  // everybody — would tag an entire customer base on a half-finished rule.
  if (rule.conditions.length === 0) return false;

  return rule.matchMode === "any"
    ? rule.conditions.some((condition) => matchesCondition(condition, facts, now))
    : rule.conditions.every((condition) => matchesCondition(condition, facts, now));
}

/**
 * Decide a buyer's tags.
 *
 * Rules run in priority order, and a later rule may remove what an earlier one
 * added — last write wins, which is what "lower runs first and wins" would
 * contradict, so read it the other way round: the *last* rule to speak about a
 * tag decides it. That is the only ordering a merchant can reason about when
 * one rule adds `vip` and another removes it.
 */
export function evaluateTagRules(
  rules: readonly TagRule[],
  facts: BuyerFacts,
  now: Date,
): TagDecision {
  const current = normalizeTags(facts.tags);
  const normalizedFacts: BuyerFacts = { ...facts, tags: current };
  // Keyed case-insensitively so "VIP" and "vip" are one decision, but carrying
  // the casing the merchant actually typed, which is what gets written back.
  const decided = new Map<string, { tag: string; wanted: boolean }>();
  const matched: string[] = [];

  const ordered = [...rules]
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id, "en"));

  for (const rule of ordered) {
    if (!matchesRule(rule, normalizedFacts, now)) continue;
    matched.push(rule.id);
    for (const tag of rule.addTags.map(normalizeTag).filter(Boolean)) {
      decided.set(tag.toLowerCase(), { tag, wanted: true });
    }
    for (const tag of rule.removeTags.map(normalizeTag).filter(Boolean)) {
      decided.set(tag.toLowerCase(), { tag, wanted: false });
    }
  }

  const keep = current.filter((tag) => decided.get(tag.toLowerCase())?.wanted !== false);
  const add = [...decided.values()]
    .filter((entry) => entry.wanted)
    .map((entry) => entry.tag)
    .filter((tag) => !keep.some((existing) => sameTag(existing, tag)));
  const remove = current.filter(
    (tag) => decided.get(tag.toLowerCase())?.wanted === false,
  );
  const tags = normalizeTags([...keep, ...add]);

  return {
    add: normalizeTags(add),
    remove: normalizeTags(remove),
    tags,
    matched,
    unchanged: add.length === 0 && remove.length === 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading rules back out of storage                                           */
/* -------------------------------------------------------------------------- */

/**
 * Parse stored conditions. Never throws.
 *
 * A malformed condition costs its rule, not the sweep: one bad row must not
 * stop every other rule from running, and it must never widen a match — an
 * unreadable condition is dropped and its rule becomes unmatchable rather than
 * matching everyone.
 */
export function deserializeConditions(value: unknown): {
  conditions: TagCondition[];
  errors: string[];
} {
  const errors: string[] = [];
  if (!Array.isArray(value))
    return { conditions: [], errors: ["conditions are not a list"] };

  const conditions: TagCondition[] = [];

  for (const [index, raw] of value.entries()) {
    const condition = readCondition(raw);
    if (condition) conditions.push(condition);
    else errors.push(`condition ${index} could not be read`);
  }

  return { conditions, errors };
}

function readCondition(raw: unknown): TagCondition | null {
  if (typeof raw !== "object" || raw === null) return null;
  const node = raw as Record<string, unknown>;
  const numeric = (op: unknown): op is NumericOperator => op === "gte" || op === "lte";

  switch (node.field) {
    case "lifetime_spend": {
      const amount = node.amount as Partial<Money> | undefined;
      if (
        !numeric(node.op) ||
        !amount ||
        !Number.isSafeInteger(amount.amount) ||
        typeof amount.currencyCode !== "string"
      ) {
        return null;
      }
      return {
        field: "lifetime_spend",
        op: node.op,
        amount: money(amount.amount!, amount.currencyCode),
      };
    }
    case "order_count":
    case "days_since_last_order": {
      const value = Number(node.value);
      if (!numeric(node.op) || !Number.isFinite(value)) return null;
      return { field: node.field, op: node.op, value };
    }
    case "country": {
      if (node.op !== "in" && node.op !== "not_in") return null;
      if (!Array.isArray(node.values)) return null;
      const values = node.values.filter((v): v is string => typeof v === "string");
      if (values.length === 0) return null;
      return { field: "country", op: node.op, values };
    }
    case "has_tag":
    case "lacks_tag": {
      if (typeof node.tag !== "string" || !node.tag.trim()) return null;
      return { field: node.field, tag: node.tag };
    }
    case "form_answer": {
      if (node.op !== "equals" && node.op !== "contains") return null;
      if (typeof node.key !== "string" || typeof node.value !== "string") return null;
      if (!node.key.trim()) return null;
      return { field: "form_answer", op: node.op, key: node.key, value: node.value };
    }
    default:
      return null;
  }
}

export interface TagRuleIssue {
  code:
    | "name_missing"
    | "no_conditions"
    | "no_tags"
    | "tag_added_and_removed"
    | "unreadable_condition";
  detail?: string;
}

/** Validate before saving. The UI shows these; the server refuses on them. */
export function validateTagRule(rule: {
  name: string;
  conditions: TagCondition[];
  addTags: string[];
  removeTags: string[];
}): TagRuleIssue[] {
  const issues: TagRuleIssue[] = [];

  if (!rule.name.trim()) issues.push({ code: "name_missing" });
  if (rule.conditions.length === 0) issues.push({ code: "no_conditions" });
  if (rule.addTags.length === 0 && rule.removeTags.length === 0) {
    issues.push({ code: "no_tags" });
  }

  for (const tag of rule.addTags) {
    if (rule.removeTags.some((other) => sameTag(other, tag))) {
      issues.push({ code: "tag_added_and_removed", detail: normalizeTag(tag) });
    }
  }

  return issues;
}
