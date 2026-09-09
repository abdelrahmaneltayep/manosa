import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";

import type { TagRuleListView, TagRuleRowView } from "~/components/customers/types";

/**
 * The auto-tagging rules.
 *
 * Two things this page owes the merchant. First, a preview before anything is
 * written: tagging a customer changes what they pay, so "84 customers would
 * change" has to be inspectable, not a number to trust. Second, the rules run
 * on demand — a sweep is something the merchant asks for and can see the
 * result of, not a background process that quietly re-prices their base.
 */
export function TagRulesPage({ view }: { view: TagRuleListView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("customers.tagging.heading")}>
      <s-section>
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-link href="/app/customers/applications">{t("applications.tab")}</s-link>
          <s-link href="/app/customers">{t("customers.list.tabBuyers")}</s-link>
          <s-link href="/app/customers/groups">{t("customers.list.tabGroups")}</s-link>
          <s-link href="/app/customers/tagging" aria-current="page">
            {t("customers.list.tabTagging")}
          </s-link>
        </s-stack>
      </s-section>

      {view.locked ? <Locked view={view} /> : null}
      {view.issues.length > 0 ? <Issues view={view} /> : null}
      {view.preview ? <Preview view={view} /> : null}
      {view.lastRun ? <LastRun view={view} /> : null}

      {view.rows.length === 0 ? (
        <EmptyState view={view} />
      ) : (
        <s-section>
          <s-stack direction="block" gap="base">
            <RuleTable view={view} />
            <form method="post">
              <s-stack direction="inline" gap="small" alignItems="center">
                <input type="hidden" name="intent" value="preview" />
                <s-button type="submit" {...whenDisabled(view.locked)}>
                  {t("customers.tagging.preview")}
                </s-button>
              </s-stack>
            </form>
            <form method="post">
              <s-stack direction="inline" gap="small" alignItems="center">
                <input type="hidden" name="intent" value="run" />
                <s-button type="submit" variant="primary" {...whenDisabled(view.locked)}>
                  {t("customers.tagging.run")}
                </s-button>
                <s-text color="subdued">{t("customers.tagging.runNote")}</s-text>
              </s-stack>
            </form>
          </s-stack>
        </s-section>
      )}

      {view.locked ? null : (
        <s-section heading={t("customers.tagging.newHeading")}>
          <NewRuleForm />
        </s-section>
      )}
    </s-page>
  );
}

function Locked({ view }: { view: TagRuleListView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-banner tone="info">
        <s-heading>{t("customers.tagging.lockedHeading")}</s-heading>
        <s-paragraph>
          {t("customers.tagging.lockedBody", { plan: view.requiredPlan ?? "" })}
        </s-paragraph>
        <s-button href="/app/plans">{t("customers.tagging.lockedAction")}</s-button>
      </s-banner>
    </s-section>
  );
}

function Issues({ view }: { view: TagRuleListView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-banner tone="critical">
        <s-heading>{t("customers.tagging.issuesHeading")}</s-heading>
        <s-unordered-list>
          {view.issues.map((issue) => (
            <s-list-item key={`${issue.code}-${issue.detail ?? ""}`}>
              {t(`customers.tagging.issue.${issue.code}`, { detail: issue.detail ?? "" })}
            </s-list-item>
          ))}
        </s-unordered-list>
      </s-banner>
    </s-section>
  );
}

function Preview({ view }: { view: TagRuleListView }) {
  const { t } = useTranslation();
  const preview = view.preview!;

  return (
    <s-section>
      <s-banner tone={preview.changed === 0 ? "info" : "warning"}>
        <s-heading>
          {preview.changed === 0
            ? t("customers.tagging.previewNoneHeading")
            : t("customers.tagging.previewHeading", { count: preview.changed })}
        </s-heading>
        <s-paragraph>
          {t("customers.tagging.previewBody", { count: preview.examined })}
        </s-paragraph>
        {/* The count is inspectable rather than a claim: a merchant who cannot
            see who would change has no way to catch a rule that is too wide. */}
        {preview.samples.length > 0 ? (
          <s-unordered-list>
            {preview.samples.map((sample) => (
              <s-list-item key={sample.name}>
                {t("customers.tagging.previewSample", {
                  name: sample.name,
                  add: sample.add.join(", ") || t("customers.tagging.none"),
                  remove: sample.remove.join(", ") || t("customers.tagging.none"),
                })}
              </s-list-item>
            ))}
          </s-unordered-list>
        ) : null}
      </s-banner>
    </s-section>
  );
}

