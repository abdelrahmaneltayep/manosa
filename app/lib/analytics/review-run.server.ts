import type { MonthlyReview } from "@prisma/client";

import { db } from "~/db.server";
import { isAiAvailable } from "~/lib/ai/client.server";
import { writeMonthlyReview } from "~/lib/ai/prompts/monthly-review.server";
import type { AiDeps } from "~/lib/ai/run.server";
import {
  diffOf,
  factLines,
  monthFacts,
  monthOf,
  previousMonth,
} from "~/lib/analytics/review.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";

/**
 * Writing one month's review, and keeping it.
 *
 * Generated on the 1st for the month just gone, kept forever, and never
 * rewritten: a merchant who read March's review in April and again in
 * September must read the same words. A re-run finds the row and returns it.
 */

export type ReviewSkip = "no_key" | "no_plan" | "exists" | "nothing_to_review";

export interface ReviewRun {
  review: MonthlyReview | null;
  skipped: ReviewSkip | null;
  failure: string | null;
}

/** The month a review generated *now* should cover: the one just finished. */
export async function monthToReview(now = new Date()): Promise<string> {
  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("month to review") },
  });
  return previousMonth(monthOf(now, shop?.ianaTimezone ?? null));
}

export async function generateMonthlyReview(
  options: { month?: string; locale?: string; now?: Date } = {},
  deps: AiDeps = {},
): Promise<ReviewRun> {
  const shop = shopScope.require("generate monthly review");
  const now = options.now ?? new Date();
  const month = options.month ?? (await monthToReview(now));

  // Kept forever means written once. A second run in the same month must not
  // hand the merchant different words for the same figures.
  const existing = await db.monthlyReview.findFirst({ where: { month } });
  if (existing) return { review: existing, skipped: "exists", failure: null };

  const entitlements = await loadEntitlements(now);
  if (!hasFeature(entitlements, "merchant_agent")) {
    return { review: null, skipped: "no_plan", failure: null };
  }
  // The product works with the key unset: the page says the review is off
  // rather than showing an empty card, and the figures are still on the
  // analytics page either way.
  if (!isAiAvailable() && !deps.messages) {
    return { review: null, skipped: "no_key", failure: null };
  }

  const record = await db.shop.findUnique({ where: { shop } });
  const locale = options.locale ?? record?.primaryLocale ?? "en";

  const facts = await monthFacts(month, now);
  const previousFacts = await monthFacts(previousMonth(month), now);
  const hasPrevious = previousFacts.wholesaleOrders > 0 || previousFacts.applications > 0;

  // A month in which nothing happened at all is not a month to write about,
  // and saying so costs no model call.
  if (facts.wholesaleOrders === 0 && facts.applications === 0 && !hasPrevious) {
    return { review: null, skipped: "nothing_to_review", failure: null };
  }

  const { facts: lines, slots } = factLines(facts, locale);
  const previousLines = hasPrevious ? factLines(previousFacts, locale).facts : [];

  const written = await writeMonthlyReview(
    { month, locale, facts: lines, previous: previousLines, slots, actorId: null },
    deps,
  );

  if (!written.ok) return { review: null, skipped: null, failure: written.reason };

  const review = await db.monthlyReview.create({
    data: {
      ...tenant(),
      month,
      quiet: written.value.quiet,
      sections: written.value.sections,
      // The figures the sections were written from, stored beside them — the
      // "why" expander reads these rather than asking the model to remember.
      facts: { lines, slots, previous: previousLines },
      diff: diffOf(facts, hasPrevious ? previousFacts : null) ?? undefined,
      generatedAt: now,
      aiModel: written.model,
      aiPromptVersion: written.promptVersion,
      aiRequestId: written.requestId,
    },
  });

  return { review, skipped: null, failure: null };
}

/** Newest first. Kept forever, so this paginates. */
export async function listReviews(limit = 24): Promise<MonthlyReview[]> {
  shopScope.require("list monthly reviews");
  return db.monthlyReview.findMany({ orderBy: { month: "desc" }, take: limit });
}

export async function readReviewFor(month: string): Promise<MonthlyReview | null> {
  shopScope.require("read monthly review");
  return db.monthlyReview.findFirst({ where: { month } });
}
