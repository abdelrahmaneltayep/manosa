import { useTranslation } from "react-i18next";

import { whenChecked } from "~/components/boolean-attribute";

import type { RuleBuilderView, RuleFormView } from "~/components/pricing/types";
import type { RuleIssue } from "@mannon/pricing-engine";

const KINDS = [
  "percentage",
  "amount_off",
  "fixed_price",
  "volume_tier",
  "cart_value_tier",
] as const;

/**
 * The shop's currency is a runtime string; Polaris types it as a closed union.
 * Narrowed here rather than everywhere it is used.
 */
type MoneyFieldCurrency = NonNullable<
  JSX.IntrinsicElements["s-money-field"]["currencyCode"]
>;
const asCurrency = (code: string) => code as MoneyFieldCurrency;

const TARGET_MODES = ["all", "collections", "products", "variants"] as const;
const AUDIENCE_MODES = [
  "all",
  "tags",
  "groups",
  "customers",
  "companies",
  "guests",
] as const;

export function RuleBuilderPage({ view }: { view: RuleBuilderView }) {
  const { t } = useTranslation();
  const { form } = view;
  const isNew = form.id === null;

  const issueFor = (field: string) => view.issues.find((issue) => issue.field === field);

  return (
    <s-page
      heading={t(isNew ? "pricing.builder.newHeading" : "pricing.builder.editHeading")}
    >
      {view.conflict ? <ConflictBanner view={view} /> : null}

      <form method="post">
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="version" value={form.version} />

        {/* App Bridge shows the contextual save bar; the form still submits
            without it, which is what keeps this page usable with no JS. */}
        <ui-save-bar id="rule-save-bar">
          <button type="submit" variant="primary" />
          <button type="reset" />
        </ui-save-bar>

        <s-section heading={t("pricing.builder.basics")}>
          <s-stack direction="block" gap="base">
            <Field issue={issueFor("name")}>
              <s-text-field
                name="name"
                label={t("pricing.builder.nameLabel")}
                details={t("pricing.builder.nameHelp")}
                value={form.name}
                error={issueFor("name") ? t("pricing.issue.name_required") : undefined}
              />
            </Field>

            {view.duplicateName ? (
              <s-banner tone="warning">
                <s-paragraph>
                  {t("pricing.list.duplicateNameWarning", { name: view.duplicateName })}
                </s-paragraph>
              </s-banner>
            ) : null}

            <s-select
              name="status"
              label={t("pricing.builder.statusLabel")}
              details={t("pricing.builder.statusHelp")}
              value={form.status}
            >
              <s-option value="draft">{t("pricing.status.draft")}</s-option>
              <s-option value="active">{t("pricing.status.active")}</s-option>
            </s-select>

            <s-select
              name="kind"
              label={t("pricing.builder.kindLabel")}
              value={form.kind}
            >
              {KINDS.map((kind) => (
                <s-option key={kind} value={kind}>
                  {t(`pricing.kind.${kind}`)}
                </s-option>
              ))}
            </s-select>

            <ValueFields view={view} issueFor={issueFor} />
          </s-stack>
        </s-section>

        <TargetsSection form={form} issueFor={issueFor} />
        <AudienceSection form={form} issueFor={issueFor} />
        <ScheduleSection form={form} issueFor={issueFor} />
        <AdvancedSection form={form} />

        <s-section>
          <s-stack direction="inline" gap="small">
            <s-button type="submit" variant="primary">
              {t("pricing.builder.save")}
            </s-button>
            <s-button href="/app/pricing">{t("pricing.builder.discard")}</s-button>
          </s-stack>
        </s-section>
      </form>

      <PreviewPanel view={view} />
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function Field({
  issue,
  children,
}: {
  issue: RuleIssue | undefined;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <s-stack direction="block" gap="small-500">
      {children}
      {issue ? (
        // Beside the cause, with the fix — Built for Shopify's error rule, and
        // never a toast: a blocking error must not disappear on its own.
        <s-text tone="critical">
          {t(`pricing.issue.${issue.code}`, issue.params ?? {})}
        </s-text>
      ) : null}
    </s-stack>
  );
}

function ValueFields({
  view,
  issueFor,
}: {
  view: RuleBuilderView;
  issueFor: (field: string) => RuleIssue | undefined;
}) {
  const { t } = useTranslation();
  const { form } = view;

  if (form.kind === "percentage") {
    return (
      <Field issue={issueFor("value.percentage")}>
        <s-number-field
          name="percentage"
          label={t("pricing.builder.percentageLabel")}
          value={form.percentage}
          min={0}
          max={100}
          suffix="%"
        />
      </Field>
    );
  }

  if (form.kind === "amount_off" || form.kind === "fixed_price") {
    return (
      <Field issue={issueFor("value.base")}>
        <s-money-field
          name="amount"
          label={t(
            form.kind === "amount_off"
              ? "pricing.builder.amountLabel"
              : "pricing.builder.fixedPriceLabel",
          )}
          value={form.amount}
          currencyCode={asCurrency(form.currencyCode)}
        />
      </Field>
    );
  }

  if (form.kind === "cart_value_tier") {
    return (
      <s-stack direction="block" gap="base">
        <Field issue={issueFor("value.tiers.0.minSubtotal")}>
          <s-money-field
            name="cartMinimum"
            label={t("pricing.builder.cartMinimumLabel")}
            value={form.cartMinimum}
            currencyCode={asCurrency(form.currencyCode)}
          />
        </Field>
        <Field issue={issueFor("value.tiers.0")}>
          <s-number-field
            name="percentage"
            label={t("pricing.builder.percentageLabel")}
            value={form.percentage}
            min={0}
            max={100}
            suffix="%"
          />
        </Field>
      </s-stack>
    );
  }

  return <TierFields view={view} issueFor={issueFor} />;
}

function TierFields({
  view,
  issueFor,
}: {
  view: RuleBuilderView;
  issueFor: (field: string) => RuleIssue | undefined;
}) {
  const { t } = useTranslation();
  const rows =
    view.form.tiers.length > 0
      ? view.form.tiers
      : [{ minQuantity: "", maxQuantity: "", kind: "percentage" as const, value: "" }];

  return (
    <s-stack direction="block" gap="base">
      <s-heading>{t("pricing.builder.tiersHeading")}</s-heading>
      <s-paragraph color="subdued">{t("pricing.builder.tiersHelp")}</s-paragraph>

      {rows.map((tier, index) => (
        <Field key={index} issue={issueFor(`value.tiers.${index}`)}>
          <s-stack direction="inline" gap="small">
            <s-number-field
              name="tierMin"
              label={t("pricing.builder.tierMin")}
              value={tier.minQuantity}
              min={1}
            />
            <s-number-field
              name="tierMax"
              label={t("pricing.builder.tierMax")}
              details={t("pricing.builder.tierMaxAny")}
              value={tier.maxQuantity}
            />
            <s-select
              name="tierKind"
              label={t("pricing.builder.tierKind")}
              value={tier.kind}
            >
              <s-option value="percentage">{t("pricing.kind.percentage")}</s-option>
              <s-option value="amount_off">{t("pricing.kind.amount_off")}</s-option>
              <s-option value="fixed_price">{t("pricing.kind.fixed_price")}</s-option>
            </s-select>
            <s-text-field
              name="tierValue"
              label={t("pricing.builder.tierValue")}
              value={tier.value}
            />
          </s-stack>
        </Field>
      ))}

      {view.issues
        .filter((issue) => issue.code === "tier_overlap" || issue.code === "no_tiers")
        .map((issue, index) => (
          <s-text key={index} tone="critical">
            {t(`pricing.issue.${issue.code}`, issue.params ?? {})}
          </s-text>
        ))}
    </s-stack>
  );
}

function TargetsSection({
  form,
  issueFor,
}: {
  form: RuleFormView;
  issueFor: (field: string) => RuleIssue | undefined;
}) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("pricing.builder.targetsHeading")}>
      <s-stack direction="block" gap="base">
        <Field issue={issueFor("targets")}>
          <s-select
            name="targetMode"
            label={t("pricing.builder.targetModeLabel")}
            value={form.targetMode}
          >
            {TARGET_MODES.map((mode) => (
              <s-option key={mode} value={mode}>
                {t(`pricing.targets.${mode}`, { count: 0 })}
              </s-option>
            ))}
          </s-select>
        </Field>

        {form.targetMode === "collections" ? (
          <s-text-area
            name="targetCollectionIds"
            label={t("pricing.targets.collections", { count: 2 })}
            details={t("pricing.builder.idsHelp")}
            value={form.targetCollectionIds}
          />
        ) : null}
        {form.targetMode === "products" ? (
          <s-text-area
            name="targetProductIds"
            label={t("pricing.targets.products", { count: 2 })}
            details={t("pricing.builder.idsHelp")}
            value={form.targetProductIds}
          />
        ) : null}
        {form.targetMode === "variants" ? (
          <s-text-area
            name="targetVariantIds"
            label={t("pricing.targets.variants", { count: 2 })}
            details={t("pricing.builder.idsHelp")}
            value={form.targetVariantIds}
          />
        ) : null}

        <s-text-area
          name="excludeCollectionIds"
          label={t("pricing.builder.excludeCollections")}
          details={t("pricing.builder.idsHelp")}
          value={form.excludeCollectionIds}
        />
      </s-stack>
    </s-section>
  );
}

