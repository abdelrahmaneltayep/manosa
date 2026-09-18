import {
  formatMoney,
  money,
  parseMoney,
  resolvePrice,
  type PricingRule,
  type PricingContext,
} from "@mannon/pricing-engine";
import type { PricingRule as PricingRuleRow } from "@prisma/client";

import type {
  ExplainView,
  PreviewView,
  RuleFormView,
  RuleRowView,
} from "~/components/pricing/types";
import { localDay } from "~/lib/analytics/series.server";
import { formatCurrency } from "~/lib/money";
import { kindFromDb, statusFromDb, toEngineRule } from "~/lib/pricing/rule-mapper.server";

/** A rule with no uses is only "unused" once it has had time to be used. */
const UNUSED_AFTER_DAYS = 30;

const daysBetween = (from: Date, to: Date) =>
  Math.ceil((to.getTime() - from.getTime()) / 86_400_000);

function countOf(list: unknown): number {
  return Array.isArray(list) ? list.length : 0;
}

export function summariseTargets(
  targets: Record<string, unknown>,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const mode = String(targets.mode ?? "all");
  const base =
    mode === "all"
      ? t("pricing.targets.all")
      : t(`pricing.targets.${mode}`, {
          count: countOf(
            targets[`${mode.replace(/s$/, "")}Ids`] ?? targets[`${mode}Ids`],
          ),
        });

  const excluded =
    countOf(targets.excludeCollectionIds) +
    countOf(targets.excludeProductIds) +
    countOf(targets.excludeVariantIds);

  return excluded > 0 ? t("pricing.targets.withExclusions", { summary: base }) : base;
}

export function summariseAudience(
  audience: Record<string, unknown>,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const mode = String(audience.mode ?? "all");

  switch (mode) {
    case "all":
      return t("pricing.audience.all");
    case "guests":
      return t("pricing.audience.guests");
    case "tags":
      return t("pricing.audience.tags", {
        tags: (Array.isArray(audience.tags) ? audience.tags : []).join(", "),
      });
    default:
      return t(`pricing.audience.${mode}`, {
        count: countOf(audience[`${mode.replace(/s$/, "")}Ids`]),
      });
  }
}

