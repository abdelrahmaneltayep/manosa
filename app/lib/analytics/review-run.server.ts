import { Prisma, type MonthlyReview } from "@prisma/client";

import { db } from "~/db.server";
import { isAiAvailable } from "~/lib/ai/client.server";
import { writeMonthlyReview } from "~/lib/ai/prompts/monthly-review.server";
import type { AiDeps } from "~/lib/ai/run.server";
import {
  PREVIOUS_PREFIX,
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

  // "There is no month before this one" and "the month before was quiet" are
  // different things, and the page said the first about both — while the month
  // switcher directly above it listed the earlier months.
  const firstMonth =
    month <= monthOf(record?.installedAt ?? now, record?.ianaTimezone ?? null);

  // A month in which nothing happened at all is not a month to write about,
  // and saying so costs no model call.
  if (facts.wholesaleOrders === 0 && facts.applications === 0 && !hasPrevious) {
    return { review: null, skipped: "nothing_to_review", failure: null };
  }

  const { facts: lines, slots } = factLines(facts, locale);
  // Last month's figures get their own slot namespace, and its slots are
  // handed over with this month's. Without that the model was shown the same
  // template strings twice and could only invent the comparison.
  const previous = hasPrevious
    ? factLines(previousFacts, locale, PREVIOUS_PREFIX)
    : { facts: [], slots: {} };
  const previousLines = previous.facts;
  const allSlots = { ...slots, ...previous.slots };

  const written = await writeMonthlyReview(
    {
      month,
      locale,
      facts: lines,
      previous: previousLines,
      slots: allSlots,
      actorId: null,
    },
    deps,
  );

  if (!written.ok) {
    // Recorded, so the page can say the month was attempted and failed rather
    // than promising a review that is never coming.
    await db.shop.update({
      where: { shop },
      data: {
        reviewFailedMonth: month,
        reviewFailedAt: now,
        reviewFailedReason: written.reason,
      },
    });
    return { review: null, skipped: null, failure: written.reason };
  }

  const stored = await createOnce({
    ...tenant(),
    month,
    quiet: written.value.quiet,
    sections: written.value.sections,
    // The figures the sections were written from, stored beside them — the
    // "why" expander reads these rather than asking the model to remember.
    facts: {
      lines,
      slots: allSlots,
      previous: previousLines,
      // Stored beside the figures so a shop that changes currency later does
      // not re-label every past review with a symbol it was never in.
      currencyCode: facts.currencyCode,
      noDiffBecause: hasPrevious ? null : firstMonth ? "first" : "previousQuiet",
    },
    diff: diffOf(facts, hasPrevious ? previousFacts : null) ?? undefined,
    generatedAt: now,
    aiModel: written.model,
    aiPromptVersion: written.promptVersion,
    aiRequestId: written.requestId,
  });

  // Lost the race with a concurrent run: the other one's words stand, because
  // a review is written once.
  if (stored === null) {
    const existing = await db.monthlyReview.findFirst({ where: { month } });
    return { review: existing, skipped: "exists", failure: null };
  }

  // A month that succeeds clears the marker, the same way the briefing does.
  if (record?.reviewFailedMonth) {
    await db.shop.update({
      where: { shop },
      data: { reviewFailedMonth: null, reviewFailedAt: null, reviewFailedReason: null },
    });
  }

  return { review: stored, skipped: null, failure: null };
}

/**
 * The write, with the unique index doing the deciding.
 *
 * `findFirst` then `create` is check-then-act with a model round-trip in
 * between, so two runs of the same month both passed the check. The
 * `@@unique([shop, month])` index is what actually protects the data — but the
 * loser threw P2002 out of the job handler, which the runner recorded as a
 * failed attempt and retried, for work that had in fact succeeded.
 */
async function createOnce(
  data: Parameters<typeof db.monthlyReview.create>[0]["data"],
): Promise<MonthlyReview | null> {
  try {
    return await db.monthlyReview.create({ data });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return null;
    }
    throw error;
  }
}

/** One page of months, newest first, and whether there are older ones. */
export interface ReviewPageResult {
  rows: MonthlyReview[];
  /** The month to pass as `before` for the next page. Null at the end. */
  nextBefore: string | null;
  /** The month to pass as `after` for the newer page. Null at the newest. */
  previousAfter: string | null;
}

export const REVIEWS_PER_PAGE = 24;

/**
 * Newest first, a page at a time.
 *
 * This was `take: 24` with a comment claiming it paginated. It did not, and
 * the month switcher is built from exactly this list — so on a shop two years
 * in, month 25 and everything older had no route in the product at all, while
 * the page promised reviews are kept forever. Keyset on `month`, which is a
 * sortable `YYYY-MM` and unique per shop.
 */
export async function listReviews(
  options: { before?: string | null; after?: string | null; limit?: number } = {},
): Promise<ReviewPageResult> {
  shopScope.require("list monthly reviews");
  const limit = options.limit ?? REVIEWS_PER_PAGE;

  // `after` walks back towards the newest, so it reads ascending and is
  // reversed before it is handed out.
  const ascending = Boolean(options.after);
  const where = options.before
    ? { month: { lt: options.before } }
    : options.after
      ? { month: { gt: options.after } }
      : {};

  const rows = await db.monthlyReview.findMany({
    where,
    orderBy: { month: ascending ? "asc" : "desc" },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ordered = ascending ? [...page].reverse() : page;

  const oldest = ordered.at(-1)?.month ?? null;
  const newest = ordered[0]?.month ?? null;

  const [olderExists, newerExists] = await Promise.all([
    oldest === null
      ? Promise.resolve(0)
      : db.monthlyReview.count({ where: { month: { lt: oldest } } }),
    newest === null
      ? Promise.resolve(0)
      : db.monthlyReview.count({ where: { month: { gt: newest } } }),
  ]);

  return {
    rows: ordered,
    nextBefore: olderExists > 0 ? oldest : null,
    previousAfter: newerExists > 0 ? newest : null,
  };
}

export async function readReviewFor(month: string): Promise<MonthlyReview | null> {
  shopScope.require("read monthly review");
  return db.monthlyReview.findFirst({ where: { month } });
}
