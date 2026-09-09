import { useTranslation } from "react-i18next";

import type { RuleListView, RuleRowView } from "~/components/pricing/types";

/**
 * React stringifies props on custom elements, so `disabled={false}` renders
 * `disabled="false"` — which a browser reads as disabled. Boolean attributes on
 * `s-*` elements have to be omitted rather than set false.
 */
const whenDisabled = (value: boolean) => (value ? { disabled: true } : {});

/** Below this, a filter bar is more chrome than help. */
const FILTER_BAR_FROM = 3;

export function RuleListPage({ view }: { view: RuleListView }) {
  const { t } = useTranslation();
  const hasAny = view.totalUnfiltered > 0;

  return (
    <s-page heading={t("pricing.list.heading")}>
      <Banners view={view} />

      {!hasAny ? (
        <EmptyState view={view} />
      ) : (
        <s-section>
          <s-stack direction="block" gap="base">
            <Toolbar view={view} />
            {view.rows.length === 0 ? (
              <NoResults view={view} />
            ) : (
              <RuleTable view={view} />
            )}
            <Pagination view={view} />
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function Banners({ view }: { view: RuleListView }) {
  const { t } = useTranslation();
  const banners: React.ReactNode[] = [];

  if (view.cachedMinutesAgo !== null) {
    banners.push(
      <s-banner key="cached" tone="warning">
        <s-heading>{t("pricing.list.cachedHeading")}</s-heading>
        <s-paragraph>
          {t("pricing.list.cachedBody", { minutes: view.cachedMinutesAgo })}
        </s-paragraph>
        <s-button href="?">{t("pricing.list.retry")}</s-button>
      </s-banner>,
    );
  }

  if (view.publishError) {
    const key = view.publishError === "too_large" ? "tooLarge" : "failed";
    banners.push(
      <s-banner key="publish" tone="critical">
        <s-heading>{t(`pricing.publish.${key}Heading`)}</s-heading>
        <s-paragraph>{t(`pricing.publish.${key}Body`)}</s-paragraph>
      </s-banner>,
    );
  }

  if (view.unreadableCount > 0) {
    banners.push(
      <s-banner key="unreadable" tone="critical">
        <s-heading>
          {t("pricing.list.unreadableHeading", { count: view.unreadableCount })}
        </s-heading>
        <s-paragraph>{t("pricing.list.unreadableBody")}</s-paragraph>
      </s-banner>,
    );
  }

  if (banners.length === 0) return null;
  return <s-section>{banners}</s-section>;
}

function EmptyState({ view }: { view: RuleListView }) {
  const { t } = useTranslation();

  if (view.archived) {
    return (
      <s-section>
        <s-stack direction="block" gap="small">
          <s-heading>{t("pricing.list.emptyArchivedHeading")}</s-heading>
          <s-paragraph color="subdued">
            {t("pricing.list.emptyArchivedBody", { count: 30 })}
          </s-paragraph>
          <s-link href="?">{t("pricing.list.tabActive")}</s-link>
        </s-stack>
      </s-section>
    );
  }

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{t("pricing.list.emptyHeading")}</s-heading>
        <s-paragraph color="subdued">{t("pricing.list.emptyBody")}</s-paragraph>
        <s-stack direction="inline" gap="small">
          {/* Claude drafts rules in phase 4.2. Until then the control is
              present but honest about not being ready, rather than absent —
              the merchant should know it is coming. */}
          <s-button
            variant="primary"
            disabled={!view.aiAvailable}
            href="/app/pricing/new?ai=1"
          >
            {t("pricing.list.emptyDescribe")}
          </s-button>
          <s-button href="/app/pricing/new">{t("pricing.list.emptyManual")}</s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function NoResults({ view }: { view: RuleListView }) {
  const { t } = useTranslation();
  return (
    <s-stack direction="block" gap="small">
      <s-heading>
        {t("pricing.list.emptySearchHeading", { query: view.search })}
      </s-heading>
      <s-paragraph color="subdued">{t("pricing.list.emptySearchBody")}</s-paragraph>
      <s-link href={view.archived ? "?archived=1" : "?"}>
        {t("pricing.list.clearSearch")}
      </s-link>
    </s-stack>
  );
}

function Toolbar({ view }: { view: RuleListView }) {
  const { t } = useTranslation();
  // Two rules do not need filtering; the controls would outnumber the data.
  const showFilters = view.totalUnfiltered >= FILTER_BAR_FROM;

  return (
    <s-stack direction="block" gap="small">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-link href="?" {...(!view.archived ? { "aria-current": "page" } : {})}>
          {t("pricing.list.tabActive")}
        </s-link>
        <s-link href="?archived=1" {...(view.archived ? { "aria-current": "page" } : {})}>
          {t("pricing.list.tabArchived")}
        </s-link>
        <s-link href="/app/pricing/csv">{t("pricing.list.csvLink")}</s-link>
        <s-button
          variant="primary"
          href="/app/pricing/new"
          {...whenDisabled(view.atRuleLimit)}
        >
          {t("pricing.list.create")}
        </s-button>
      </s-stack>

      {showFilters ? (
        <form method="get">
          {view.archived ? <input type="hidden" name="archived" value="1" /> : null}
          <s-search-field
            name="search"
            label={t("pricing.list.searchLabel")}
            value={view.search}
          />
        </form>
      ) : null}

      {view.published ? (
        <s-text color="subdued">
          {view.published.ruleCount === 0
            ? t("pricing.publish.neverPublished")
            : t("pricing.publish.liveHeading", { count: view.published.ruleCount })}
        </s-text>
      ) : null}
    </s-stack>
  );
}

function RuleTable({ view }: { view: RuleListView }) {
  const { t } = useTranslation();
  const sortHref = (key: string) =>
    `?${new URLSearchParams({
      ...(view.archived ? { archived: "1" } : {}),
      ...(view.search ? { search: view.search } : {}),
      sort: key,
    }).toString()}`;

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>
          <s-link href={sortHref("name")}>{t("pricing.list.colName")}</s-link>
        </s-table-header>
        <s-table-header>{t("pricing.list.colType")}</s-table-header>
        <s-table-header>{t("pricing.list.colTargets")}</s-table-header>
        <s-table-header>{t("pricing.list.colAudience")}</s-table-header>
        <s-table-header>
          <s-link href={sortHref("usage")}>{t("pricing.list.colUsage")}</s-link>
        </s-table-header>
        <s-table-header>{t("pricing.list.colStatus")}</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {view.rows.map((row) => (
          <RuleRow key={row.id} row={row} archived={view.archived} />
        ))}
      </s-table-body>
    </s-table>
  );
}

function RuleRow({ row, archived }: { row: RuleRowView; archived: boolean }) {
  const { t } = useTranslation();

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-link href={`/app/pricing/${row.id}`}>{row.name}</s-link>
          {row.duplicateName ? (
            <s-text tone="caution">
              {t("pricing.list.duplicateNameWarning", { name: row.name })}
            </s-text>
          ) : null}
          {row.missingTargetCount > 0 ? (
            <s-badge tone="warning">
              {t("pricing.list.missingTargets", { count: row.missingTargetCount })}
            </s-badge>
          ) : null}
          {row.startsInDays !== null ? (
            <s-badge tone="info">
              {t("pricing.list.startsIn", { count: row.startsInDays })}
            </s-badge>
          ) : null}
          {row.endsInDays !== null ? (
            <s-badge tone="info">
              {t("pricing.list.endsIn", { count: row.endsInDays })}
            </s-badge>
          ) : null}
          {row.ended ? <s-badge tone="neutral">{t("pricing.list.ended")}</s-badge> : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>{t(`pricing.kind.${row.kind}`)}</s-table-cell>
      <s-table-cell>{row.targetsSummary}</s-table-cell>
      <s-table-cell>{row.audienceSummary}</s-table-cell>
      <s-table-cell>
        {row.usage30d === null ? (
          // Never measured is not zero. Flagging a brand-new rule as unused
          // would be telling the merchant something untrue.
          <>
            <s-text color="subdued" accessibilityVisibility="hidden">
              {t("pricing.list.usageUnmeasured")}
            </s-text>
            {/* An em dash says nothing to a screen reader. */}
            <s-text accessibilityVisibility="exclusive">
              {t("pricing.list.usageUnmeasuredHint")}
            </s-text>
          </>
        ) : (
          <s-stack direction="inline" gap="small-500" alignItems="center">
            <s-text fontVariantNumeric="tabular-nums">{row.usage30d}</s-text>
            {row.unused ? (
              <s-badge tone="caution">{t("pricing.list.unusedBadge")}</s-badge>
            ) : null}
          </s-stack>
        )}
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small-500" alignItems="center">
          <s-badge tone={row.status === "active" ? "success" : "neutral"}>
            {t(`pricing.status.${row.status}`)}
          </s-badge>
          <form method="post">
            <input type="hidden" name="ruleId" value={row.id} />
            {/* s-button carries no name/value, so the intent travels as a
                hidden field rather than on the submitter. */}
            <input type="hidden" name="intent" value={archived ? "restore" : "archive"} />
            <s-button type="submit" variant="tertiary">
              {archived ? t("pricing.list.restore") : t("pricing.list.archive")}
            </s-button>
          </form>
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

function Pagination({ view }: { view: RuleListView }) {
  const { t } = useTranslation();
  if (view.total <= view.pageSize) return null;

  const from = (view.page - 1) * view.pageSize + 1;
  const to = Math.min(view.page * view.pageSize, view.total);
  const link = (page: number) =>
    `?${new URLSearchParams({
      ...(view.archived ? { archived: "1" } : {}),
      ...(view.search ? { search: view.search } : {}),
      page: String(page),
    }).toString()}`;

  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      {view.page > 1 ? (
        <s-link href={link(view.page - 1)}>{t("pricing.list.previous")}</s-link>
      ) : null}
      <s-text color="subdued" fontVariantNumeric="tabular-nums">
        {t("pricing.list.showing", { from, to, total: view.total })}
      </s-text>
      {to < view.total ? (
        <s-link href={link(view.page + 1)}>{t("pricing.list.next")}</s-link>
      ) : null}
    </s-stack>
  );
}
