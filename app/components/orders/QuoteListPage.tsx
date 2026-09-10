import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";
import type { QuoteListView, QuoteRowView } from "~/components/orders/types";

const FILTER_BAR_FROM = 5;

export function QuoteListPage({ view }: { view: QuoteListView }) {
  const { t } = useTranslation();
  const hasAny = view.totalUnfiltered > 0;

  return (
    <s-page heading={t("quotes.list.heading")}>
      <s-section>
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-link href="/app/orders">{t("orders.list.tabOrders")}</s-link>
          <s-link href="/app/orders/limits">{t("orders.list.tabLimits")}</s-link>
          <s-link href="/app/orders/terms">{t("orders.list.tabTerms")}</s-link>
          <s-link href="/app/orders/quotes" aria-current="page">
            {t("orders.list.tabQuotes")}
          </s-link>
          <s-link href="/app/orders/po">{t("orders.list.tabPo")}</s-link>
        </s-stack>
      </s-section>

      {view.entitled ? null : <Locked view={view} />}

      {!hasAny ? (
        <EmptyState view={view} />
      ) : (
        <s-section>
          <s-stack direction="block" gap="base">
            <Toolbar view={view} />
            {view.rows.length === 0 ? <NoResults /> : <QuoteTable view={view} />}
            <Pagination view={view} />
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function Locked({ view }: { view: QuoteListView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-banner tone="info">
        <s-heading>{t("quotes.lockedHeading")}</s-heading>
        {/* Features pause, data is never deleted: quotes already sent still
            stand and their links still work. */}
        <s-paragraph>{t("quotes.lockedBody", { plan: view.requiredPlan })}</s-paragraph>
        <s-button href="/app/plans">{t("quotes.lockedAction")}</s-button>
      </s-banner>
    </s-section>
  );
}

function EmptyState({ view }: { view: QuoteListView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{t("quotes.list.emptyHeading")}</s-heading>
        <s-paragraph color="subdued">{t("quotes.list.emptyBody")}</s-paragraph>
        <form method="post">
          <input type="hidden" name="intent" value="create" />
          <s-button variant="primary" type="submit" {...whenDisabled(!view.entitled)}>
            {t("quotes.list.emptyAction")}
          </s-button>
        </form>
      </s-stack>
    </s-section>
  );
}

function NoResults() {
  const { t } = useTranslation();

  return (
    <s-stack direction="block" gap="small">
      <s-heading>{t("quotes.list.noResultsHeading")}</s-heading>
      <s-paragraph color="subdued">{t("quotes.list.noResultsBody")}</s-paragraph>
      <s-link href="?">{t("orders.list.clearFilters")}</s-link>
    </s-stack>
  );
}

function Toolbar({ view }: { view: QuoteListView }) {
  const { t } = useTranslation();

  return (
    <s-stack direction="block" gap="small">
      <form method="post">
        <input type="hidden" name="intent" value="create" />
        <s-button variant="primary" type="submit" {...whenDisabled(!view.entitled)}>
          {t("quotes.list.newQuote")}
        </s-button>
      </form>

      {view.totalUnfiltered >= FILTER_BAR_FROM ? (
        <form method="get">
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-search-field
              name="search"
              label={t("quotes.list.searchLabel")}
              value={view.filters.search}
            />
            <s-select
              name="status"
              label={t("quotes.list.filterStatus")}
              value={view.filters.status}
            >
              <s-option value="">{t("orders.list.filterAny")}</s-option>
              {(
                ["NEW", "DRAFTED", "SENT", "ACCEPTED", "DECLINED", "EXPIRED"] as const
              ).map((status) => (
                <s-option key={status} value={status}>
                  {t(`quotes.status.${status}`)}
                </s-option>
              ))}
            </s-select>
            <s-button type="submit">{t("orders.list.applyFilters")}</s-button>
          </s-stack>
        </form>
      ) : null}
    </s-stack>
  );
}

function QuoteTable({ view }: { view: QuoteListView }) {
  const { t } = useTranslation();

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>{t("quotes.list.colQuote")}</s-table-header>
        <s-table-header>{t("quotes.list.colBuyer")}</s-table-header>
        <s-table-header>{t("quotes.list.colStatus")}</s-table-header>
        <s-table-header>{t("quotes.list.colTotal")}</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {view.rows.map((row) => (
          <QuoteRow key={row.id} row={row} />
        ))}
      </s-table-body>
    </s-table>
  );
}

function QuoteRow({ row }: { row: QuoteRowView }) {
  const { t } = useTranslation();

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-link href={`/app/orders/quotes/${row.id}`}>{row.number}</s-link>
          <s-text color="subdued">
            {t("quotes.list.lineCount", { count: row.lineCount })}
          </s-text>
          {/* ✦ marks anything an agent did, everywhere in the app. */}
          {row.source === "BUYER_AGENT" ? (
            <s-badge tone="info">✦ {t("quotes.source.BUYER_AGENT")}</s-badge>
          ) : row.source === "STOREFRONT" ? (
            <s-badge tone="neutral">{t("quotes.source.STOREFRONT")}</s-badge>
          ) : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        {row.buyerHref ? (
          <s-link href={row.buyerHref}>{row.buyer}</s-link>
        ) : (
          <s-text>{row.buyer}</s-text>
        )}
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-badge tone={row.statusTone}>{row.statusLabel}</s-badge>
          {row.expiryLabel ? <s-text color="subdued">{row.expiryLabel}</s-text> : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        {row.total ? (
          <s-text fontVariantNumeric="tabular-nums">{row.total}</s-text>
        ) : (
          // Not zero: a request nobody has priced has no total, and showing
          // "$0.00" would read as free.
          <s-text color="subdued">{t("quotes.list.notPriced")}</s-text>
        )}
      </s-table-cell>
    </s-table-row>
  );
}

function Pagination({ view }: { view: QuoteListView }) {
  const { t } = useTranslation();
  if (view.pageCount <= 1) return null;

  const query = (page: number) => {
    const params = new URLSearchParams();
    if (view.filters.search) params.set("search", view.filters.search);
    if (view.filters.status) params.set("status", view.filters.status);
    params.set("page", String(page));
    return `?${params.toString()}`;
  };

  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      {view.page > 1 ? (
        <s-link href={query(view.page - 1)}>{t("orders.list.previous")}</s-link>
      ) : null}
      <s-text color="subdued">
        {t("orders.list.pageOf", { page: view.page, pageCount: view.pageCount })}
      </s-text>
      {view.page < view.pageCount ? (
        <s-link href={query(view.page + 1)}>{t("orders.list.next")}</s-link>
      ) : null}
    </s-stack>
  );
}
