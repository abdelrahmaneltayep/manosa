import type { MonthlyReview } from "@prisma/client";

import type {
  ReviewDiffView,
  ReviewSectionView,
  ReviewView,
  ReviewsView,
} from "~/components/analytics/types";
import {
  REVIEW_ACTIONS,
  type ReviewAction,
} from "~/lib/ai/prompts/monthly-review.server";
import { money } from "@mannon/pricing-engine";
import { formatCurrency } from "~/lib/money";
import { whenLabel } from "~/lib/agent/home-view.server";

/** Where a recommendation sends the merchant. Our own pages, and only ours. */
const ACTION_HREF: Record<ReviewAction, string> = {
  open_pricing: "/app/pricing",
  open_rule_builder: "/app/pricing/new",
  open_segments: "/app/customers/segments",
  open_applications: "/app/customers/applications",
  open_terms: "/app/orders/terms",
  open_quotes: "/app/orders/quotes",
  open_agent: "/app/storefront-agent",
  open_forms: "/app/forms",
};

const ACTIONS: ReadonlySet<string> = new Set(REVIEW_ACTIONS);

/** "September 2026", in the merchant's own language. */
export function monthLabel(month: string, locale: string): string {
  const [year, index] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(year!, index! - 1, 15)));
}

/**
 * Sections read back out of the column.
 *
 * Checked rather than asserted, like every other JSON this app stores: a row
 * written by a later version with an action this one does not know renders
 * without the link instead of printing a raw catalogue key at the merchant.
 */
export function readSections(value: unknown): ReviewSectionView[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;

    const headline = typeof row.headline === "string" ? row.headline : "";
    const body = typeof row.body === "string" ? row.body : "";
    if (headline === "" || body === "") return [];

    const action =
      typeof row.action === "string" && ACTIONS.has(row.action)
        ? (row.action as ReviewAction)
        : null;

    return [
      {
        kind: typeof row.kind === "string" ? row.kind : "worked",
        headline,
        body,
        action,
        actionHref: action ? ACTION_HREF[action] : null,
        because: Array.isArray(row.because)
          ? row.because.filter((line): line is string => typeof line === "string")
          : [],
      },
    ];
  });
}

/**
 * What moved, as a badge.
 *
 * Signed and formatted here. "Better" is not always "up": fewer buyers is
 * worse, more revenue is better, and a chart that coloured every rise green
 * would be wrong about the one metric where a rise is bad.
 */
export function readDiff(
  value: unknown,
  options: { currencyCode: string; locale: string },
): ReviewDiffView[] | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;

  const signed = (amount: number) =>
    `${amount >= 0 ? "+" : "−"}${formatCurrency(
      money(Math.abs(amount), options.currencyCode),
      options.locale,
    )}`;
  const count = (amount: number) => `${amount >= 0 ? "+" : "−"}${Math.abs(amount)}`;

  const entries: ReviewDiffView[] = [];
  if (typeof row.wholesaleRevenue === "number") {
    entries.push({
      key: "revenue",
      label: signed(row.wholesaleRevenue),
      better: row.wholesaleRevenue >= 0,
    });
  }
  if (typeof row.wholesaleOrders === "number") {
    entries.push({
      key: "orders",
      label: count(row.wholesaleOrders),
      better: row.wholesaleOrders >= 0,
    });
  }
  if (typeof row.buyers === "number") {
    entries.push({ key: "buyers", label: count(row.buyers), better: row.buyers >= 0 });
  }

  return entries.length > 0 ? entries : null;
}

export function reviewView(
  review: MonthlyReview,
  months: MonthlyReview[],
  options: { locale: string; currencyCode: string; now: Date },
): ReviewView {
  return {
    month: review.month,
    monthLabel: monthLabel(review.month, options.locale),
    generatedAt: whenLabel(review.generatedAt, options.now, options.locale),
    quiet: review.quiet,
    sections: readSections(review.sections),
    diff: readDiff(review.diff, options),
    months: months.map((row) => ({
      month: row.month,
      label: monthLabel(row.month, options.locale),
      current: row.month === review.month,
    })),
  };
}

export function reviewsView(options: {
  latest: ReviewView | null;
  available: boolean;
  locked: "plan" | "no_key" | null;
  requiredPlan: string | null;
  scheduled: boolean;
}): ReviewsView {
  return { ...options };
}
