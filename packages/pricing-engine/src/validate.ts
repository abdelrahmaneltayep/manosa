import { compareMoney, type Money } from "./money";
import type { CartValueTier, PricingRule, VolumeTier } from "./types";

/**
 * Validation lives with the rule model, not with the form.
 *
 * The manual builder, the CSV import and Claude's rule-from-a-sentence all
 * produce rules, and all three have to agree on what a valid one is. Codes
 * rather than sentences, because the admin renders them in the merchant's
 * language and the AI draft path shows them as chips.
 */
export type RuleIssueCode =
  | "name_required"
  | "percentage_out_of_range"
  | "amount_negative"
  | "end_before_start"
  | "no_targets"
  | "no_audience"
  | "no_tiers"
  | "tier_overlap"
  | "tier_min_above_max"
  | "tier_quantity_invalid"
  | "tier_currency_mismatch";

export interface RuleIssue {
  code: RuleIssueCode;
  /** Dotted path to the offending field, for focusing the right input. */
  field: string;
  /** Values the message needs — e.g. the two overlapping ranges. */
  params?: Record<string, string | number>;
}

function checkPercentage(percentage: number, field: string, issues: RuleIssue[]): void {
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    issues.push({ code: "percentage_out_of_range", field, params: { percentage } });
  }
}

function checkAmount(amount: Money, field: string, issues: RuleIssue[]): void {
  if (amount.amount < 0) {
    issues.push({ code: "amount_negative", field, params: { amount: amount.amount } });
  }
}

function checkVolumeTiers(tiers: VolumeTier[], issues: RuleIssue[]): void {
  if (tiers.length === 0) {
    issues.push({ code: "no_tiers", field: "value.tiers" });
    return;
  }

  tiers.forEach((tier, index) => {
    const field = `value.tiers.${index}`;

    if (!Number.isSafeInteger(tier.minQuantity) || tier.minQuantity < 1) {
      issues.push({
        code: "tier_quantity_invalid",
        field: `${field}.minQuantity`,
        params: { minQuantity: tier.minQuantity },
      });
    }

    if (tier.maxQuantity !== null && tier.maxQuantity < tier.minQuantity) {
      issues.push({
        code: "tier_min_above_max",
        field,
        params: { min: tier.minQuantity, max: tier.maxQuantity },
      });
    }

    if (tier.kind === "percentage") checkPercentage(tier.percentage, field, issues);
    else checkAmount(tier.amount, field, issues);
  });

  // Overlap, reported as the merchant sees it: "10–49 overlaps 40–60".
  const sorted = [...tiers]
    .map((tier, index) => ({ tier, index }))
    .sort((a, b) => a.tier.minQuantity - b.tier.minQuantity);

  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    const previousMax = previous.tier.maxQuantity;

    if (previousMax === null || current.tier.minQuantity <= previousMax) {
      issues.push({
        code: "tier_overlap",
        field: `value.tiers.${current.index}`,
        params: {
          first: rangeLabel(previous.tier.minQuantity, previousMax),
          second: rangeLabel(current.tier.minQuantity, current.tier.maxQuantity),
        },
      });
    }
  }
}

function rangeLabel(min: number, max: number | null): string {
  return max === null ? `${min}+` : `${min}–${max}`;
}

function checkCartValueTiers(tiers: CartValueTier[], issues: RuleIssue[]): void {
  if (tiers.length === 0) {
    issues.push({ code: "no_tiers", field: "value.tiers" });
    return;
  }

  tiers.forEach((tier, index) => {
    const field = `value.tiers.${index}`;

    if (tier.maxSubtotal) {
      if (tier.maxSubtotal.currencyCode !== tier.minSubtotal.currencyCode) {
        issues.push({ code: "tier_currency_mismatch", field });
      } else if (compareMoney(tier.maxSubtotal, tier.minSubtotal) < 0) {
        issues.push({ code: "tier_min_above_max", field });
      }
    }

    if (tier.kind === "percentage") checkPercentage(tier.percentage, field, issues);
    else checkAmount(tier.amount, field, issues);
  });
}

function hasTargets(rule: PricingRule): boolean {
  const { targets } = rule;
  switch (targets.mode) {
    case "all":
      return true;
    case "collections":
      return (targets.collectionIds ?? []).length > 0;
    case "products":
      return (targets.productIds ?? []).length > 0;
    case "variants":
      return (targets.variantIds ?? []).length > 0;
    default:
      return false;
  }
}

function hasAudience(rule: PricingRule): boolean {
  const { audience } = rule;
  switch (audience.mode) {
    case "all":
    case "guests":
      return true;
    case "tags":
      return (audience.tags ?? []).length > 0;
    case "groups":
      return (audience.groupIds ?? []).length > 0;
    case "customers":
      return (audience.customerIds ?? []).length > 0;
    case "companies":
      return (audience.companyIds ?? []).length > 0;
    default:
      return false;
  }
}

/** Every problem with a rule, in one pass. Empty means it is safe to activate. */
export function validateRule(rule: PricingRule): RuleIssue[] {
  const issues: RuleIssue[] = [];

  if (!rule.name?.trim()) issues.push({ code: "name_required", field: "name" });

  if (!hasTargets(rule)) issues.push({ code: "no_targets", field: "targets" });
  if (!hasAudience(rule)) issues.push({ code: "no_audience", field: "audience" });

  const { startsAt, endsAt } = rule.schedule;
  if (startsAt && endsAt && endsAt <= startsAt) {
    issues.push({ code: "end_before_start", field: "schedule.endsAt" });
  }

  switch (rule.kind) {
    case "percentage":
      checkPercentage(rule.value.percentage, "value.percentage", issues);
      break;
    case "amount_off":
    case "fixed_price":
      checkAmount(rule.value.base, "value.base", issues);
      for (const [code, amount] of Object.entries(rule.value.overrides)) {
        checkAmount(amount, `value.overrides.${code}`, issues);
      }
      break;
    case "volume_tier":
      checkVolumeTiers(rule.value.tiers, issues);
      break;
    case "cart_value_tier":
      checkCartValueTiers(rule.value.tiers, issues);
      break;
  }

  return issues;
}

export function isValidRule(rule: PricingRule): boolean {
  return validateRule(rule).length === 0;
}