function LastRun({ view }: { view: TagRuleListView }) {
  const { t } = useTranslation();
  const run = view.lastRun!;

  return (
    <s-section>
      <s-banner tone={run.failed > 0 ? "warning" : "success"}>
        <s-heading>{t("customers.tagging.ranHeading", { count: run.changed })}</s-heading>
        <s-paragraph>
          {run.failed > 0
            ? t("customers.tagging.ranWithFailures", { count: run.failed })
            : t("customers.tagging.ranBody", { count: run.examined })}
        </s-paragraph>
      </s-banner>
    </s-section>
  );
}

function EmptyState({ view }: { view: TagRuleListView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{t("customers.tagging.emptyHeading")}</s-heading>
        <s-paragraph color="subdued">{t("customers.tagging.emptyBody")}</s-paragraph>
        {view.locked ? null : <NewRuleForm />}
      </s-stack>
    </s-section>
  );
}

function NewRuleForm() {
  const { t } = useTranslation();

  return (
    <form method="post">
      <input type="hidden" name="intent" value="create" />
      <s-stack direction="block" gap="small">
        <s-text-field name="name" label={t("customers.tagging.nameLabel")} />
        <s-select
          name="field"
          label={t("customers.tagging.fieldLabel")}
          value="lifetime_spend"
        >
          <s-option value="lifetime_spend">
            {t("customers.tagging.field.lifetime_spend")}
          </s-option>
          <s-option value="order_count">
            {t("customers.tagging.field.order_count")}
          </s-option>
          <s-option value="days_since_last_order">
            {t("customers.tagging.field.days_since_last_order")}
          </s-option>
          <s-option value="country">{t("customers.tagging.field.country")}</s-option>
        </s-select>
        <s-select name="op" label={t("customers.tagging.opLabel")} value="gte">
          <s-option value="gte">{t("customers.tagging.op.gte")}</s-option>
          <s-option value="lte">{t("customers.tagging.op.lte")}</s-option>
        </s-select>
        <s-text-field
          name="value"
          label={t("customers.tagging.valueLabel")}
          details={t("customers.tagging.valueHelp")}
        />
        <s-text-field
          name="addTags"
          label={t("customers.tagging.addTagsLabel")}
          details={t("customers.tagging.tagsHelp")}
        />
        <s-text-field
          name="removeTags"
          label={t("customers.tagging.removeTagsLabel")}
          details={t("customers.tagging.tagsHelp")}
        />
        <s-button type="submit" variant="primary">
          {t("customers.tagging.create")}
        </s-button>
      </s-stack>
    </form>
  );
}

function RuleTable({ view }: { view: TagRuleListView }) {
  const { t } = useTranslation();

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>{t("customers.tagging.colName")}</s-table-header>
        <s-table-header>{t("customers.tagging.colWhen")}</s-table-header>
        <s-table-header>{t("customers.tagging.colThen")}</s-table-header>
        <s-table-header>{t("customers.tagging.colMatches")}</s-table-header>
        <s-table-header>{t("customers.groups.colActions")}</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {view.rows.map((row) => (
          <RuleRow key={row.id} row={row} locked={view.locked} />
        ))}
      </s-table-body>
    </s-table>
  );
}

function RuleRow({ row, locked }: { row: TagRuleRowView; locked: boolean }) {
  const { t } = useTranslation();

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-text type="strong">{row.name}</s-text>
          {!row.enabled ? (
            <s-badge tone="neutral">{t("customers.tagging.paused")}</s-badge>
          ) : null}
          {row.unreadableCount > 0 ? (
            // Held back rather than run partially: a rule missing a condition
            // matches more people than the merchant wrote it to match.
            <s-badge tone="critical">
              {t("customers.tagging.unreadable", { count: row.unreadableCount })}
            </s-badge>
          ) : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-text color="subdued">
            {t(`customers.tagging.matchMode.${row.matchMode}`)}
          </s-text>
          {row.conditionSummaries.map((summary) => (
            <s-text key={summary}>{summary}</s-text>
          ))}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small-500">
          {row.addTags.map((tag) => (
            <s-badge key={`add-${tag}`} tone="success">
              {t("customers.tagging.addTag", { tag })}
            </s-badge>
          ))}
          {row.removeTags.map((tag) => (
            <s-badge key={`remove-${tag}`} tone="critical">
              {t("customers.tagging.removeTag", { tag })}
            </s-badge>
          ))}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        {row.lastMatchCount === null ? (
          // Never run is not zero matches.
          <s-text color="subdued">{t("customers.tagging.neverRun")}</s-text>
        ) : (
          <s-text fontVariantNumeric="tabular-nums">{row.lastMatchCount}</s-text>
        )}
      </s-table-cell>
      <s-table-cell>
        <form method="post">
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="ruleId" value={row.id} />
          <s-button
            type="submit"
            variant="tertiary"
            tone="critical"
            {...whenDisabled(locked)}
          >
            {t("customers.tagging.delete")}
          </s-button>
        </form>
      </s-table-cell>
    </s-table-row>
  );
}
