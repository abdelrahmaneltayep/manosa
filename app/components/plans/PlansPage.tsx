import { useTranslation } from "react-i18next";

import type { PendingChangeView, PlansView } from "~/components/plans/types";
import {
  annualSaving,
  BILLING_INTERVALS,
  FEATURE_KEYS,
  PLAN_LIST,
  planHasFeature,
  priceFor,
  type PlanDefinition,
  type PlanInterval,
  type PlanKey,
} from "~/lib/billing/plans";
import type { UsageMeter } from "~/lib/billing/usage.server";

/** A trial with this long or less gets its own banner, not just a pill. */
const TRIAL_WARNING_DAYS = 3;

export function PlansPage({ view }: { view: PlansView }) {
  const { t } = useTranslation();
  const planName = (key: PlanKey) => t(`planName.${key}`);

  return (
    <s-page heading={t("nav.plans")}>
      <StatusBanners view={view} planName={planName} />

      {view.pendingChange ? (
        <ChangeConfirmation view={view} change={view.pendingChange} planName={planName} />
      ) : (
        <>
          <UsageSection view={view} planName={planName} />
          <PlanCards view={view} planName={planName} />
          <ComparisonTable currentPlan={view.effectivePlan} planName={planName} />
          <AdvisorPlaceholder />
        </>
      )}
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function StatusBanners({
  view,
  planName,
}: {
  view: PlansView;
  planName: (key: PlanKey) => string;
}) {
  const { t } = useTranslation();
  const banners: React.ReactNode[] = [];

  if (view.error) {
    banners.push(
      <s-banner key="error" tone="critical">
        <s-heading>{t("plans.error.heading")}</s-heading>
        <s-paragraph>{t("plans.error.body")}</s-paragraph>
      </s-banner>,
    );
  }

  if (view.status === "PAST_DUE") {
    banners.push(
      <s-banner key="past-due" tone="warning">
        <s-heading>{t("plans.pastDue.heading")}</s-heading>
        <s-paragraph>
          {t("plans.pastDue.body", {
            count: view.graceDaysRemaining ?? 0,
            plan: planName(view.plan),
          })}
        </s-paragraph>
      </s-banner>,
    );
  }

  if (view.status === "CANCELLED") {
    banners.push(
      <s-banner key="cancelled" tone="info">
        <s-heading>{t("plans.cancelled.heading")}</s-heading>
        <s-paragraph>{t("plans.cancelled.body")}</s-paragraph>
      </s-banner>,
    );
  }

  if (
    view.status === "TRIAL" &&
    view.trialDaysRemaining !== null &&
    view.trialDaysRemaining <= TRIAL_WARNING_DAYS
  ) {
    banners.push(
      <s-banner key="trial" tone="info">
        <s-heading>
          {t("plans.trial.endingHeading", { count: view.trialDaysRemaining })}
        </s-heading>
        <s-paragraph>
          {t("plans.trial.endingBody", {
            plan: planName(view.plan),
            price: PLAN_LIST.find((plan) => plan.key === view.plan)?.monthlyPrice ?? 0,
          })}
        </s-paragraph>
      </s-banner>,
    );
  }

  if (view.isTest) {
    banners.push(
      <s-banner key="test" tone="info">
        <s-heading>{t("plans.test.heading")}</s-heading>
        <s-paragraph>{t("plans.test.body")}</s-paragraph>
      </s-banner>,
    );
  }

  for (const meter of view.meters) {
    if (!meter.nearingLimit && !meter.atLimit) continue;
    const item = t(`limit.${meter.key}`);
    banners.push(
      <s-banner key={`meter-${meter.key}`} tone={meter.atLimit ? "warning" : "info"}>
        <s-heading>
          {meter.atLimit
            ? t("plans.usage.atHeading", { item })
            : t("plans.usage.nearingHeading", { item })}
        </s-heading>
        <s-paragraph>
          {meter.atLimit
            ? t("plans.usage.atBody", {
                plan: planName(view.effectivePlan),
                limit: meter.limit,
              })
            : t("plans.usage.nearingBody", {
                used: meter.used,
                limit: meter.limit,
                plan: planName(nextPlanUp(view.effectivePlan)),
              })}
        </s-paragraph>
      </s-banner>,
    );
  }

  if (banners.length === 0) return null;
  return <s-section>{banners}</s-section>;
}

function nextPlanUp(from: PlanKey): PlanKey {
  const current = PLAN_LIST.find((plan) => plan.key === from);
  const next = PLAN_LIST.find((plan) => plan.rank === (current?.rank ?? 0) + 1);
  return next?.key ?? "agentic";
}

/* -------------------------------------------------------------------------- */

function UsageSection({
  view,
  planName,
}: {
  view: PlansView;
  planName: (key: PlanKey) => string;
}) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("plans.usage.heading")}>
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-text type="strong">{t("plans.currentPlan")}:</s-text>
          <s-badge tone={view.status === "PAST_DUE" ? "warning" : "success"}>
            {planName(view.effectivePlan)}
          </s-badge>
          {view.status === "TRIAL" && view.trialDaysRemaining !== null ? (
            <s-badge tone="info">
              {t("plans.trial.pill", { count: view.trialDaysRemaining })}
            </s-badge>
          ) : null}
        </s-stack>

        {view.meters.map((meter) => (
          <UsageRow key={meter.key} meter={meter} />
        ))}
      </s-stack>
    </s-section>
  );
}

