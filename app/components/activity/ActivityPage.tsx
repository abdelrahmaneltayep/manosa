import { useTranslation } from "react-i18next";

import type { ActivityLogView } from "~/components/activity/types";

/**
 * The whole log, filtered.
 *
 * Home shows eight rows; this is where "View all" goes. Paginated on time
 * rather than on a page number, because the feed is a union of the audit log
 * and mirrored orders and an offset into a merge is not a position in either.
 */
export function ActivityPage({ view }: { view: ActivityLogView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("activity.heading")}>
      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small" alignItems="center">
            {view.filters.map((filter) => (
              <s-link key={filter} href={`/app/activity?filter=${filter}`}>
                {filter === view.filter
                  ? t(`activity.filter.${filter}Current`)
                  : t(`activity.filter.${filter}`)}
              </s-link>
            ))}
          </s-stack>

          {view.rows.length === 0 ? (
            <s-paragraph>
              {t(view.filter === "all" ? "activity.empty" : "activity.emptyFiltered")}
            </s-paragraph>
          ) : (
            <s-stack direction="block" gap="small">
              {view.rows.map((row) => (
                <s-box
                  key={row.id}
                  padding="small"
                  borderWidth="base"
                  borderStyle="solid"
                  borderColor="base"
                  borderRadius="base"
                >
                  <s-stack direction="inline" gap="small" alignItems="center">
                    {row.agent ? <s-badge tone="info">✦</s-badge> : null}
                    <s-text color="subdued">{row.kindLabel}</s-text>
                    {row.href ? (
                      <s-link href={row.href}>{row.summary}</s-link>
                    ) : (
                      <s-text>{row.summary}</s-text>
                    )}
                    <s-text color="subdued">{row.when}</s-text>
                    {row.actorLabel ? (
                      <s-text color="subdued">{row.actorLabel}</s-text>
                    ) : null}
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}

          {/* One direction only: a time cursor knows what comes next, not what
              came before. "Back" is the browser's, and it works. */}
          {view.nextHref ? (
            <s-button href={view.nextHref}>{t("activity.more")}</s-button>
          ) : null}
        </s-stack>
      </s-section>
    </s-page>
  );
}
