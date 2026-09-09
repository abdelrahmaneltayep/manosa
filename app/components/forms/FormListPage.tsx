import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";
import type { FormCardView, FormListView } from "~/components/forms/types";

/**
 * The forms a merchant has, and the three ways to start a new one.
 *
 * The empty state is the important screen: it is where a merchant decides how
 * much to ask an applicant for, and every extra field costs applications. Each
 * template says what it trades.
 */
export function FormListPage({ view }: { view: FormListView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("forms.list.heading")}>
      {view.atFormLimit ? (
        <s-section>
          <s-banner tone="info">
            <s-heading>{t("forms.list.limitHeading")}</s-heading>
            <s-paragraph>
              {t("forms.list.limitBody", { plan: view.requiredPlan ?? "" })}
            </s-paragraph>
            <s-button href="/app/plans">{t("forms.list.limitAction")}</s-button>
          </s-banner>
        </s-section>
      ) : null}

      {view.rows.length === 0 ? (
        <EmptyState view={view} />
      ) : (
        <s-section>
          <s-stack direction="block" gap="base">
            {view.rows.map((row) => (
              <FormCard key={row.id} row={row} />
            ))}
            <Starters view={view} />
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

function EmptyState({ view }: { view: FormListView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{t("forms.list.emptyHeading")}</s-heading>
        <s-paragraph color="subdued">{t("forms.list.emptyBody")}</s-paragraph>
        <form method="post">
          <input type="hidden" name="intent" value="generate" />
          {/* ✦ Generating a form from a sentence is phase 4.3. Present but
              honest about not being ready, rather than absent. */}
          <s-button type="submit" variant="primary" {...whenDisabled(!view.aiAvailable)}>
            {t("forms.list.generate")}
          </s-button>
        </form>
        <Starters view={view} />
      </s-stack>
    </s-section>
  );
}

function Starters({ view }: { view: FormListView }) {
  const { t } = useTranslation();

  return (
    <s-stack direction="block" gap="small">
      <s-heading>{t("forms.list.startersHeading")}</s-heading>
      {view.templates.map((template) => (
        <form method="post" key={template.key}>
          <input type="hidden" name="intent" value="template" />
          <input type="hidden" name="template" value={template.key} />
          <s-stack direction="block" gap="small-500">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button type="submit" {...whenDisabled(view.atFormLimit)}>
                {template.name}
              </s-button>
              {/* The trade-off, not a feature list: a stricter form turns away
                  more of the buyers you want as well as the ones you do not. */}
              <s-text color="subdued">{template.description}</s-text>
            </s-stack>
          </s-stack>
        </form>
      ))}
    </s-stack>
  );
}

function FormCard({ row }: { row: FormCardView }) {
  const { t } = useTranslation();

  return (
    <s-box padding="base" borderRadius="base" border="base">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-link href={`/app/forms/${row.id}`}>{row.name}</s-link>
          <s-badge tone={row.status === "LIVE" ? "success" : "neutral"}>
            {t(`forms.status.${row.status}`)}
          </s-badge>
          {row.blockingIssues > 0 ? (
            <s-badge tone="warning">
              {t("forms.list.issues", { count: row.blockingIssues })}
            </s-badge>
          ) : null}
        </s-stack>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text fontVariantNumeric="tabular-nums">
            {t("forms.list.submissions", { count: row.submissions30d })}
          </s-text>
          <s-text color="subdued" fontVariantNumeric="tabular-nums">
            {row.conversion === null
              ? // Nobody has opened it, so there is no rate. Showing 0% would
                // be a claim about a form that has never been seen.
                t("forms.list.noViews")
              : t("forms.list.conversion", { percent: row.conversion })}
          </s-text>
          <s-text color="subdued">
            {t("forms.list.lastEdited", { at: row.lastEditedAt })}
          </s-text>
        </s-stack>

        <s-stack direction="inline" gap="small" alignItems="center">
          <s-link href={row.publicUrl}>{row.publicUrl}</s-link>
          <form method="post">
            <input type="hidden" name="intent" value="duplicate" />
            <input type="hidden" name="formId" value={row.id} />
            <s-button type="submit" variant="tertiary">
              {t("forms.list.duplicate")}
            </s-button>
          </form>
          <form method="post">
            <input type="hidden" name="intent" value="archive" />
            <input type="hidden" name="formId" value={row.id} />
            <s-button type="submit" variant="tertiary" tone="critical">
              {t("forms.list.archive")}
            </s-button>
          </form>
        </s-stack>
      </s-stack>
    </s-box>
  );
}
