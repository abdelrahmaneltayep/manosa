import { useTranslation } from "react-i18next";

import type { OrderListView, OrderRowView } from "~/components/orders/types";

/** Below this, a filter bar is more chrome than help. */
const FILTER_BAR_FROM = 5;

export function OrderListPage({ view }: { view: OrderListView }) {
  const { t } = useTranslation();
  const hasAny = view.totalUnfiltered > 0;

  return (
    <s-page heading={t("orders.list.heading")}>
      <Banners view={view} />

      {view.syncing && !hasAny ? (
        <Syncing />
      ) : !hasAny ? (
        <EmptyState />
      ) : (
        <s-section>
          <s-stack direction="block" gap="base">
            <Toolbar view={view} />
            {view.rows.length === 0 ? <NoResults /> : <OrderTable view={view} />}
            <Pagination view={view} />
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function Banners({ view }: { view: OrderListView }) {
  const { t } = useTranslation();
  const banners: React.ReactNode[] = [];

  if (view.syncing && view.totalUnfiltered > 0) {
    banners.push(
      <s-banner key="syncing" tone="info">
        <s-heading>{t("orders.list.syncingHeading")}</s-heading>
        <s-paragraph>{t("orders.list.syncingBody")}</s-paragraph>
      </s-banner>,
    );
  }

  if (view.resyncCount > 0) {
    banners.push(
      <s-banner key="resync" tone="warning">
        <s-heading>
          {t("orders.list.resyncHeading", { count: view.resyncCount })}
        </s-heading>
        {/* Says what the merchant is looking at — a stale total — rather than
            only that something changed. */}
        <s-paragraph>{t("orders.list.resyncBody")}</s-paragraph>
      </s-banner>,
    );
  }

  if (banners.length === 0) return null;
  return <s-section>{banners}</s-section>;
}

function Syncing() {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{t("orders.list.syncingHeading")}</s-heading>
        <s-paragraph color="subdued">{t("orders.list.syncingFirstBody")}</s-paragraph>
        <s-stack direction="block" gap="small" accessibilityVisibility="hidden">
          {[0, 1, 2].map((row) => (
            <s-box key={row} background="subdued" padding="base" borderRadius="base">
              <s-text color="subdued"> </s-text>
            </s-box>
          ))}
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function EmptyState() {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{t("orders.list.emptyHeading")}</s-heading>
        <s-paragraph color="subdued">{t("orders.list.emptyBody")}</s-paragraph>
        <s-stack direction="inline" gap="small">
          <s-button variant="primary" href="/app/orders/limits">
            {t("orders.list.emptyLimits")}
          </s-button>
          <s-link
            href="https://help.shopify.com/en/manual/checkout-settings/test-orders"
            target="_blank"
          >
            {t("orders.list.emptyTestOrder")}
          </s-link>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function NoResults() {
  const { t } = useTranslation();

  return (
    <s-stack direction="block" gap="small">
      <s-heading>{t("orders.list.noResultsHeading")}</s-heading>
      <s-paragraph color="subdued">{t("orders.list.noResultsBody")}</s-paragraph>
      <s-link href="?">{t("orders.list.clearFilters")}</s-link>
    </s-stack>
  );
}

function Toolbar({ view }: { view: OrderListView }) {
  const { t } = useTranslation();
  const showFilters = view.totalUnfiltered >= FILTER_BAR_FROM;

  return (
    <s-stack direction="block" gap="small">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-link href="/app/orders" aria-current="page">
          {t("orders.list.tabOrders")}
        </s-link>
        <s-link href="/app/orders/limits">{t("orders.list.tabLimits")}</s-link>
        <s-link href="/app/orders/terms">{t("orders.list.tabTerms")}</s-link>
      </s-stack>

      {/* Stated, not implied: the list starts 60 days back because that is as
          far as Shopify lets an app read without extra permission. */}
      <s-paragraph color="subdued">
        {t("orders.list.historyNote", { count: view.historyDays })}
      </s-paragraph>

      {showFilters ? (
        <form method="get">
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-search-field
              name="search"
              label={t("orders.list.searchLabel")}
              value={view.filters.search}
            />
            <s-select
              name="source"
              label={t("orders.list.filterSource")}
              value={view.filters.source}
            >
              <s-option value="">{t("orders.list.filterAny")}</s-option>
              {(
                ["storefront", "quick_order", "buyer_agent", "draft", "pos"] as const
              ).map((source) => (
                <s-option key={source} value={source}>
                  {t(`orders.source.${source.toUpperCase()}`)}
                </s-option>
              ))}
            </s-select>
            <s-select
              name="payment"
              label={t("orders.list.filterPayment")}
              value={view.filters.payment}
            >
              <s-option value="">{t("orders.list.filterAny")}</s-option>
              <s-option value="paid">{t("orders.list.filterPaid")}</s-option>
              <s-option value="outstanding">
                {t("orders.list.filterOutstanding")}
              </s-option>
              <s-option value="overdue">{t("orders.list.filterOverdue")}</s-option>
              <s-option value="refunded">{t("orders.list.filterRefunded")}</s-option>
            </s-select>
            <s-button type="submit">{t("orders.list.applyFilters")}</s-button>
          </s-stack>
        </form>
      ) : null}
    </s-stack>
  );
}

function OrderTable({ view }: { view: OrderListView }) {
  const { t } = useTranslation();

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>{t("orders.list.colOrder")}</s-table-header>
        <s-table-header>{t("orders.list.colBuyer")}</s-table-header>
        <s-table-header>{t("orders.list.colPlacedVia")}</s-table-header>
        <s-table-header>{t("orders.list.colPayment")}</s-table-header>
        <s-table-header>{t("orders.list.colTotal")}</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {view.rows.map((row) => (
          <OrderRow key={row.id} row={row} />
        ))}
      </s-table-body>
    </s-table>
  );
}

function OrderRow({ row }: { row: OrderRowView }) {
  const { t } = useTranslation();

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-link href={row.adminUrl} target="_blank">
            {row.name}
          </s-link>
          <s-text color="subdued">{row.processedLabel}</s-text>
          {row.needsResync ? (
            <s-badge tone="warning">{t("orders.list.resyncBadge")}</s-badge>
          ) : null}
          {row.cancelled ? (
            <s-badge tone="neutral">{t("orders.list.cancelledBadge")}</s-badge>
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
        <s-badge tone={row.placedVia === "BUYER_AGENT" ? "info" : "neutral"}>
          {/* The ✦ marks anything an agent did, everywhere in the app. */}
          {row.placedVia === "BUYER_AGENT" ? "✦ " : ""}
          {t(`orders.source.${row.placedVia}`)}
        </s-badge>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-badge tone={row.payment.tone}>{row.payment.label}</s-badge>
          {row.refund ? <s-text color="subdued">{row.refund}</s-text> : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-text fontVariantNumeric="tabular-nums">{row.total}</s-text>
          <s-text color="subdued">
            {t("orders.list.units", { count: row.quantity })}
          </s-text>
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

function Pagination({ view }: { view: OrderListView }) {
  const { t } = useTranslation();
  if (view.pageCount <= 1) return null;

  const query = (page: number) => {
    const params = new URLSearchParams();
    if (view.filters.search) params.set("search", view.filters.search);
    if (view.filters.source) params.set("source", view.filters.source);
    if (view.filters.payment) params.set("payment", view.filters.payment);
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