function UsageRow({ meter }: { meter: UsageMeter }) {
  const { t } = useTranslation();
  const label = t(`limit.${meter.key}`);

  return (
    <s-stack direction="inline" gap="small" justifyContent="space-between">
      <s-text>{label}</s-text>
      <s-text fontVariantNumeric="tabular-nums" tone={meter.atLimit ? "warning" : "auto"}>
        {meter.limit === null
          ? t("plans.usage.usedUnlimited", { used: meter.used })
          : t("plans.usage.ofLimit", { used: meter.used, limit: meter.limit })}
      </s-text>
    </s-stack>
  );
}

/* -------------------------------------------------------------------------- */

function IntervalToggle({ selected }: { selected: PlanInterval }) {
  const { t } = useTranslation();

  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      <s-text type="strong">{t("plans.interval.legend")}</s-text>
      {BILLING_INTERVALS.map((interval) => (
        <s-link
          key={interval}
          href={`?interval=${interval}`}
          {...(interval === selected ? { "aria-current": "true" } : {})}
        >
          {t(`plans.interval.${interval}`)}
          {interval === selected ? " ✓" : ""}
        </s-link>
      ))}
    </s-stack>
  );
}

function PlanCards({
  view,
  planName,
}: {
  view: PlansView;
  planName: (key: PlanKey) => string;
}) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("nav.plans")}>
      <s-stack direction="block" gap="base">
        <IntervalToggle selected={view.selectedInterval} />
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap="base">
          {PLAN_LIST.map((plan) => (
            <PlanCard key={plan.key} plan={plan} view={view} planName={planName} />
          ))}
        </s-grid>
      </s-stack>
    </s-section>
  );
}

