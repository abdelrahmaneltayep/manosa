import { useTranslation } from "react-i18next";

import { whenChecked, whenDisabled } from "~/components/boolean-attribute";
import type { LimitRowView, LimitsView } from "~/components/orders/types";

/**
 * Order limits: minimums, maximums and case packs, per group.
 *
 * Nothing on this page decides whether a limit is valid — `@mannon/order-limits`
 * does, and the same module runs at checkout. A second copy of the rules living
 * in a form is how an admin ends up telling a merchant one thing and the cart
 * telling their buyer another.
 */
export function LimitsPage({ view }: { view: LimitsView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("limits.heading")}>
      <s-section>
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-link href="/app/orders">{t("orders.list.tabOrders")}</s-link>
          <s-link href="/app/orders/limits" aria-current="page">
            {t("orders.list.tabLimits")}
          </s-link>
          <s-link href="/app/orders/terms">{t("orders.list.tabTerms")}</s-link>
          <s-link href="/app/orders/quotes">{t("orders.list.tabQuotes")}</s-link>
          <s-link href="/app/orders/po">{t("orders.list.tabPo")}</s-link>
        </s-stack>
      </s-section>

      {view.entitled ? null : <Locked view={view} />}
      {view.issues.length > 0 ? <Issues view={view} /> : null}

      {view.rows.length === 0 ? (
        <EmptyState view={view} />
      ) : (
        <s-section heading={t("limits.currentHeading")}>
          <s-stack direction="block" gap="base">
            <LimitTable view={view} />
            {view.publishedAt ? (
              <s-text color="subdued">
                {t("limits.publishedAt", { at: view.publishedAt.slice(0, 10) })}
              </s-text>
            ) : (
              // A limit that has not reached Shopify does not apply to anybody,
              // and a merchant who thinks it does is the whole problem.
              <s-banner tone="warning">
                <s-paragraph>{t("limits.notPublished")}</s-paragraph>
              </s-banner>
            )}
          </s-stack>
        </s-section>
      )}

      {view.preview ? <Preview view={view} /> : null}

      <s-section heading={t(view.form?.id ? "limits.editHeading" : "limits.newHeading")}>
        <LimitForm view={view} />
      </s-section>

      <s-section heading={t("limits.posHeading")}>
        <form method="post">
          <input type="hidden" name="intent" value="posBypass" />
          <s-stack direction="block" gap="small">
            <s-checkbox
              name="posBypassesLimits"
              value="1"
              label={t("limits.posLabel")}
              details={t("limits.posHelp")}
              {...whenChecked(view.posBypassesLimits)}
              {...whenDisabled(!view.entitled)}
            />
            <s-button type="submit" {...whenDisabled(!view.entitled)}>
              {t("limits.posSave")}
            </s-button>
          </s-stack>
        </form>
      </s-section>
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function Locked({ view }: { view: LimitsView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-banner tone="info">
        <s-heading>{t("limits.lockedHeading")}</s-heading>
        {/* Features pause, data is never deleted: existing limits keep working
            and are still shown, they just cannot be changed. */}
        <s-paragraph>{t("limits.lockedBody", { plan: view.requiredPlan })}</s-paragraph>
        <s-button href="/app/plans">{t("limits.lockedAction")}</s-button>
      </s-banner>
    </s-section>
  );
}

function Issues({ view }: { view: LimitsView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-banner tone="critical">
        <s-heading>{t("limits.issuesHeading")}</s-heading>
        <s-unordered-list>
          {view.issues.map((issue) => (
            <s-list-item key={`${issue.code}-${issue.detail ?? ""}`}>
              {t(`limits.issue.${issue.code}`, { detail: issue.detail ?? "" })}
            </s-list-item>
          ))}
        </s-unordered-list>
      </s-banner>
    </s-section>
  );
}

function EmptyState({ view }: { view: LimitsView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{t("limits.emptyHeading")}</s-heading>
        <s-paragraph color="subdued">
          {t("limits.emptyBody", { example: view.exampleMinimum })}
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>
            {t("limits.emptyExampleMinimum", { example: view.exampleMinimum })}
          </s-list-item>
          <s-list-item>{t("limits.emptyExampleCase")}</s-list-item>
          <s-list-item>{t("limits.emptyExampleMaximum")}</s-list-item>
        </s-unordered-list>
      </s-stack>
    </s-section>
  );
}

function LimitTable({ view }: { view: LimitsView }) {
  const { t } = useTranslation();

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>{t("limits.colApplies")}</s-table-header>
        <s-table-header>{t("limits.colRule")}</s-table-header>
        <s-table-header>{t("limits.colStatus")}</s-table-header>
        <s-table-header>{t("limits.colActions")}</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {view.rows.map((row) => (
          <LimitRow key={row.id} row={row} entitled={view.entitled} />
        ))}
      </s-table-body>
    </s-table>
  );
}

