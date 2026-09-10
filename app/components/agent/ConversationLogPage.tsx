import { useTranslation } from "react-i18next";

import { AgentTabs } from "~/components/agent/AgentTabs";
import type { LogRowView, LogView } from "~/components/agent/types";

/**
 * Every conversation the agent had, and what came of it.
 *
 * The screen that makes publishing this defensible: an agent that talks to a
 * merchant's customers, in the merchant's name, and cannot be read afterwards
 * is one nobody should switch on.
 */
export function ConversationLogPage({ view }: { view: LogView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("agent.log.heading")}>
      <s-section>
        <AgentTabs current="log" />
      </s-section>

      {view.entitled ? null : (
        <s-section>
          <s-banner tone="info">
            <s-heading>{t("agent.locked.heading")}</s-heading>
            <s-paragraph>
              {t("agent.locked.body", { plan: view.requiredPlan })}
            </s-paragraph>
            <s-button href="/app/plans">{t("agent.locked.action")}</s-button>
          </s-banner>
        </s-section>
      )}

      {view.neverAny ? (
        <EmptyState view={view} />
      ) : (
        <s-section>
          <s-stack direction="block" gap="base">
            <Toolbar view={view} />
            {view.rows.length === 0 ? <NoResults /> : <LogTable view={view} />}
            <Pagination view={view} />
            <s-text color="subdued">
              {t("agent.log.retention", { days: view.retentionDays })}
            </s-text>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function EmptyState({ view }: { view: LogView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{t("agent.log.emptyHeading")}</s-heading>
        <s-paragraph color="subdued">
          {t(view.published ? "agent.log.emptyPublished" : "agent.log.emptyBody")}
        </s-paragraph>
        {view.published ? null : (
          <s-link href="/app/storefront-agent">{t("agent.log.emptyAction")}</s-link>
        )}
      </s-stack>
    </s-section>
  );
}

function NoResults() {
  const { t } = useTranslation();

  return (
    <s-stack direction="block" gap="small">
      <s-heading>{t("agent.log.noResultsHeading")}</s-heading>
      <s-paragraph color="subdued">{t("agent.log.noResultsBody")}</s-paragraph>
      <s-link href="?">{t("agent.log.clearFilters")}</s-link>
    </s-stack>
  );
}

function Toolbar({ view }: { view: LogView }) {
  const { t } = useTranslation();

  return (
    <s-stack direction="block" gap="small">
      <form method="get">
        <s-stack direction="inline" gap="small" alignItems="end">
          <s-search-field
            name="search"
            label={t("agent.log.searchLabel")}
            value={view.filters.search}
          />
          <s-select
            name="outcome"
            label={t("agent.log.filterOutcome")}
            value={view.filters.outcome}
          >
            <s-option value="">{t("agent.log.filterAny")}</s-option>
            {view.outcomes.map((outcome) => (
              <s-option key={outcome} value={outcome}>
                {t(`agent.outcome.${outcome}`)}
              </s-option>
            ))}
          </s-select>
          <s-button type="submit">{t("agent.log.filter")}</s-button>
        </s-stack>
      </form>

      <s-link href="/app/storefront-agent/log/export">{t("agent.log.export")}</s-link>
    </s-stack>
  );
}

function LogTable({ view }: { view: LogView }) {
  const { t } = useTranslation();

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>{t("agent.log.colBuyer")}</s-table-header>
        <s-table-header>{t("agent.log.colWhen")}</s-table-header>
        <s-table-header>{t("agent.log.colOutcome")}</s-table-header>
        <s-table-header>{t("agent.log.colTurns")}</s-table-header>
        <s-table-header>{t("agent.log.colOpen")}</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {view.rows.map((row) => (
          <Row key={row.id} row={row} />
        ))}
      </s-table-body>
    </s-table>
  );
}

type Tone = "success" | "info" | "warning" | "critical" | "neutral";

const TONE: Record<string, Tone> = {
  CART: "success",
  QUOTE: "success",
  ANSWERED: "info",
  ESCALATED: "warning",
  DECLINED: "neutral",
  FAILED: "critical",
};

function Row({ row }: { row: LogRowView }) {
  const { t } = useTranslation();

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-text>{row.buyer}</s-text>
          {/* A rehearsal is labelled wherever it appears. A merchant reading
              their own test as a buyer's conversation is exactly the kind of
              thing this log exists to prevent. */}
          {row.testMode ? <s-badge tone="info">{t("agent.log.testChip")}</s-badge> : null}
          {row.takenOver ? <s-badge>{t("agent.log.takenOverChip")}</s-badge> : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>{row.when}</s-table-cell>
      <s-table-cell>
        <s-badge tone={TONE[row.outcome] ?? "neutral"}>
          {t(`agent.outcome.${row.outcome}`)}
        </s-badge>
      </s-table-cell>
      <s-table-cell>{t("agent.log.turns", { count: row.turns })}</s-table-cell>
      <s-table-cell>
        <s-link href={`/app/storefront-agent/log/${row.id}`}>
          {t("agent.log.open")}
        </s-link>
      </s-table-cell>
    </s-table-row>
  );
}

function Pagination({ view }: { view: LogView }) {
  const { t } = useTranslation();
  if (view.pageCount <= 1) return null;

  const query = (page: number) => {
    const params = new URLSearchParams();
    if (view.filters.search) params.set("search", view.filters.search);
    if (view.filters.outcome) params.set("outcome", view.filters.outcome);
    params.set("page", String(page));
    return `?${params.toString()}`;
  };

  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      {view.page > 1 ? (
        <s-link href={query(view.page - 1)}>{t("agent.log.previous")}</s-link>
      ) : null}
      <s-text color="subdued">
        {t("agent.log.pageOf", { page: view.page, pageCount: view.pageCount })}
      </s-text>
      {view.page < view.pageCount ? (
        <s-link href={query(view.page + 1)}>{t("agent.log.next")}</s-link>
      ) : null}
    </s-stack>
  );
}