function PlanCard({
  plan,
  view,
  planName,
}: {
  plan: PlanDefinition;
  view: PlansView;
  planName: (key: PlanKey) => string;
}) {
  const { t } = useTranslation();
  const isCurrent = plan.key === view.effectivePlan;
  const price = priceFor(plan, view.selectedInterval);
  const saving = annualSaving(plan);

  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderStyle="solid"
      borderColor={isCurrent ? "strong" : "base"}
      borderRadius="base"
    >
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-heading>{planName(plan.key)}</s-heading>
          {isCurrent ? <s-badge tone="success">{t("plans.currentPlan")}</s-badge> : null}
        </s-stack>

        <s-text type="strong" fontVariantNumeric="tabular-nums">
          {plan.monthlyPrice === 0
            ? t("plans.free")
            : view.selectedInterval === "annual"
              ? t("plans.perYear", { price })
              : t("plans.perMonth", { price })}
        </s-text>

        {plan.monthlyPrice > 0 && view.selectedInterval === "annual" && saving > 0 ? (
          <s-badge tone="success">{t("plans.annualSaving", { amount: saving })}</s-badge>
        ) : null}

        <s-paragraph color="subdued">{t(`planTagline.${plan.key}`)}</s-paragraph>

        <s-unordered-list>
          <s-list-item>
            {plan.limits.pricingRules === null
              ? t("limit.unlimitedRules")
              : t("limit.pricingRulesAllowance", { count: plan.limits.pricingRules })}
          </s-list-item>
          <s-list-item>
            {plan.limits.forms === null
              ? t("limit.unlimitedForms")
              : t("limit.formsAllowance", { count: plan.limits.forms })}
          </s-list-item>
        </s-unordered-list>

        {isCurrent ? (
          <s-text color="subdued">{t("plans.thisIsYourPlan")}</s-text>
        ) : (
          // A downgrade is as easy to reach as an upgrade — the same control,
          // the same number of steps. Built for Shopify forbids dark patterns.
          <s-button
            href={`?change=${plan.key}&interval=${view.selectedInterval}`}
            variant={
              plan.rank > (PLAN_LIST.find((p) => p.key === view.effectivePlan)?.rank ?? 0)
                ? "primary"
                : "secondary"
            }
          >
            {t("plans.switchTo", { plan: planName(plan.key) })}
          </s-button>
        )}
      </s-stack>
    </s-box>
  );
}

/* -------------------------------------------------------------------------- */