function LimitRow({ row, entitled }: { row: LimitRowView; entitled: boolean }) {
  const { t } = useTranslation();

  return (
    <s-table-row>
      <s-table-cell>
        {row.groupName ? (
          <s-badge tone="info">{row.groupName}</s-badge>
        ) : (
          <s-text>{t("limits.appliesEveryone")}</s-text>
        )}
      </s-table-cell>
      <s-table-cell>
        <s-text>{row.summary}</s-text>
      </s-table-cell>
      <s-table-cell>
        <s-badge tone={row.enabled ? "success" : "neutral"}>
          {t(row.enabled ? "limits.statusOn" : "limits.statusOff")}
        </s-badge>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small-500" alignItems="center">
          <s-link href={`?edit=${row.id}`}>{t("limits.edit")}</s-link>
          <form method="post">
            <input type="hidden" name="intent" value="delete" />
            <input type="hidden" name="id" value={row.id} />
            <s-button
              variant="tertiary"
              tone="critical"
              type="submit"
              {...whenDisabled(!entitled)}
            >
              {t("limits.remove")}
            </s-button>
          </form>
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

/** What a buyer would see, rendered by the module the checkout runs. */
function Preview({ view }: { view: LimitsView }) {
  const { t } = useTranslation();
  if (!view.preview) return null;

  return (
    <s-section heading={t("limits.previewHeading")}>
      <s-stack direction="block" gap="small">
        <s-paragraph color="subdued">{t("limits.previewBody")}</s-paragraph>
        <s-box background="subdued" padding="base" borderRadius="base">
          <s-stack direction="block" gap="small-500">
            <s-text color="subdued">{view.preview.heading}</s-text>
            <s-text>{view.preview.message}</s-text>
          </s-stack>
        </s-box>
        <s-link href="/app/settings">{t("limits.previewEdit")}</s-link>
      </s-stack>
    </s-section>
  );
}

function LimitForm({ view }: { view: LimitsView }) {
  const { t } = useTranslation();
  const form = view.form;
  const issueFor = (code: string) => view.issues.find((issue) => issue.code === code);
  const boundsIssue = issueFor("no_bounds");

  return (
    <form method="post">
      <input type="hidden" name="intent" value="save" />
      {form?.id ? <input type="hidden" name="id" value={form.id} /> : null}

      <ui-save-bar id="limit-save-bar">
        <button type="submit" variant="primary" />
        <button type="reset" />
      </ui-save-bar>

      <s-stack direction="block" gap="base">
        <s-select
          name="groupId"
          label={t("limits.groupLabel")}
          details={t("limits.groupHelp")}
          value={form?.groupId ?? ""}
          {...whenDisabled(!view.entitled)}
        >
          <s-option value="">{t("limits.appliesEveryone")}</s-option>
          {view.groups.map((group) => (
            <s-option key={group.id} value={group.id}>
              {group.name}
            </s-option>
          ))}
        </s-select>

        <s-stack direction="inline" gap="base">
          <s-number-field
            name="minSubtotal"
            label={t("limits.minSubtotalLabel", { currency: view.currencyCode })}
            value={form?.minSubtotal ?? ""}
            error={
              issueFor("min_above_max_subtotal")
                ? t("limits.issue.min_above_max_subtotal")
                : undefined
            }
            {...whenDisabled(!view.entitled)}
          />
          <s-number-field
            name="maxSubtotal"
            label={t("limits.maxSubtotalLabel", { currency: view.currencyCode })}
            value={form?.maxSubtotal ?? ""}
            {...whenDisabled(!view.entitled)}
          />
        </s-stack>

        <s-stack direction="inline" gap="base">
          <s-number-field
            name="minQuantity"
            label={t("limits.minQuantityLabel")}
            value={form?.minQuantity ?? ""}
            error={
              issueFor("min_above_max_quantity")
                ? t("limits.issue.min_above_max_quantity")
                : undefined
            }
            {...whenDisabled(!view.entitled)}
          />
          <s-number-field
            name="maxQuantity"
            label={t("limits.maxQuantityLabel")}
            value={form?.maxQuantity ?? ""}
            {...whenDisabled(!view.entitled)}
          />
          <s-number-field
            name="quantityIncrement"
            label={t("limits.incrementLabel")}
            details={t("limits.incrementHelp")}
            value={form?.quantityIncrement ?? ""}
            error={
              issueFor("increment_conflicts_with_minimum")
                ? t("limits.issue.increment_conflicts_with_minimum", {
                    detail: issueFor("increment_conflicts_with_minimum")?.detail ?? "",
                  })
                : undefined
            }
            {...whenDisabled(!view.entitled)}
          />
        </s-stack>

        <s-text-field
          name="countries"
          label={t("limits.countriesLabel")}
          details={t("limits.countriesHelp")}
          value={form?.countries ?? ""}
          {...whenDisabled(!view.entitled)}
        />

        <s-checkbox
          name="enabled"
          value="1"
          label={t("limits.enabledLabel")}
          {...whenChecked(form?.enabled ?? true)}
          {...whenDisabled(!view.entitled)}
        />

        {boundsIssue ? (
          <s-banner tone="critical">
            <s-paragraph>{t("limits.issue.no_bounds")}</s-paragraph>
          </s-banner>
        ) : null}

        <s-stack direction="inline" gap="small">
          <s-button variant="primary" type="submit" {...whenDisabled(!view.entitled)}>
            {t("limits.save")}
          </s-button>
          {form?.id ? <s-link href="?">{t("limits.cancelEdit")}</s-link> : null}
        </s-stack>
      </s-stack>
    </form>
  );
}
