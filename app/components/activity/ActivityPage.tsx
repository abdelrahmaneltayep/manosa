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
              <s-link key={filter} href={view.filterHrefs[filter] ?? "/app/activity"}>
                {filter === view.filter
                  ? t(`activity.filter.${filter}Current`)
                  : t(`activity.filter.${filter}`)}
              </s-link>
            ))}
          </s-stack>

          {/* Actor, action and date — §8's three, as a GET form so a filtered
              log is a URL a merchant can keep or send to somebody. */}
          <form method="get">
            <input type="hidden" name="filter" value={view.filter} />
            <s-stack direction="inline" gap="small" alignItems="end">
              <s-select name="actor" label={t("activity.actorLabel")} value={view.actor}>
                {view.actors.map((actor) => (
                  <s-option key={actor} value={actor}>
                    {t(`activity.actor.${actor}`)}
                  </s-option>
                ))}
              </s-select>
              <s-select
                name="action"
                label={t("activity.actionLabel")}
                value={view.action}
              >
                <s-option value="">{t("activity.actionAny")}</s-option>
                {view.actions.map((action) => (
                  <s-option key={action.value} value={action.value}>
                    {action.label}
                  </s-option>
                ))}
              </s-select>
              <s-date-field
                name="from"
                label={t("activity.fromLabel")}
                value={view.from}
              />
              <s-date-field name="to" label={t("activity.toLabel")} value={view.to} />
              <s-button type="submit">{t("activity.apply")}</s-button>
              {view.filtered ? (
                <s-link href={`/app/activity?filter=${view.filter}`}>
                  {t("activity.clear")}
                </s-link>
              ) : null}
            </s-stack>
          </form>

          {view.rows.length === 0 ? (
            <s-paragraph>
              {t(
                view.filtered || view.filter !== "all"
                  ? "activity.emptyFiltered"
                  : "activity.empty",
              )}
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

          {/* Stated, not discovered. A merchant answering "who changed this
              price" needs to know how far back they can still ask. */}
          <s-text color="subdued">
            {t("activity.retention", {
              count: view.retentionMonths,
              from: view.keptFrom,
            })}
          </s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}
