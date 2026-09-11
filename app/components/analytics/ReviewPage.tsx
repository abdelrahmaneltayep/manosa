import { useTranslation } from "react-i18next";

import type { ReviewsView, ReviewView } from "~/components/analytics/types";

/**
 * ✦ The monthly review.
 *
 * Two things make it worth reading rather than skimming: it says what moved
 * since last month, and every recommendation can be checked. The "why"
 * expander shows the figures the sentence was written from — so a merchant who
 * disagrees with the advice can disagree with the data instead of with the
 * model.
 *
 * Nothing on this page performs anything. An action is a link to the page the
 * merchant does it on, with that page's own confirmations.
 */
export function ReviewPage({ view }: { view: ReviewsView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("review.heading")}>
      <s-section>
        <s-stack direction="block" gap="base">
          <s-link href="/app/analytics">{t("review.backToCharts")}</s-link>
          <s-paragraph>{t("review.body")}</s-paragraph>
        </s-stack>
      </s-section>

      {view.locked ? (
        <s-section>
          <s-banner tone="info">
            <s-heading>{t("review.offHeading")}</s-heading>
            <s-paragraph>
              {view.locked === "plan"
                ? t("review.lockedPlan", { plan: view.requiredPlan })
                : t("review.lockedNoKey")}
            </s-paragraph>
            {view.locked === "plan" ? (
              <s-button href="/app/plans">{t("plans.seePlans")}</s-button>
            ) : null}
          </s-banner>
        </s-section>
      ) : null}

      {view.latest ? <Review review={view.latest} /> : <Nothing view={view} />}
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function Nothing({ view }: { view: ReviewsView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{t("review.emptyHeading")}</s-heading>
        {/* "Nothing yet" and "nothing ever" are different, and the second is
            the one that needs an explanation. */}
        <s-paragraph color="subdued">
          {t(view.scheduled ? "review.emptyScheduled" : "review.emptyBody")}
        </s-paragraph>
        {/* A month that was attempted and failed is not a month still coming.
            Promising one that had already been given up on is the screen
            claiming something that did not happen. */}
        {view.failedMonth ? (
          <s-banner tone="warning">
            <s-paragraph>{t("review.failed", { month: view.failedMonth })}</s-paragraph>
          </s-banner>
        ) : null}
      </s-stack>
    </s-section>
  );
}

function Review({ review }: { review: ReviewView }) {
  const { t } = useTranslation();

  return (
    <>
      {review.months.length > 1 ? (
        <s-section>
          <s-stack direction="inline" gap="small" alignItems="center">
            {review.months.map((month) => (
              <s-link
                key={month.month}
                href={`/app/analytics/review?month=${month.month}`}
                {...(month.current ? { "aria-current": "page" } : {})}
              >
                {month.label}
              </s-link>
            ))}
            {/* Kept forever means reachable forever. This list was capped at
                24 with no way back, so month 25 had no route in the product. */}
            {review.newerHref ? (
              <s-link href={review.newerHref}>{t("review.newerMonths")}</s-link>
            ) : null}
            {review.olderHref ? (
              <s-link href={review.olderHref}>{t("review.olderMonths")}</s-link>
            ) : null}
          </s-stack>
        </s-section>
      ) : null}

      <s-section heading={review.monthLabel}>
        <s-stack direction="block" gap="base">
          {review.diff ? (
            <s-stack direction="inline" gap="base" alignItems="center">
              {review.diff.map((entry) => (
                <s-badge key={entry.key} tone={entry.better ? "success" : "neutral"}>
                  {t(`review.diff.${entry.key}`, { change: entry.label })}
                </s-badge>
              ))}
            </s-stack>
          ) : (
            // Two different things: no earlier month at all, and an earlier
            // month that was quiet. Saying "your first review" about the second
            // contradicted the month switcher directly above it.
            <s-text color="subdued">
              {t(
                review.noDiffBecause === "previousQuiet"
                  ? "review.previousQuiet"
                  : "review.firstMonth",
              )}
            </s-text>
          )}

          {review.quiet ? (
            // The chips above are computed independently of the model's "quiet"
            // judgement, so "Revenue +$2,400" sat directly over "nothing
            // happened". The figures are the honest half; the copy softens.
            <s-paragraph color="subdued">{t("review.quietNothingNeeded")}</s-paragraph>
          ) : (
            review.sections.map((section, index) => (
              <s-box key={index} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-badge>{t(`review.kind.${section.kind}`)}</s-badge>
                    <s-heading>{section.headline}</s-heading>
                  </s-stack>
                  <s-paragraph>{section.body}</s-paragraph>

                  {section.action && section.actionHref ? (
                    <s-link href={section.actionHref}>
                      {t(`review.action.${section.action}`)}
                    </s-link>
                  ) : null}

                  {/* The data behind the sentence. A recommendation a merchant
                      cannot audit is one they cannot act on. */}
                  {section.because.length > 0 ? (
                    <details>
                      <summary>{t("review.why")}</summary>
                      <s-unordered-list>
                        {section.because.map((line, at) => (
                          <s-list-item key={at}>{line}</s-list-item>
                        ))}
                      </s-unordered-list>
                    </details>
                  ) : null}
                </s-stack>
              </s-box>
            ))
          )}

          <s-text color="subdued">
            {t("review.generated", { when: review.generatedAt })}
          </s-text>
        </s-stack>
      </s-section>
    </>
  );
}
