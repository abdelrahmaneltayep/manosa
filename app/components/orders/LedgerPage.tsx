import { useTranslation } from "react-i18next";

import { whenChecked, whenDisabled } from "~/components/boolean-attribute";
import type { LedgerView, LedgerRowView } from "~/components/orders/types";

/**
 * The outstanding ledger: who owes what, and how late it is.
 *
 * Every number on this page comes from `@mannon/net-terms`, which is also what
 * the checkout Function asks. The checklist requires it: "buyer at credit limit
 * → agent and checkout both say so with the same number".
 */
export function LedgerPage({ view }: { view: LedgerView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("terms.ledger.heading")}>
      <s-section>
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-link href="/app/orders">{t("orders.list.tabOrders")}</s-link>
          <s-link href="/app/orders/limits">{t("orders.list.tabLimits")}</s-link>
          <s-link href="/app/orders/terms" aria-current="page">
            {t("orders.list.tabTerms")}
          </s-link>
        </s-stack>
      </s-section>

      {view.entitled ? null : <Locked view={view} />}
      {view.publishedAt ? null : <NotPublished />}

      {view.rows.length === 0 ? (
        <EmptyState view={view} />
      ) : (
        <>
          <Aging view={view} />
          <s-section heading={t("terms.ledger.outstandingHeading")}>
            <s-stack direction="block" gap="base">
              <LedgerTable view={view} />
              <Pagination view={view} />
            </s-stack>
          </s-section>
        </>
      )}

      <Settings view={view} />
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function Locked({ view }: { view: LedgerView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-banner tone="info">
        <s-heading>{t("terms.lockedHeading")}</s-heading>
        {/* Features pause, data is never deleted: existing invoices are still
            shown and still chased, they just cannot be changed. */}
        <s-paragraph>{t("terms.lockedBody", { plan: view.requiredPlan })}</s-paragraph>
        <s-button href="/app/plans">{t("terms.lockedAction")}</s-button>
      </s-banner>
    </s-section>
  );
}

function NotPublished() {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-banner tone="warning">
        <s-heading>{t("terms.notPublishedHeading")}</s-heading>
        {/* Unpublished settings are not a small problem: the Function falls
            back to its own defaults, so a renamed method is shown to everyone. */}
        <s-paragraph>{t("terms.notPublishedBody")}</s-paragraph>
      </s-banner>
    </s-section>
  );
}

function EmptyState({ view }: { view: LedgerView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>
          {t(
            view.anyBuyerHasTerms
              ? "terms.ledger.allPaidHeading"
              : "terms.ledger.emptyHeading",
          )}
        </s-heading>
        <s-paragraph color="subdued">
          {t(
            view.anyBuyerHasTerms ? "terms.ledger.allPaidBody" : "terms.ledger.emptyBody",
          )}
        </s-paragraph>
        {view.anyBuyerHasTerms ? null : (
          <s-button variant="primary" href="/app/customers/groups">
            {t("terms.ledger.emptyAction")}
          </s-button>
        )}
      </s-stack>
    </s-section>
  );
}

/** The aging buckets, every one of them, including the empty ones. */
function Aging({ view }: { view: LedgerView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("terms.ledger.agingHeading")}>
      <s-stack direction="inline" gap="base">
        {view.buckets.map((bucket) => (
          <s-box
            key={bucket.bucket}
            background="subdued"
            padding="base"
            borderRadius="base"
          >
            <s-stack direction="block" gap="small-500">
              <s-text color="subdued">{t(`terms.bucket.${bucket.bucket}`)}</s-text>
              {/* Overdue money is red, per the checklist. A badge rather than
                  coloured text: `s-text` has no critical tone, and colour
                  alone would not carry to a screen reader anyway. */}
              {bucket.bucket !== "current" && bucket.invoiceCount > 0 ? (
                <s-badge tone="critical">{bucket.outstanding}</s-badge>
              ) : (
                <s-text fontVariantNumeric="tabular-nums">{bucket.outstanding}</s-text>
              )}
              <s-text color="subdued">
                {t("terms.ledger.invoiceCount", { count: bucket.invoiceCount })}
              </s-text>
            </s-stack>
          </s-box>
        ))}
      </s-stack>
      <s-paragraph>
        {t("terms.ledger.totalOutstanding", { amount: view.outstanding })}
      </s-paragraph>
    </s-section>
  );
}

