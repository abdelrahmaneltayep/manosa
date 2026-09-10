import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";
import type { WizardView } from "~/components/setup/types";

/**
 * ✦ Claude Setup Wizard.
 *
 * The merchant describes their wholesale business; Claude proposes groups, a
 * starter rule and a registration form; the merchant reads the preview and
 * applies it. Nothing on this page happens without the last step — the preview
 * is a draft, and the button is the approval the audit log records.
 */
export function WizardPage({ view }: { view: WizardView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("wizard.heading")}>
      <s-section>
        <s-stack direction="block" gap="base">
          {view.available ? null : (
            <s-banner tone="info">
              <s-heading>{t("wizard.offHeading")}</s-heading>
              <s-paragraph>{t(`wizard.off.${view.locked ?? "no_key"}`)}</s-paragraph>
              <s-link href="/app">{t("wizard.offManual")}</s-link>
            </s-banner>
          )}

          <Applied view={view} />
          <Failure view={view} />

          {view.applied ? null : (
            <form method="post">
              <input type="hidden" name="intent" value="describe" />
              <s-stack direction="block" gap="small">
                <s-text-area
                  name="description"
                  rows={6}
                  label={t("wizard.label")}
                  details={t("wizard.help")}
                  value={view.description}
                  {...whenDisabled(!view.available)}
                />
                <s-text color="subdued">{t("wizard.example")}</s-text>
                <s-button
                  type="submit"
                  variant="primary"
                  {...whenDisabled(!view.available)}
                >
                  {t("wizard.action")}
                </s-button>
              </s-stack>
            </form>
          )}

          <Preview view={view} />
        </s-stack>
      </s-section>
    </s-page>
  );
}

function Applied({ view }: { view: WizardView }) {
  const { t } = useTranslation();
  if (!view.applied) return null;

  return (
    <s-banner tone="success">
      <s-heading>{t("wizard.appliedHeading")}</s-heading>
      <s-unordered-list>
        {view.applied.links.map((link) => (
          <s-list-item key={link.href}>
            <s-link href={link.href}>{link.label}</s-link>
          </s-list-item>
        ))}
      </s-unordered-list>
      {/* Said plainly, because a form the merchant thinks is live and is not
          is a buyer who never applies. */}
      {view.applied.formDraft ? (
        <s-paragraph>{t("wizard.formIsDraft")}</s-paragraph>
      ) : null}
    </s-banner>
  );
}

function Failure({ view }: { view: WizardView }) {
  const { t } = useTranslation();
  if (!view.failure) return null;

  return (
    <s-banner tone="warning">
      <s-heading>{t(`wizard.failure.${view.failure}.heading`)}</s-heading>
      <s-paragraph>{t(`wizard.failure.${view.failure}.body`)}</s-paragraph>
      <s-link href="/app/pricing/new">{t("wizard.failureManual")}</s-link>
    </s-banner>
  );
}

function Preview({ view }: { view: WizardView }) {
  const { t } = useTranslation();
  if (!view.plan) return null;
  const plan = view.plan;

  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderStyle="solid"
      borderColor="base"
      borderRadius="base"
    >
      <s-stack direction="block" gap="base">
        <s-heading>{t("wizard.previewHeading")}</s-heading>
        <s-paragraph>{plan.summary}</s-paragraph>

        <s-stack direction="block" gap="small-100">
          <s-text type="strong">
            {t("wizard.groupsHeading", { count: plan.groups.length })}
          </s-text>
          <s-unordered-list>
            {plan.groups.map((group) => (
              <s-list-item key={group.tag}>
                {group.name} · {group.tag} — {group.description}
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-stack>

        {plan.rule ? (
          <s-stack direction="block" gap="small-100">
            <s-text type="strong">{t("wizard.ruleHeading")}</s-text>
            <s-text>{plan.rule.name}</s-text>
            <s-text color="subdued">{plan.rule.summary}</s-text>
          </s-stack>
        ) : (
          <s-text color="subdued">{t("wizard.noRule")}</s-text>
        )}

        {plan.form ? (
          <s-stack direction="block" gap="small-100">
            <s-text type="strong">{t("wizard.formHeading")}</s-text>
            <s-text>{plan.form.name}</s-text>
            <s-text color="subdued">{plan.form.fields.join(" · ")}</s-text>
          </s-stack>
        ) : (
          <s-text color="subdued">{t("wizard.noForm")}</s-text>
        )}

        {plan.notes ? (
          // What it assumed, in its own words. Shown above the button, never
          // folded away: it is the half of the answer a merchant should read.
          <s-banner tone="info">
            <s-paragraph>{plan.notes}</s-paragraph>
          </s-banner>
        ) : null}

        <s-stack direction="inline" gap="small" alignItems="center">
          <form method="post">
            <input type="hidden" name="intent" value="apply" />
            <input type="hidden" name="payload" value={view.payload} />
            <s-button type="submit" variant="primary">
              {t("wizard.apply")}
            </s-button>
          </form>
          <s-link href="/app/setup">{t("wizard.startOver")}</s-link>
        </s-stack>
      </s-stack>
    </s-box>
  );
}