function AudienceSection({
  form,
  issueFor,
}: {
  form: RuleFormView;
  issueFor: (field: string) => RuleIssue | undefined;
}) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("pricing.builder.audienceHeading")}>
      <s-stack direction="block" gap="base">
        <Field issue={issueFor("audience")}>
          <s-select
            name="audienceMode"
            label={t("pricing.builder.audienceModeLabel")}
            value={form.audienceMode}
          >
            {AUDIENCE_MODES.map((mode) => (
              <s-option key={mode} value={mode}>
                {t(`pricing.audience.${mode}`, { count: 0, tags: "" })}
              </s-option>
            ))}
          </s-select>
        </Field>

        {form.audienceMode === "tags" ? (
          <s-text-area
            name="audienceTags"
            label={t("pricing.builder.tagsLabel")}
            details={t("pricing.builder.tagsHelp")}
            value={form.audienceTags}
          />
        ) : null}
        {form.audienceMode === "customers" ? (
          <s-text-area
            name="audienceCustomerIds"
            label={t("pricing.audience.customers", { count: 2 })}
            details={t("pricing.builder.idsHelp")}
            value={form.audienceCustomerIds}
          />
        ) : null}
        {form.audienceMode === "companies" ? (
          <s-text-area
            name="audienceCompanyIds"
            label={t("pricing.audience.companies", { count: 2 })}
            details={t("pricing.builder.idsHelp")}
            value={form.audienceCompanyIds}
          />
        ) : null}
      </s-stack>
    </s-section>
  );
}

