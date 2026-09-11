import { money } from "@mannon/pricing-engine";
import type { Translate } from "~/i18n/translate";
import type { Cadence } from "~/lib/customers/cadence.server";
import { formatCurrency } from "~/lib/money";
import type { Customer, CustomerGroup } from "@prisma/client";

import type {
  CustomerRowView,
  GroupBundleSection,
  GroupRowView,
  TagRuleRowView,
} from "~/components/customers/types";
import { AT_RISK_DAYS } from "~/lib/customers/customers.server";
import type { StoredTagRule } from "~/lib/customers/tag-rules.server";
import type { TagCondition } from "~/lib/customers/tagging";

const DAY_MS = 86_400_000;

const daysSince = (from: Date, now: Date) =>
  Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));

/** Company, else the person's name, else the email, else a placeholder. */
export function displayName(
  customer: Pick<Customer, "company" | "firstName" | "lastName" | "email">,
  t: Translate,
): string {
  const person = [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim();
  return customer.company || person || customer.email || t("customers.list.unnamed");
}

export function toCustomerRowView(
  row: Customer & { group?: CustomerGroup | null },
  options: {
    now: Date;
    t: Translate;
    locale?: string;
    /** This buyer's ordering rhythm, when they have enough orders to have one. */
    cadence?: Cadence | null;
  },
): CustomerRowView {
  const { now, t, cadence } = options;
  const group = row.group ?? null;
  const days = row.lastOrderAt ? daysSince(row.lastOrderAt, now) : null;

  return {
    id: row.id,
    name: displayName(row, t),
    email: row.email,
    group: group ? { id: group.id, name: group.name, color: group.color } : null,
    terms:
      group?.netTermsDays != null
        ? t("customers.terms.net", { count: group.netTermsDays })
        : null,
    // Shopify's lifetime total for this buyer, formatted with the engine's
    // money formatter. Not a price this app computed — every price on every
    // surface comes from the pricing engine, and this is not one.
    lifetimeSpend: formatCurrency(
      money(row.lifetimeSpend, row.currencyCode),
      options.locale,
    ),
    orderCount: row.orderCount,
    lastOrderAt: row.lastOrderAt ? row.lastOrderAt.toISOString() : null,
    daysSinceLastOrder: days,
    atRisk: days !== null && days >= AT_RISK_DAYS,
    taxExempt: row.taxExempt,
    status: row.status,
    tags: row.tags,
    deletedInShopify: row.deletedInShopifyAt !== null,
    // Arithmetic, not a model: a buyer who orders every three weeks and last
    // ordered four weeks ago is due. Absent whenever they have too few orders
    // to have a rhythm at all — see `cadence.server.ts`.
    dueToReorder: cadence?.due ?? false,
    reorderReason: cadence?.due
      ? t("customers.list.dueToReorderWhy", {
          every: cadence.everyDays,
          days: cadence.daysSince,
          count: cadence.orders,
        })
      : null,
  };
}

export function toGroupRowView(
  group: CustomerGroup & { memberCount: number },
  options: { t: Translate; pricingRuleCount: number },
): GroupRowView {
  return {
    id: group.id,
    name: group.name,
    handle: group.handle,
    tag: group.tag,
    color: group.color,
    memberCount: group.memberCount,
    terms:
      group.netTermsDays != null
        ? options.t("customers.terms.net", { count: group.netTermsDays })
        : null,
    pricingRuleCount: options.pricingRuleCount,
  };
}

/**
 * The bundle a group carries.
 *
 * Sections whose feature has not shipped carry the phase they arrive in. A
 * merchant who sets an order minimum that nothing enforces finds out from an
 * order that should have been rejected, so an unbuilt section says so.
 */
export function bundleSections(
  group: CustomerGroup,
  options: {
    t: Translate;
    pricingRuleCount: number;
    /** The tier's own order limit, when it has one. */
    orderLimit?: { minSubtotal: number | null; quantityIncrement: number | null } | null;
  },
): GroupBundleSection[] {
  const { t } = options;

  return [
    {
      key: "pricing",
      href: `/app/pricing?search=${encodeURIComponent(group.tag)}`,
      summary:
        options.pricingRuleCount === 0
          ? t("customers.group.summary.noPricing", { tag: group.tag })
          : t("customers.group.summary.pricing", {
              count: options.pricingRuleCount,
              tag: group.tag,
            }),
      comingIn: null,
    },
    {
      key: "limits",
      href: "/app/orders/limits",
      summary:
        options.orderLimit == null
          ? t("customers.group.summary.noLimits")
          : t("customers.group.summary.limits"),
      comingIn: null,
    },
    {
      key: "terms",
      href: "/app/orders/terms",
      summary:
        group.netTermsDays == null
          ? t("customers.group.summary.noTerms")
          : t("customers.group.summary.terms", { count: group.netTermsDays }),
      comingIn: null,
    },
    {
      key: "shipping",
      href: null,
      summary:
        group.freeShippingOver == null
          ? t("customers.group.summary.noShipping")
          : t("customers.group.summary.shipping"),
      comingIn: "3.4",
    },
    {
      key: "visibility",
      href: null,
      summary:
        group.visibleCollectionIds.length === 0
          ? t("customers.group.summary.noVisibility")
          : t("customers.group.summary.visibility", {
              count: group.visibleCollectionIds.length,
            }),
      comingIn: "3.4",
    },
  ];
}

/** One condition, as a sentence a merchant can check. */
export function describeCondition(condition: TagCondition, t: Translate): string {
  switch (condition.field) {
    case "lifetime_spend":
      return t(`customers.tagging.describe.lifetime_spend.${condition.op}`, {
        amount: formatCurrency(condition.amount),
      });
    case "order_count":
      return t(`customers.tagging.describe.order_count.${condition.op}`, {
        count: condition.value,
      });
    case "days_since_last_order":
      return t(`customers.tagging.describe.days_since_last_order.${condition.op}`, {
        count: condition.value,
      });
    case "country":
      return t(`customers.tagging.describe.country.${condition.op}`, {
        countries: condition.values.join(", "),
      });
    case "has_tag":
      return t("customers.tagging.describe.has_tag", { tag: condition.tag });
    case "lacks_tag":
      return t("customers.tagging.describe.lacks_tag", { tag: condition.tag });
    case "form_answer":
      return t(`customers.tagging.describe.form_answer.${condition.op}`, {
        key: condition.key,
        value: condition.value,
      });
  }
}

export function toTagRuleRowView(rule: StoredTagRule, t: Translate): TagRuleRowView {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    priority: rule.priority,
    matchMode: rule.matchMode === "any" ? "any" : "all",
    conditions: rule.parsed,
    conditionSummaries: rule.parsed.map((condition) => describeCondition(condition, t)),
    addTags: rule.addTags,
    removeTags: rule.removeTags,
    lastRunAt: rule.lastRunAt ? rule.lastRunAt.toISOString() : null,
    lastMatchCount: rule.lastMatchCount,
    unreadableCount: rule.unreadable.length,
  };
}
