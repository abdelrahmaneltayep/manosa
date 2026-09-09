import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";

import type { CustomerListView, CustomerRowView } from "~/components/customers/types";

/** Below this, a filter bar is more chrome than help. */
const FILTER_BAR_FROM = 5;

export function CustomerListPage({ view }: { view: CustomerListView }) {
  const { t } = useTranslation();
  const hasAny = view.totalUnfiltered > 0;

  return (
    <s-page heading={t("customers.list.heading")}>
      <Banners view={view} />

      {view.syncing && !hasAny ? (
        <Syncing view={view} />
      ) : !hasAny ? (
        <EmptyState view={view} />
      ) : (
        <s-section>
          <s-stack direction="block" gap="base">
            <Toolbar view={view} />
            {view.rows.length === 0 ? (
              <NoResults view={view} />
            ) : (
              <CustomerTable view={view} />
            )}
            <Pagination view={view} />
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function Banners({ view }: { view: CustomerListView }) {
  const { t } = useTranslation();
  const banners: React.ReactNode[] = [];

  if (view.syncing && view.totalUnfiltered > 0) {
    banners.push(
      <s-banner key="syncing" tone="info">
        <s-heading>{t("customers.list.syncingHeading")}</s-heading>
        <s-paragraph>
          {t("customers.list.syncingBody", { count: view.syncedSoFar })}
        </s-paragraph>
      </s-banner>,
    );
  }

  if (view.staleMinutesAgo !== null) {
    banners.push(
      <s-banner key="stale" tone="warning">
        <s-heading>{t("customers.list.staleHeading")}</s-heading>
        <s-paragraph>
          {t("customers.list.staleBody", { minutes: view.staleMinutesAgo })}
        </s-paragraph>
        <s-button href="?">{t("customers.list.retry")}</s-button>
      </s-banner>,
    );
  }

  if (view.orphanedCount > 0) {
    banners.push(
      <s-banner key="orphaned" tone="warning">
        <s-heading>
          {t("customers.list.orphanedHeading", { count: view.orphanedCount })}
        </s-heading>
        {/* Says what it means for the buyer's price, not just that a group
            went away — the merchant is deciding whether to act. */}
        <s-paragraph>{t("customers.list.orphanedBody")}</s-paragraph>
        <s-link href="/app/customers/groups">{t("customers.list.orphanedAction")}</s-link>
      </s-banner>,
    );
  }

  if (banners.length === 0) return null;
  return <s-section>{banners}</s-section>;
}

/** The first sync, before any buyer has landed. */
function Syncing({ view }: { view: CustomerListView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{t("customers.list.syncingHeading")}</s-heading>
        <s-paragraph color="subdued">
          {t("customers.list.syncingFirstBody", { count: view.syncedSoFar })}
        </s-paragraph>
        {/* Three skeleton rows, as the checklist asks. Marked hidden from
            assistive tech: announcing three empty rows is worse than silence. */}
        <s-stack direction="block" gap="small" accessibilityVisibility="hidden">
          {[0, 1, 2].map((row) => (
            <s-box key={row} background="subdued" padding="base" borderRadius="base">
              <s-text color="subdued">{" "}</s-text>
            </s-box>
          ))}
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function EmptyState({ view }: { view: CustomerListView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{t("customers.list.emptyHeading")}</s-heading>
        <s-paragraph color="subdued">
          {t("customers.list.emptyBody", { tag: view.wholesaleTag })}
        </s-paragraph>
        <s-stack direction="inline" gap="small">
          <s-button variant="primary" href="/app/forms">
            {t("customers.list.emptyForm")}
          </s-button>
          <s-button href="/app/customers/groups">
            {t("customers.list.emptyGroups")}
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function NoResults({ view }: { view: CustomerListView }) {
  const { t } = useTranslation();

  return (
    <s-stack direction="block" gap="small">
      <s-heading>
        {view.search
          ? t("customers.list.noResultsHeading", { query: view.search })
          : t("customers.list.noMatchesHeading")}
      </s-heading>
      <s-paragraph color="subdued">{t("customers.list.noResultsBody")}</s-paragraph>
      <s-link href="?">{t("customers.list.clearFilters")}</s-link>
    </s-stack>
  );
}

function Toolbar({ view }: { view: CustomerListView }) {
  const { t } = useTranslation();
  const showFilters = view.totalUnfiltered >= FILTER_BAR_FROM;

  return (
    <s-stack direction="block" gap="small">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-link href="/app/customers/applications">{t("applications.tab")}</s-link>
        <s-link href="/app/customers" aria-current="page">
          {t("customers.list.tabBuyers")}
        </s-link>
        <s-link href="/app/customers/groups">{t("customers.list.tabGroups")}</s-link>
        <s-link href="/app/customers/tagging">{t("customers.list.tabTagging")}</s-link>
        {/* ✦ Segment builder needs the AI layer (4.3). Present but honest
            about not being ready, rather than absent. */}
        <s-button
          variant="primary"
          href="/app/customers?segment=1"
          {...whenDisabled(!view.aiAvailable)}
        >
          {t("customers.list.segmentBuilder")}
        </s-button>
      </s-stack>

      {showFilters ? (
        <form method="get">
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-search-field
              name="search"
              label={t("customers.list.searchLabel")}
              value={view.search}
            />
            <s-select
              name="group"
              label={t("customers.list.filterGroup")}
              value={view.filters.groupId}
            >
              <s-option value="">{t("customers.list.filterAny")}</s-option>
              <s-option value="none">{t("customers.list.filterNoGroup")}</s-option>
              {view.groups.map((group) => (
                <s-option key={group.id} value={group.id}>
                  {group.name}
                </s-option>
              ))}
            </s-select>
            <s-select
              name="terms"
              label={t("customers.list.filterTerms")}
              value={view.filters.terms}
            >
              <s-option value="">{t("customers.list.filterAny")}</s-option>
              <s-option value="net">{t("customers.list.filterNetTerms")}</s-option>
              <s-option value="prepaid">{t("customers.list.filterPrepaid")}</s-option>
            </s-select>
            <s-select
              name="taxExempt"
              label={t("customers.list.filterTaxExempt")}
              value={view.filters.taxExempt}
            >
              <s-option value="">{t("customers.list.filterAny")}</s-option>
              <s-option value="1">{t("customers.list.filterTaxExemptYes")}</s-option>
              <s-option value="0">{t("customers.list.filterTaxExemptNo")}</s-option>
            </s-select>
            <s-checkbox
              name="atRisk"
              value="1"
              label={t("customers.list.filterAtRisk", { count: view.atRiskDays })}
              {...(view.filters.atRisk ? { checked: true } : {})}
            />
            <s-button type="submit">{t("customers.list.applyFilters")}</s-button>
          </s-stack>
        </form>
      ) : null}
    </s-stack>
  );
}

function CustomerTable({ view }: { view: CustomerListView }) {
  const { t } = useTranslation();

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>{t("customers.list.colName")}</s-table-header>
        <s-table-header>{t("customers.list.colGroup")}</s-table-header>
        <s-table-header>{t("customers.list.colTerms")}</s-table-header>
        <s-table-header>{t("customers.list.colSpend")}</s-table-header>
        <s-table-header>{t("customers.list.colLastOrder")}</s-table-header>
        <s-table-header>{t("customers.list.colActions")}</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {view.rows.map((row) => (
          <CustomerRow key={row.id} row={row} groups={view.groups} />
        ))}
      </s-table-body>
    </s-table>
  );
}

function CustomerRow({
  row,
  groups,
}: {
  row: CustomerRowView;
  groups: { id: string; name: string }[];
}) {
  const { t } = useTranslation();

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-link href={`/app/customers/${row.id}`}>{row.name}</s-link>
          {row.email ? <s-text color="subdued">{row.email}</s-text> : null}
          {row.deletedInShopify ? (
            <s-badge tone="critical">{t("customers.list.deletedInShopify")}</s-badge>
          ) : null}
          {row.status !== "APPROVED" ? (
            <s-badge tone={row.status === "PENDING" ? "warning" : "neutral"}>
              {t(`customers.status.${row.status}`)}
            </s-badge>
          ) : null}
          {row.taxExempt ? (
            <s-badge tone="info">{t("customers.list.taxExemptBadge")}</s-badge>
          ) : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        {row.group ? (
          <s-badge tone="info">{row.group.name}</s-badge>
        ) : (
          <s-text color="subdued">{t("customers.list.noGroup")}</s-text>
        )}
      </s-table-cell>
      <s-table-cell>
        {row.terms ?? <s-text color="subdued">{t("customers.list.prepaid")}</s-text>}
      </s-table-cell>
      <s-table-cell>
        <s-text fontVariantNumeric="tabular-nums">{row.lifetimeSpend}</s-text>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          {row.lastOrderAt === null ? (
            <s-text color="subdued">{t("customers.list.neverOrdered")}</s-text>
          ) : (
            <s-text fontVariantNumeric="tabular-nums">
              {t("customers.list.daysAgo", { count: row.daysSinceLastOrder ?? 0 })}
            </s-text>
          )}
          {row.atRisk ? (
            <s-badge tone="caution">{t("customers.list.atRiskBadge")}</s-badge>
          ) : null}
          {/* ✦ A prediction, and labelled as one. Never shown until the model
              behind it exists. */}
          {row.dueToReorder ? (
            <s-badge tone="info">{t("customers.list.dueToReorderBadge")}</s-badge>
          ) : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <form method="post">
          <input type="hidden" name="intent" value="changeGroup" />
          <input type="hidden" name="customerId" value={row.id} />
          <s-stack direction="inline" gap="small-500" alignItems="center">
            <s-select
              name="groupId"
              label={t("customers.list.changeGroup")}
              labelAccessibilityVisibility="exclusive"
              value={row.group?.id ?? ""}
              {...whenDisabled(row.deletedInShopify)}
            >
              <s-option value="">{t("customers.list.noGroup")}</s-option>
              {groups.map((group) => (
                <s-option key={group.id} value={group.id}>
                  {group.name}
                </s-option>
              ))}
            </s-select>
            <s-button
              type="submit"
              variant="tertiary"
              {...whenDisabled(row.deletedInShopify)}
            >
              {t("customers.list.move")}
            </s-button>
          </s-stack>
        </form>
        {/* A price change that only takes effect on the buyer's next session
            is exactly the kind of thing merchants discover from a complaint.
            Not shown for a deleted buyer: no price applies to them at all, and
            promising one would be a small lie on every row. */}
        {row.deletedInShopify ? null : (
          <s-text color="subdued">{t("customers.list.repriceNote")}</s-text>
        )}
      </s-table-cell>
    </s-table-row>
  );
}

function Pagination({ view }: { view: CustomerListView }) {
  const { t } = useTranslation();
  if (view.total <= view.pageSize) return null;

  const from = (view.page - 1) * view.pageSize + 1;
  const to = Math.min(view.page * view.pageSize, view.total);
  const link = (page: number) =>
    `?${new URLSearchParams({
      ...(view.search ? { search: view.search } : {}),
      ...(view.filters.groupId ? { group: view.filters.groupId } : {}),
      ...(view.filters.terms ? { terms: view.filters.terms } : {}),
      ...(view.filters.taxExempt ? { taxExempt: view.filters.taxExempt } : {}),
      ...(view.filters.atRisk ? { atRisk: "1" } : {}),
      page: String(page),
    }).toString()}`;

  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      {view.page > 1 ? (
        <s-link href={link(view.page - 1)}>{t("customers.list.previous")}</s-link>
      ) : null}
      <s-text color="subdued" fontVariantNumeric="tabular-nums">
        {t("customers.list.showing", { from, to, total: view.total })}
      </s-text>
      {to < view.total ? (
        <s-link href={link(view.page + 1)}>{t("customers.list.next")}</s-link>
      ) : null}
    </s-stack>
  );
}