function ScheduleSection({
  form,
  issueFor,
}: {
  form: RuleFormView;
  issueFor: (field: string) => RuleIssue | undefined;
}) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("pricing.builder.scheduleHeading")}>
      <s-stack direction="block" gap="base">
        <s-paragraph color="subdued">{t("pricing.builder.scheduleHelp")}</s-paragraph>
        <s-stack direction="inline" gap="small">
          <s-date-field
            name="startsAt"
            label={t("pricing.builder.startsAt")}
            value={form.startsAt}
          />
          <Field issue={issueFor("schedule.endsAt")}>
            <s-date-field
              name="endsAt"
              label={t("pricing.builder.endsAt")}
              value={form.endsAt}
            />
          </Field>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function AdvancedSection({ form }: { form: RuleFormView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("pricing.builder.advancedHeading")}>
      <s-stack direction="block" gap="base">
        <s-number-field
          name="priority"
          label={t("pricing.builder.priorityLabel")}
          details={t("pricing.builder.priorityHelp")}
          value={String(form.priority)}
          min={0}
        />
        <s-checkbox
          name="combinable"
          label={t("pricing.builder.combinableLabel")}
          details={t("pricing.builder.combinableHelp")}
          {...whenChecked(form.combinable)}
        />
        <s-banner tone="warning">
          <s-paragraph>{t("pricing.settings.combinationWarning")}</s-paragraph>
        </s-banner>
      </s-stack>
    </s-section>
  );
}

function PreviewPanel({ view }: { view: RuleBuilderView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("pricing.builder.previewHeading")}>
      <s-stack direction="block" gap="small">
        <s-paragraph color="subdued">{t("pricing.builder.previewBody")}</s-paragraph>

        {/* A preview that fails must never stop a merchant saving their work. */}
        {!view.preview || view.preview.unavailable ? (
          <s-text color="subdued">{t("pricing.builder.previewUnavailable")}</s-text>
        ) : view.preview.changed ? (
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text color="subdued">
              {t("pricing.builder.previewWas")} {view.preview.was}
            </s-text>
            <s-text type="strong">
              {t("pricing.builder.previewNow")} {view.preview.now}
            </s-text>
            <s-badge tone="info">
              {t("pricing.builder.previewQuantity")}: {view.preview.quantity}
            </s-badge>
          </s-stack>
        ) : (
          <s-text color="subdued">{t("pricing.builder.previewNoChange")}</s-text>
        )}
      </s-stack>
    </s-section>
  );
}

function ConflictBanner({ view }: { view: RuleBuilderView }) {
  const { t } = useTranslation();
  if (!view.conflict) return null;

  return (
    <s-section>
      <s-banner tone="warning">
        <s-heading>{t("pricing.conflict.heading")}</s-heading>
        <s-paragraph>
          {t("pricing.conflict.body", { name: view.conflict.name })}
        </s-paragraph>
        <s-stack direction="inline" gap="small">
          <form method="post">
            <input type="hidden" name="intent" value="save" />
            <input type="hidden" name="version" value={view.conflict.theirVersion} />
            <input type="hidden" name="force" value="1" />
            <s-button type="submit">{t("pricing.conflict.overwrite")}</s-button>
          </form>
          <s-button href={`/app/pricing/${view.form.id}`}>
            {t("pricing.conflict.keepTheirs")}
          </s-button>
        </s-stack>
      </s-banner>
    </s-section>
  );
}
