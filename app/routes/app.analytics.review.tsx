import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { ReviewPage } from "~/components/analytics/ReviewPage";
import type { ReviewsView } from "~/components/analytics/types";
import { db } from "~/db.server";
import { detectLocale } from "~/i18n.server";
import { isAiAvailable } from "~/lib/ai/client.server";
import { listReviews, readReviewFor } from "~/lib/analytics/review-run.server";
import { reviewsView, reviewView } from "~/lib/analytics/review-view.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { lowestPlanWithFeature } from "~/lib/billing/plans";
import { ensureMonthlyReviewScheduled } from "~/lib/jobs/handlers/monthly-review.server";
import { withAdmin } from "~/shopify.server";

/**
 * ✦ The monthly review, and every one before it.
 *
 * Read-only. Reviews are written by a job on the first of the month and never
 * rewritten, so there is nothing to press here — which is the point: a merchant
 * comparing March with February needs March to say the same thing both times.
 */
export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    const url = new URL(request.url);
    const locale = detectLocale(request);
    const now = new Date();

    const [months, entitlements, shop] = await Promise.all([
      listReviews(),
      loadEntitlements(now),
      db.shop.findUnique({ where: { shop: session.shop } }),
    ]);

    const entitled = hasFeature(entitlements, "merchant_agent");
    const key = isAiAvailable();

    // Queued here as well as from the charts page, so a merchant who lands
    // straight on this URL still starts getting reviews.
    if (entitled) await ensureMonthlyReviewScheduled(now);

    const asked = (url.searchParams.get("month") ?? "").trim();
    // Resolved against this shop's own reviews rather than trusted: a month in
    // a query string is not proof that a review for it exists.
    const chosen = asked ? await readReviewFor(asked) : (months[0] ?? null);

    return json({
      view: reviewsView({
        latest: chosen
          ? reviewView(chosen, months, {
              locale,
              currencyCode: shop?.currencyCode ?? "USD",
              now,
            })
          : null,
        available: entitled && key,
        locked: !entitled ? "plan" : key ? null : "no_key",
        requiredPlan: entitled ? null : lowestPlanWithFeature("merchant_agent"),
        scheduled: entitled && key,
      }),
    });
  });

export default function MonthlyReview() {
  const { view } = useLoaderData<typeof loader>();
  return <ReviewPage view={view as ReviewsView} />;
}
