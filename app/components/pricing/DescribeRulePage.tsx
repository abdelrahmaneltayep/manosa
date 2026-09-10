import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";
import type {
  ClarificationView,
  DescribeRuleView,
  DraftCardView,
  MarginGuardView,
} from "~/components/pricing/types";

/**
 * ✦ Describe a rule — checklist §2.
 *
 * Composing → draft for review → approve, edit or discard. The card is a
 * proposal, not a saved rule: nothing here has touched the merchant's pricing,
 * and the only button that will is the one that records who pressed it.
 *
 * Every state has the manual builder next to it. With no key the composer is
 * off and says why; with a failed call the draft is gone and the builder is a
 * click away. A merchant must never be stuck behind a model that is down.
 */
export function DescribeRulePage({ view }: { view: DescribeRuleView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("describe.heading")}>
      <Composer view={view} />
      {view.draft ? <Draft view={view} draft={view.draft} /> : null}
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function Composer({ view }: { view: DescribeRuleView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("describe.composerHeading")}>
      <s-stack direction="block" gap="base">
        {view.aiAvailable ? null : (
          <s-banner tone="info">
            <s-heading>{t("describe.offHeading")}</s-heading>
            <s-paragraph>{t("describe.offBody")}</s-paragraph>
            <s-button href="/app/pricing/new">{t("describe.buildManually")}</s-button>
          </s-banner>
        )}

        {view.failure ? <Failure view={view} /> : null}

        {view.atRuleLimit ? (
          <s-banner tone="warning">
            <s-heading>{t("describe.atLimitHeading")}</s-heading>
            <s-paragraph>{t("describe.atLimitBody")}</s-paragraph>
            <s-button href="/app/plans?from=pricing">{t("describe.seePlans")}</s-button>
          </s-banner>
        ) : null}

        <form method="post">
          <input type="hidden" name="intent" value="draft" />
          <s-stack direction="block" gap="small">
            <s-text-area
              name="sentence"
              rows={3}
              label={t("describe.sentenceLabel")}
              details={t("describe.sentenceHelp")}
              value={view.sentence}
              {...whenDisabled(!view.aiAvailable)}
            />
            <s-stack direction="inline" gap="small">
              <s-button
                type="submit"
                variant="primary"
                {...whenDisabled(!view.aiAvailable)}
              >
                {t("describe.draftAction")}
              </s-button>
              <s-button href="/app/pricing/new">{t("describe.buildManually")}</s-button>
            </s-stack>
          </s-stack>
        </form>

        <s-stack direction="block" gap="small-100">
          <s-text color="subdued">{t("describe.examplesHeading")}</s-text>
          {view.examples.map((example) => (
            <s-text key={example} color="subdued">
              “{example}”
            </s-text>
          ))}
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function Failure({ view }: { view: DescribeRuleView }) {
  const { t } = useTranslation();
  if (!view.failure) return null;

  return (
    <s-banner tone="warning">
      <s-heading>{t(`describe.failure.${view.failure}.heading`)}</s-heading>
      <s-paragraph>{t(`describe.failure.${view.failure}.body`)}</s-paragraph>
      <s-button href="/app/pricing/new">{t("describe.buildManually")}</s-button>
    </s-banner>
  );
}

/* -------------------------------------------------------------------------- */

function Draft({ view, draft }: { view: DescribeRuleView; draft: DraftCardView }) {
  const { t } = useTranslation();
  const blocked = view.clarifications.length > 0;

  return (
    <s-section heading={t("describe.draftHeading")}>
      <s-stack direction="block" gap="base">
        <s-banner tone="info">
          <s-paragraph>{t("describe.draftIntro")}</s-paragraph>
        </s-banner>

        <s-stack direction="block" gap="small">
          <s-heading>{draft.name}</s-heading>
          <s-stack direction="inline" gap="small-100">
            <s-badge tone="info">{draft.kindLabel}</s-badge>
            {draft.chips.map((chip) => (
              <s-badge key={chip} tone="neutral">
                {chip}
              </s-badge>
            ))}
          </s-stack>
          <s-text>{t("describe.appliesTo", { targets: draft.targetsSummary })}</s-text>
          <s-text>{t("describe.audience", { audience: draft.audienceSummary })}</s-text>
          {draft.scheduleSummary ? (
            <s-text>{t("describe.schedule", { schedule: draft.scheduleSummary })}</s-text>
          ) : null}
          <s-text>
            {t(draft.combinable ? "describe.combinable" : "describe.notCombinable")}
          </s-text>
        </s-stack>

        {draft.notes ? (
          <s-stack direction="block" gap="small-100">
            <s-text color="subdued">{t("describe.notesHeading")}</s-text>
            <s-paragraph color="subdued">{draft.notes}</s-paragraph>
          </s-stack>
        ) : null}

        {blocked ? <Clarifications view={view} draft={draft} /> : null}
        {view.margin ? <MarginGuard margin={view.margin} /> : null}

        <Actions view={view} draft={draft} blocked={blocked} />
      </s-stack>
    </s-section>
  );
}

function Clarifications({
  view,
  draft,
}: {
  view: DescribeRuleView;
  draft: DraftCardView;
}) {
  const { t } = useTranslation();

  return (
    <s-stack direction="block" gap="small">
      <s-banner tone="warning">
        <s-heading>{t("describe.clarifyHeading")}</s-heading>
        <s-paragraph>{t("describe.clarifyBody")}</s-paragraph>
      </s-banner>

      {view.clarifications.map((clarification) => (
        <Clarification
          key={clarification.key}
          clarification={clarification}
          draft={draft}
        />
      ))}
    </s-stack>
  );
}

function Clarification({
  clarification,
  draft,
}: {
  clarification: ClarificationView;
  draft: DraftCardView;
}) {
  const { t } = useTranslation();

  return (
    <s-stack direction="block" gap="small-100">
      <s-text>
        {t(
          clarification.options.length > 0 ? "describe.whichOne" : "describe.noSuchThing",
          { term: clarification.term },
        )}
      </s-text>
      <s-stack direction="inline" gap="small-100">
        {clarification.options.map((option) => (
          <form key={option.id} method="post">
            <input type="hidden" name="intent" value="answer" />
            <input type="hidden" name="draft" value={draft.payload} />
            <input type="hidden" name="term" value={clarification.term} />
            <input type="hidden" name="choice" value={option.id} />
            <s-button type="submit">{option.label}</s-button>
          </form>
        ))}
      </s-stack>
    </s-stack>
  );
}

function MarginGuard({ margin }: { margin: MarginGuardView }) {
  const { t } = useTranslation();

  if (margin.status === "unavailable") {
    return (
      <s-banner tone="warning">
        <s-heading>{t("describe.margin.unavailableHeading")}</s-heading>
        <s-paragraph>{t("describe.margin.unavailableBody")}</s-paragraph>
      </s-banner>
    );
  }

  if (margin.belowCostCount === 0) {
    return (
      <s-banner tone="success">
        <s-heading>{t("describe.margin.clearHeading")}</s-heading>
        <s-paragraph>
          {t("describe.margin.clearBody", { count: margin.checked })}
        </s-paragraph>
        {margin.costUnknown > 0 ? (
          <s-paragraph>
            {t("describe.margin.costUnknown", { count: margin.costUnknown })}
          </s-paragraph>
        ) : null}
        {margin.sampled ? (
          <s-paragraph>{t("describe.margin.sampled")}</s-paragraph>
        ) : null}
      </s-banner>
    );
  }

  return (
    <s-banner tone="critical">
      <s-heading>
        {t("describe.margin.belowCostHeading", { count: margin.belowCostCount })}
      </s-heading>
      <s-stack direction="block" gap="small-100">
        {margin.worst.map((finding) => (
          <s-text key={finding.label}>
            {t("describe.margin.belowCostRow", {
              sku: finding.label,
              quantity: finding.quantity,
              price: finding.unitPrice,
              cost: finding.unitCost,
            })}
          </s-text>
        ))}
        {margin.costUnknown > 0 ? (
          <s-text>
            {t("describe.margin.costUnknown", { count: margin.costUnknown })}
          </s-text>
        ) : null}
        {margin.sampled ? <s-text>{t("describe.margin.sampled")}</s-text> : null}
      </s-stack>
    </s-banner>
  );
}

function Actions({
  view,
  draft,
  blocked,
}: {
  view: DescribeRuleView;
  draft: DraftCardView;
  blocked: boolean;
}) {
  const { t } = useTranslation();

  return (
    <s-stack direction="block" gap="small">
      {view.approveAnywayMissing ? (
        <s-banner tone="critical">
          <s-heading>{t("describe.confirmMissingHeading")}</s-heading>
          <s-paragraph>{t("describe.confirmMissingBody")}</s-paragraph>
        </s-banner>
      ) : null}

      <form method="post">
        <input type="hidden" name="intent" value="approve" />
        <input type="hidden" name="draft" value={draft.payload} />
        <s-stack direction="block" gap="small">
          {view.approveAnywayRequired ? (
            <s-checkbox
              name="approveAnyway"
              value="1"
              label={t("describe.approveAnywayLabel")}
              details={t("describe.approveAnywayHelp")}
            />
          ) : null}
          <s-stack direction="inline" gap="small">
            <s-button
              type="submit"
              variant="primary"
              {...whenDisabled(blocked || view.atRuleLimit)}
            >
              {t("describe.approveAction")}
            </s-button>
          </s-stack>
        </s-stack>
      </form>

      <s-stack direction="inline" gap="small">
        {/* Edit hands the draft to the manual builder, filled in. The builder
            is the only rule editor — a second one on this card would be a
            second place for validation to disagree with itself. */}
        <form method="post" action="/app/pricing/new">
          <input type="hidden" name="intent" value="prefill" />
          {draft.builderFields.map((field, index) => (
            <input
              key={`${field.name}-${index}`}
              type="hidden"
              name={field.name}
              value={field.value}
            />
          ))}
          <s-button type="submit">{t("describe.editAction")}</s-button>
        </form>

        <form method="post">
          <input type="hidden" name="intent" value="discard" />
          <s-button type="submit" tone="critical">
            {t("describe.discardAction")}
          </s-button>
        </form>
      </s-stack>
    </s-stack>
  );
}
