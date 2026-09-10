import {
  formatMoney,
  type MarginGuardReport,
  type PricingRule,
  type VolumeTier,
} from "@mannon/pricing-engine";

import type {
  ClarificationView,
  DescribeFailure,
  DescribeRuleView,
  DraftCardView,
  MarginGuardView,
} from "~/components/pricing/types";
import type { Translate } from "~/i18n/translate";
import type { Clarification } from "~/lib/ai/prompts/rule-from-sentence.server";
import { formatCurrency } from "~/lib/money";
import {
  builderFields,
  encodeDraft,
  type DraftEnvelope,
} from "~/lib/pricing/describe.server";
import type { MarginGuardResult } from "~/lib/pricing/margin-guard.server";
import { summariseAudience, summariseTargets } from "~/lib/pricing/view-model.server";

/** Only the worst few are listed. The count is always the true one. */
const WORST_SHOWN = 3;

/** Three examples, so the box is not a blank prompt. Localised. */
export const EXAMPLE_KEYS = [
  "describe.example1",
  "describe.example2",
  "describe.example3",
] as const;

function tierChip(tier: VolumeTier, t: Translate): string {
  const range =
    tier.maxQuantity === null
      ? t("describe.chip.from", { min: tier.minQuantity })
      : t("describe.chip.range", { min: tier.minQuantity, max: tier.maxQuantity });

  const value =
    tier.kind === "percentage"
      ? t("describe.chip.percentage", { percentage: tier.percentage })
      : tier.kind === "amount_off"
        ? t("describe.chip.amountOff", { amount: formatMoney(tier.amount) })
        : t("describe.chip.fixedPrice", { amount: formatMoney(tier.amount) });

  return `${range} · ${value}`;
}

function chipsFor(rule: PricingRule, t: Translate): string[] {
  switch (rule.kind) {
    case "volume_tier":
      return [...rule.value.tiers]
        .sort((a, b) => a.minQuantity - b.minQuantity)
        .map((tier) => tierChip(tier, t));
    case "cart_value_tier":
      return rule.value.tiers.map((tier) =>
        t("describe.chip.cartTier", {
          subtotal: formatMoney(tier.minSubtotal),
          value:
            tier.kind === "percentage"
              ? t("describe.chip.percentage", { percentage: tier.percentage })
              : t("describe.chip.fixedPrice", { amount: formatMoney(tier.amount) }),
        }),
      );
    case "percentage":
      return [t("describe.chip.percentage", { percentage: rule.value.percentage })];
    case "amount_off":
      return [t("describe.chip.amountOff", { amount: formatMoney(rule.value.base) })];
    case "fixed_price":
    default:
      return [t("describe.chip.fixedPrice", { amount: formatMoney(rule.value.base) })];
  }
}

function scheduleSummary(rule: PricingRule, t: Translate): string | null {
  const { startsAt, endsAt } = rule.schedule;
  const day = (value: Date) => value.toISOString().slice(0, 10);

  if (startsAt && endsAt) {
    return t("describe.scheduleBetween", { from: day(startsAt), to: day(endsAt) });
  }
  if (startsAt) return t("describe.scheduleFrom", { from: day(startsAt) });
  if (endsAt) return t("describe.scheduleUntil", { to: day(endsAt) });
  return null;
}

export function draftCard(
  envelope: DraftEnvelope,
  rule: PricingRule,
  currencyCode: string,
  t: Translate,
): DraftCardView {
  return {
    name: rule.name,
    kindLabel: t(`pricing.kind.${rule.kind}`),
    chips: chipsFor(rule, t),
    targetsSummary: summariseTargets({ ...rule.targets }, t),
    audienceSummary: summariseAudience({ ...rule.audience }, t),
    scheduleSummary: scheduleSummary(rule, t),
    combinable: rule.combinable,
    notes: envelope.notes,
    payload: encodeDraft(envelope),
    builderFields: builderFields(rule, currencyCode),
  };
}

export function clarificationViews(
  clarifications: readonly Clarification[],
): ClarificationView[] {
  return clarifications.map((one) => ({
    key: `${one.field}:${one.term}`,
    field: one.field,
    term: one.term,
    options: one.options,
  }));
}

export function marginView(
  result: MarginGuardResult,
  locale: string,
): MarginGuardView | null {
  if (result.status === "unavailable") {
    return {
      status: "unavailable",
      checked: 0,
      costUnknown: 0,
      sampled: false,
      belowCostCount: 0,
      worst: [],
    };
  }

  const report: MarginGuardReport | null = result.report;
  if (!report) return null;

  return {
    status: "checked",
    checked: report.checked,
    costUnknown: report.costUnknown,
    sampled: result.sampled,
    belowCostCount: report.belowCost.length,
    worst: report.belowCost.slice(0, WORST_SHOWN).map((finding) => ({
      label: finding.sku ?? finding.title,
      title: finding.title,
      quantity: finding.quantity,
      unitPrice: formatCurrency(finding.unitPrice, locale),
      unitCost: formatCurrency(finding.unitCost, locale),
      shortfall: formatCurrency(finding.shortfall, locale),
    })),
  };
}

export interface DescribeViewOptions {
  aiAvailable: boolean;
  sentence: string;
  atRuleLimit: boolean;
  t: Translate;
  failure?: DescribeFailure | null;
  draft?: DraftCardView | null;
  clarifications?: ClarificationView[];
  margin?: MarginGuardView | null;
  approveAnywayMissing?: boolean;
}

export function describeView(options: DescribeViewOptions): DescribeRuleView {
  const margin = options.margin ?? null;

  return {
    aiAvailable: options.aiAvailable,
    sentence: options.sentence,
    examples: EXAMPLE_KEYS.map((key) => options.t(key)),
    failure: options.failure ?? null,
    draft: options.draft ?? null,
    clarifications: options.clarifications ?? [],
    margin,
    // Only a real finding makes the merchant tick a box. A check that could not
    // run is a warning, not a hurdle — it would be a hurdle on every save in a
    // store that has never recorded a cost.
    approveAnywayRequired: (margin?.belowCostCount ?? 0) > 0,
    approveAnywayMissing: options.approveAnywayMissing ?? false,
    atRuleLimit: options.atRuleLimit,
  };
}