function LedgerTable({ view }: { view: LedgerView }) {
  const { t } = useTranslation();

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>{t("terms.ledger.colOrder")}</s-table-header>
        <s-table-header>{t("terms.ledger.colBuyer")}</s-table-header>
        <s-table-header>{t("terms.ledger.colDue")}</s-table-header>
        <s-table-header>{t("terms.ledger.colBalance")}</s-table-header>
        <s-table-header>{t("terms.ledger.colActions")}</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {view.rows.map((row) => (
          <LedgerRow key={row.id} row={row} entitled={view.entitled} />
        ))}
      </s-table-body>
    </s-table>
  );
}

function LedgerRow({ row, entitled }: { row: LedgerRowView; entitled: boolean }) {
  const { t } = useTranslation();

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-link href={row.adminUrl} target="_blank">
            {row.name}
          </s-link>
          {row.terms ? <s-text color="subdued">{row.terms}</s-text> : null}
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
          <s-badge tone={row.overdue ? "critical" : "neutral"}>{row.dueLabel}</s-badge>
          {row.remindedLabel ? (
            <s-text color="subdued">{row.remindedLabel}</s-text>
          ) : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-text fontVariantNumeric="tabular-nums">{row.balance}</s-text>
          {row.paid ? <s-text color="subdued">{row.paid}</s-text> : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <form method="post">
            <input type="hidden" name="intent" value="recordPayment" />
            <input type="hidden" name="orderId" value={row.id} />
            <s-stack direction="inline" gap="small-500" alignItems="end">
              <s-number-field
                name="amount"
                label={t("terms.ledger.paymentAmount", { currency: row.currencyCode })}
                labelAccessibilityVisibility="exclusive"
                placeholder={row.balanceRaw}
                // Red, inline, beside the field that caused it, and it does not
                // dismiss itself.
                error={row.error ?? undefined}
                {...whenDisabled(!entitled)}
              />
              <s-text-field
                name="reference"
                label={t("terms.ledger.paymentReference")}
                labelAccessibilityVisibility="exclusive"
                {...whenDisabled(!entitled)}
              />
              <s-button type="submit" {...whenDisabled(!entitled)}>
                {t("terms.ledger.recordPayment")}
              </s-button>
            </s-stack>
          </form>
          <form method="post">
            <input type="hidden" name="intent" value="remind" />
            <input type="hidden" name="orderId" value={row.id} />
            <s-button
              variant="tertiary"
              type="submit"
              {...whenDisabled(!entitled || !row.canRemind)}
            >
              {t("terms.ledger.sendReminder")}
            </s-button>
          </form>
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

function Pagination({ view }: { view: LedgerView }) {
  const { t } = useTranslation();
  if (view.pageCount <= 1) return null;

  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      {view.page > 1 ? (
        <s-link href={`?page=${view.page - 1}`}>{t("orders.list.previous")}</s-link>
      ) : null}
      <s-text color="subdued">
        {t("orders.list.pageOf", { page: view.page, pageCount: view.pageCount })}
      </s-text>
      {view.page < view.pageCount ? (
        <s-link href={`?page=${view.page + 1}`}>{t("orders.list.next")}</s-link>
      ) : null}
    </s-stack>
  );
}

/** How paying later appears at checkout. */
function Settings({ view }: { view: LedgerView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("terms.settings.heading")}>
      <form method="post">
        <input type="hidden" name="intent" value="settings" />
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">{t("terms.settings.intro")}</s-paragraph>
          <s-text-field
            name="methodName"
            label={t("terms.settings.methodLabel")}
            details={t("terms.settings.methodHelp")}
            value={view.settings.methodName}
            error={view.settingsError ? t("terms.settings.methodRequired") : undefined}
            {...whenDisabled(!view.entitled)}
          />
          <s-checkbox
            name="showDaysInName"
            value="1"
            label={t("terms.settings.showDaysLabel")}
            details={t("terms.settings.showDaysHelp")}
            {...whenChecked(view.settings.showDaysInName)}
            {...whenDisabled(!view.entitled)}
          />
          <s-checkbox
            name="overdueBlocks"
            value="1"
            label={t("terms.settings.overdueBlocksLabel")}
            details={t("terms.settings.overdueBlocksHelp")}
            {...whenChecked(view.settings.overdueBlocks)}
            {...whenDisabled(!view.entitled)}
          />
          <s-box background="subdued" padding="base" borderRadius="base">
            <s-stack direction="block" gap="small-500">
              <s-text color="subdued">{t("terms.settings.previewLabel")}</s-text>
              <s-text>{view.settings.preview}</s-text>
            </s-stack>
          </s-box>
          <s-button variant="primary" type="submit" {...whenDisabled(!view.entitled)}>
            {t("terms.settings.save")}
          </s-button>
        </s-stack>
      </form>
    </s-section>
  );
}