function ChangeConfirmation({
  view,
  change,
  planName,
}: {
  view: PlansView;
  change: PendingChangeView;
  planName: (key: PlanKey) => string;
}) {
  const { t } = useTranslation();
  const target = planName(change.to);

  const heading =
    change.direction === "upgrade"
      ? t("plans.change.upgradeHeading", { plan: target })
      : change.direction === "downgrade"
        ? t("plans.change.downgradeHeading", { plan: target })
        : t("plans.change.intervalHeading");

  return (
    <s-section heading={heading}>
      <s-stack direction="block" gap="base">
        {/* What it costs and when it takes effect — before any charge. */}
        <s-paragraph>
          {change.price === 0
            ? t("plans.free")
            : change.toInterval === "annual"
              ? t("plans.perYear", { price: change.price })
              : t("plans.perMonth", { price: change.price })}
        </s-paragraph>

        {change.direction === "upgrade" || change.direction === "interval-only" ? (
          <>
            <s-paragraph>{t("plans.change.proration")}</s-paragraph>
            <s-paragraph>{t("plans.change.takesEffectNow")}</s-paragraph>
          </>
        ) : (
          <s-paragraph>
            {view.currentPeriodEndLabel
              ? t("plans.change.takesEffectAtPeriodEnd", {
                  plan: planName(view.plan),
                  date: view.currentPeriodEndLabel,
                })
              : t("plans.change.takesEffectAtPeriodEndNoDate")}
          </s-paragraph>
        )}

        {change.gaining.length > 0 ? (
          <s-stack direction="block" gap="small-100">
            <s-heading>{t("plans.change.gaining")}</s-heading>
            <s-unordered-list>
              {change.gaining.map((feature) => (
                <s-list-item key={feature}>{t(`feature.${feature}`)}</s-list-item>
              ))}
            </s-unordered-list>
          </s-stack>
        ) : null}

        {change.losing.length > 0 ? (
          <s-stack direction="block" gap="small-100">
            <s-heading>{t("plans.change.losing")}</s-heading>
            <s-unordered-list>
              {change.losing.map((feature) => (
                <s-list-item key={feature}>{t(`feature.${feature}`)}</s-list-item>
              ))}
            </s-unordered-list>
            <s-paragraph color="subdued">{t("plans.change.nothingDeleted")}</s-paragraph>
          </s-stack>
        ) : null}

        {change.limitImpacts.length > 0 ? (
          <s-stack direction="block" gap="small-100">
            <s-unordered-list>
              {change.limitImpacts.map((impact) => (
                <s-list-item key={impact.key}>
                  {t("plans.change.limitTightens", {
                    item: t(`limit.${impact.key}`),
                    used: impact.used,
                    becomes: impact.becomes,
                  })}
                </s-list-item>
              ))}
            </s-unordered-list>
          </s-stack>
        ) : null}

        {change.hasOverage ? (
          <s-banner tone="warning">
            <s-heading>{t("plans.change.overageHeading")}</s-heading>
            {change.limitImpacts
              .filter((impact) => impact.overBy > 0)
              .map((impact) => (
                <s-paragraph key={impact.key}>
                  {t("plans.change.overageBody", {
                    overBy: impact.overBy,
                    item: t(`limit.${impact.key}`),
                    plan: target,
                  })}
                </s-paragraph>
              ))}
          </s-banner>
        ) : null}

        {/* A plain form, not Remix's: this page is a pure function of its
            props so every state can be rendered in a test, and a document POST
            keeps the flow working with JavaScript off. The action redirects to
            Shopify either way. */}
        <form method="post">
          <input type="hidden" name="intent" value="change-plan" />
          <input type="hidden" name="plan" value={change.to} />
          <input type="hidden" name="interval" value={change.toInterval} />
          <s-stack direction="inline" gap="small">
            <s-button type="submit" variant="primary">
              {change.to === "free"
                ? t("plans.change.confirmCancel")
                : change.direction === "downgrade"
                  ? t("plans.change.confirmDowngrade", { plan: target })
                  : t("plans.change.confirmUpgrade")}
            </s-button>
            <s-button href="?">{t("plans.change.cancel")}</s-button>
          </s-stack>
        </form>
      </s-stack>
    </s-section>
  );
}

/* -------------------------------------------------------------------------- */

function ComparisonTable({
  currentPlan,
  planName,
}: {
  currentPlan: PlanKey;
  planName: (key: PlanKey) => string;
}) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("plans.compare.heading")}>
      <s-table>
        <s-table-header-row>
          <s-table-header>{t("plans.compare.feature")}</s-table-header>
          {PLAN_LIST.map((plan) => (
            <s-table-header key={plan.key}>
              {planName(plan.key)}
              {plan.key === currentPlan ? " ✓" : ""}
            </s-table-header>
          ))}
        </s-table-header-row>
        <s-table-body>
          {FEATURE_KEYS.map((feature) => (
            <s-table-row key={feature}>
              <s-table-cell>{t(`feature.${feature}`)}</s-table-cell>
              {PLAN_LIST.map((plan) => (
                <s-table-cell key={plan.key}>
                  {/* A tick alone is meaningless to a screen reader: the word
                      is announced, the glyph is decorative. */}
                  <s-text accessibilityVisibility="exclusive">
                    {planHasFeature(plan.key, feature)
                      ? t("plans.compare.included")
                      : t("plans.compare.notIncluded")}
                  </s-text>
                  <s-text accessibilityVisibility="hidden">
                    {planHasFeature(plan.key, feature) ? "✓" : "—"}
                  </s-text>
                </s-table-cell>
              ))}
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-section>
  );
}

function AdvisorPlaceholder() {
  const { t } = useTranslation();
  return (
    <s-section heading={t("plans.advisorSoon.heading")}>
      <s-paragraph color="subdued">{t("plans.advisorSoon.body")}</s-paragraph>
    </s-section>
  );
}