export function toRowView(
  row: PricingRuleRow,
  options: {
    now: Date;
    duplicateNames: Set<string>;
    t: (key: string, params?: Record<string, unknown>) => string;
  },
): RuleRowView {
  const { now, t } = options;
  const ageDays = daysBetween(row.createdAt, now);

  return {
    id: row.id,
    name: row.name,
    kind: kindFromDb(row.kind),
    status: statusFromDb(row.status),
    priority: row.priority,
    targetsSummary: summariseTargets(row.targets as Record<string, unknown>, t),
    audienceSummary: summariseAudience(row.audience as Record<string, unknown>, t),
    usage30d: row.usageCount30d,
    // A rule created yesterday with no uses is new, not unused. Saying
    // otherwise would be telling the merchant something untrue.
    unused: row.usageCount30d === 0 && ageDays >= UNUSED_AFTER_DAYS,
    missingTargetCount: row.missingTargetCount,
    startsInDays:
      row.startsAt && row.startsAt > now ? daysBetween(now, row.startsAt) : null,
    endsInDays:
      row.endsAt && row.endsAt > now && !(row.startsAt && row.startsAt > now)
        ? daysBetween(now, row.endsAt)
        : null,
    ended: Boolean(row.endsAt && row.endsAt <= now),
    duplicateName: options.duplicateNames.has(row.name.trim().toLowerCase()),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

/** Names shared by more than one live rule — allowed, but worth flagging. */
export function duplicateNamesIn(rows: PricingRuleRow[]): Set<string> {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return new Set(
    [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key),
  );
}

/**
 * The day a schedule instant falls on, in the shop's own zone.
 *
 * `toISOString().slice(0, 10)` is the UTC day, so a rule ending at the last
 * instant of 1 July in Sydney round-tripped into the field as **30 June** — and
 * saving it again moved the date the merchant had set.
 */
const forDateInput = (value: Date | null, timeZone: string | null) =>
  value ? localDay(value, timeZone) : "";

export function toFormView(
  row: PricingRuleRow,
  currencyCode: string,
  timeZone: string | null = null,
): RuleFormView {
  return formViewFromRule(toEngineRule(row), {
    id: row.id,
    version: row.version,
    currencyCode,
    timeZone,
  });
}

/**
 * An engine rule → the builder's fields.
 *
 * Shared by the edit page and by ✦ Describe a rule's "Edit" button, which
 * hands a drafted rule to the manual builder pre-filled. One conversion, so a
 * draft and a saved rule cannot render as two different forms.
 */
export function formViewFromRule(
  rule: PricingRule,
  options: {
    id?: string | null;
    version?: number;
    currencyCode: string;
    /** The shop's own zone, so a schedule round-trips to the day it was set to. */
    timeZone?: string | null;
  },
): RuleFormView {
  const { currencyCode } = options;
  const lines = (list: string[] | undefined) => (list ?? []).join("\n");
  const money = (value: { amount: number; currencyCode: string } | undefined) =>
    value ? formatMoney(value) : "";

  return {
    id: options.id ?? null,
    version: options.version ?? 1,
    name: rule.name,
    status: rule.status,
    kind: rule.kind,
    priority: rule.priority,
    combinable: rule.combinable,
    percentage:
      rule.kind === "percentage"
        ? String(rule.value.percentage)
        : rule.kind === "cart_value_tier" && rule.value.tiers[0]?.kind === "percentage"
          ? String(rule.value.tiers[0].percentage)
          : "",
    amount:
      rule.kind === "amount_off" || rule.kind === "fixed_price"
        ? money(rule.value.base)
        : "",
    // Sorted, so the rows do not reorder between two loads of the same rule,
    // and always with one blank row to type into.
    overrides:
      rule.kind === "amount_off" || rule.kind === "fixed_price"
        ? [
            ...Object.entries(rule.value.overrides)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([currencyCode, value]) => ({
                currencyCode,
                amount: money(value),
              })),
            { currencyCode: "", amount: "" },
          ]
        : [{ currencyCode: "", amount: "" }],
    cartMinimum:
      rule.kind === "cart_value_tier" ? money(rule.value.tiers[0]?.minSubtotal) : "",
    tiers:
      rule.kind === "volume_tier"
        ? rule.value.tiers.map((tier) => ({
            minQuantity: String(tier.minQuantity),
            maxQuantity: tier.maxQuantity === null ? "" : String(tier.maxQuantity),
            kind: tier.kind,
            value:
              tier.kind === "percentage"
                ? String(tier.percentage)
                : formatMoney(tier.amount),
          }))
        : [],
    targetMode: rule.targets.mode,
    targetCollectionIds: lines(rule.targets.collectionIds),
    targetProductIds: lines(rule.targets.productIds),
    targetVariantIds: lines(rule.targets.variantIds),
    excludeCollectionIds: lines(rule.targets.excludeCollectionIds),
    audienceMode: rule.audience.mode,
    audienceTags: lines(rule.audience.tags),
    audienceCustomerIds: lines(rule.audience.customerIds),
    audienceCompanyIds: lines(rule.audience.companyIds),
    marketMode: rule.markets.mode,
    marketIds: rule.markets.marketIds.join("\n"),
    startsAt: forDateInput(rule.schedule.startsAt ?? null, options.timeZone ?? null),
    endsAt: forDateInput(rule.schedule.endsAt ?? null, options.timeZone ?? null),
    currencyCode,
  };
}

export function emptyFormView(currencyCode: string): RuleFormView {
  return {
    id: null,
    version: 1,
    name: "",
    status: "draft",
    kind: "percentage",
    priority: 100,
    combinable: false,
    percentage: "",
    amount: "",
    overrides: [{ currencyCode: "", amount: "" }],
    cartMinimum: "",
    tiers: [{ minQuantity: "", maxQuantity: "", kind: "percentage", value: "" }],
    targetMode: "all",
    targetCollectionIds: "",
    targetProductIds: "",
    targetVariantIds: "",
    excludeCollectionIds: "",
    audienceMode: "tags",
    audienceTags: "",
    audienceCustomerIds: "",
    audienceCompanyIds: "",
    marketMode: "all",
    marketIds: "",
    startsAt: "",
    endsAt: "",
    currencyCode,
  };
}

/** A sample product the preview prices, so a rule can be seen working. */
export const SAMPLE_PREVIEW = {
  price: "100.00",
  quantity: 10,
  productId: "sample-product",
  variantId: "sample-variant",
};

/**
 * Price a sample product with the rule being edited.
 *
 * Runs the real engine, so the preview and checkout cannot disagree. A failure
 * returns `unavailable` rather than throwing: a broken preview must never stop
 * a merchant saving their work.
 */
export function previewFor(
  rule: PricingRule,
  currencyCode: string,
  now: Date,
): PreviewView {
  try {
    const price = parseMoney(SAMPLE_PREVIEW.price, currencyCode);
    const context: PricingContext = {
      // A buyer who matches: the preview answers "what does this rule do",
      // not "does this buyer qualify".
      customer: {
        id: "preview-customer",
        tags: rule.audience.tags ?? [],
        groupIds: rule.audience.groupIds ?? [],
        companyId: rule.audience.companyIds?.[0] ?? null,
      },
      product: {
        productId: rule.targets.productIds?.[0] ?? SAMPLE_PREVIEW.productId,
        variantId: rule.targets.variantIds?.[0] ?? SAMPLE_PREVIEW.variantId,
        collectionIds: rule.targets.collectionIds ?? [],
        price,
        cost: null,
      },
      quantity: SAMPLE_PREVIEW.quantity,
      market: { marketId: "preview", countryCode: "", currencyCode },
      cartSubtotal: price,
      now,
    };

    // Previewed as if live, so a draft still shows what it will do.
    const result = resolvePrice({ rules: [{ ...rule, status: "active" }], context });

    return {
      was: formatCurrency(price),
      now: formatCurrency(result.unitPrice),
      changed: result.unitPrice.amount !== price.amount,
      quantity: SAMPLE_PREVIEW.quantity,
      unavailable: false,
      // Shopify's discount API only takes money off a line, so a rule that
      // prices above the shelf price never reaches checkout. Said here rather
      // than discovered on an order.
      aboveShelfPrice: result.unitPrice.amount > price.amount,
    };
  } catch {
    return {
      was: "",
      now: "",
      changed: false,
      quantity: SAMPLE_PREVIEW.quantity,
      unavailable: true,
      aboveShelfPrice: false,
    };
  }
}

/**
 * Everything the engine needs to answer honestly.
 *
 * The old shape was `{ variantId, tags, quantity, price }`, and the missing
 * fields were not cosmetic — the context was built with `groupIds: []`,
 * `companyId: null`, `collectionIds: []`, `productId = variantId` and a
 * `cartSubtotal` of the **unit** price. So the merchant's own audit tool
 * answered wrongly for four of six audience modes, two of four targeting
 * modes, and every cart-value rule at any quantity above one, while the route
 * above it said "this answer is the checkout answer".
 *
 * The caller resolves these from the same places checkout does: the buyer from
 * the mirrored `Customer` row, the product and its collections from the
 * `$app:mannon.collections` metafield the Function reads.
 */
export interface ExplainInput {
  variantId: string;
  productId: string;
  collectionIds: string[];
  tags: string[];
  groupIds: string[];
  companyId: string | null;
  quantity: number;
  price: string;
}

/** "Why this price?" — the engine's own trace, rendered. */
export function explainFor(
  rules: PricingRule[],
  input: ExplainInput,
  currencyCode: string,
  now: Date,
): ExplainView {
  const price = parseMoney(input.price || "0", currencyCode);
  const quantity = Math.max(1, input.quantity);

  const result = resolvePrice({
    rules,
    context: {
      customer: {
        id: "explain",
        tags: input.tags,
        groupIds: input.groupIds,
        companyId: input.companyId,
      },
      product: {
        productId: input.productId || input.variantId,
        variantId: input.variantId,
        collectionIds: input.collectionIds,
        price,
        cost: null,
      },
      quantity,
      market: { marketId: "", countryCode: "", currencyCode },
      // The line, not the unit. Fifty units at $30.00 is a $1,500 line at
      // checkout, and reporting it as a "$30.00 cart" made every cart-value
      // rule above a $30 threshold answer `no_matching_tier` here while
      // checkout applied it.
      cartSubtotal: money(price.amount * quantity, currencyCode),
      now,
    },
  });

  return {
    unitPrice: formatCurrency(result.unitPrice),
    basePrice: formatCurrency(result.basePrice),
    clampedAtZero: result.clampedAtZero,
    trace: result.trace.map((entry) => ({
      ruleId: entry.ruleId,
      ruleName: entry.ruleName,
      applied: entry.applied,
      reason: entry.reason ?? null,
      priceAfter: entry.priceAfter ? formatCurrency(entry.priceAfter) : null,
    })),
  };
}
