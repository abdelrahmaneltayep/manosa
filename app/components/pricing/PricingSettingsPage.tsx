import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";

import type { PricingSettingsView } from "~/components/pricing/types";

export function PricingSettingsPage({ view }: { view: PricingSettingsView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("pricing.settings.heading")}>
      {view.orderSaved ? (
        <s-section>
          <s-banner tone="success">
            <s-paragraph>{t("pricing.settings.orderSaved")}</s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      <OrderSection view={view} />
      <ExplainSection view={view} />
    </s-page>
  );
}

function OrderSection({ view }: { view: PricingSettingsView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("pricing.settings.orderHeading")}>
      <s-stack direction="block" gap="base">
        <s-paragraph color="subdued">{t("pricing.settings.orderBody")}</s-paragraph>

        {view.anyCombinable ? (
          <s-banner tone="warning">
            <s-paragraph>{t("pricing.settings.combinationWarning")}</s-paragraph>
          </s-banner>
        ) : null}

        <form method="post">
          <input type="hidden" name="intent" value="reorder" />
          <s-ordered-list>
            {view.order.map((rule, index) => (
              <s-list-item key={rule.id}>
                <s-stack direction="inline" gap="small" alignItems="center">
                  <input type="hidden" name="order" value={rule.id} />
                  <s-text type="strong">{rule.name}</s-text>
                  <s-badge>{t(`pricing.kind.${rule.kind}`)}</s-badge>
                  {rule.combinable ? (
                    <s-badge tone="info">{t("pricing.builder.combinableLabel")}</s-badge>
                  ) : null}
                  {/* Buttons as well as drag: reordering has to be reachable
                      from a keyboard, and merchants approve rules on phones. */}
                  <s-button
                    type="submit"
                    variant="tertiary"
                    {...whenDisabled(index === 0)}
                    href={`?move=${rule.id}&direction=up`}
                  >
                    {t("pricing.settings.moveUp")}
                  </s-button>
                  <s-button
                    type="submit"
                    variant="tertiary"
                    {...whenDisabled(index === view.order.length - 1)}
                    href={`?move=${rule.id}&direction=down`}
                  >
                    {t("pricing.settings.moveDown")}
                  </s-button>
                </s-stack>
              </s-list-item>
            ))}
          </s-ordered-list>

          <s-button type="submit" variant="primary">
            {t("pricing.settings.saveOrder")}
          </s-button>
        </form>
      </s-stack>
    </s-section>
  );
}

/**
 * "Why this price?" — the conflict explainer from spec §2.
 *
 * It runs the real engine over the real rules and prints its trace, so the
 * answer here is the answer at checkout. Every non-applied rule says why, which
 * is what turns "the price looks wrong" into a two-minute conversation.
 */
function ExplainSection({ view }: { view: PricingSettingsView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("pricing.settings.explainHeading")}>
      <s-stack direction="block" gap="base">
        <s-paragraph color="subdued">{t("pricing.settings.explainBody")}</s-paragraph>

        <form method="post">
          <input type="hidden" name="intent" value="explain" />
          <s-stack direction="inline" gap="small">
            <s-text-field
              name="variantId"
              label={t("pricing.settings.explainVariant")}
              value={view.explainInput.variantId}
            />
            <s-text-field
              name="tags"
              label={t("pricing.settings.explainTags")}
              value={view.explainInput.tags}
            />
            <s-number-field
              name="quantity"
              label={t("pricing.settings.explainQuantity")}
              value={view.explainInput.quantity}
              min={1}
            />
            <s-text-field
              name="price"
              label={t("pricing.settings.explainPrice")}
              value={view.explainInput.price}
            />
            <s-button type="submit">{t("pricing.settings.explainRun")}</s-button>
          </s-stack>
        </form>

        {view.explain ? <ExplainResult view={view} /> : null}
      </s-stack>
    </s-section>
  );
}

function ExplainResult({ view }: { view: PricingSettingsView }) {
  const { t } = useTranslation();
  const explain = view.explain!;

  return (
    <s-stack direction="block" gap="base">
      <s-heading>
        {t("pricing.settings.explainResult", { price: explain.unitPrice })}
      </s-heading>

      {explain.clampedAtZero ? (
        <s-banner tone="warning">
          <s-paragraph>{t("pricing.settings.explainClamped")}</s-paragraph>
        </s-banner>
      ) : null}

      {explain.trace.length === 0 ? (
        <s-paragraph color="subdued">{t("pricing.settings.explainNoRules")}</s-paragraph>
      ) : (
        <s-table>
          <s-table-header-row>
            <s-table-header>{t("pricing.list.colName")}</s-table-header>
            <s-table-header>{t("pricing.list.colStatus")}</s-table-header>
            <s-table-header>{t("pricing.settings.explainPrice")}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {explain.trace.map((row) => (
              <s-table-row key={row.ruleId}>
                <s-table-cell>{row.ruleName}</s-table-cell>
                <s-table-cell>
                  {row.applied ? (
                    <s-badge tone="success">
                      {t("pricing.settings.explainApplied")}
                    </s-badge>
                  ) : (
                    <s-stack direction="block" gap="small-500">
                      <s-badge tone="neutral">
                        {t("pricing.settings.explainSkipped")}
                      </s-badge>
                      {/* Never a bare "not applied": the reason is the answer
                          the merchant came for. */}
                      <s-text color="subdued">
                        {row.reason ? t(`pricing.reason.${row.reason}`) : ""}
                      </s-text>
                    </s-stack>
                  )}
                </s-table-cell>
                <s-table-cell>
                  <s-text fontVariantNumeric="tabular-nums">
                    {row.priceAfter ?? "—"}
                  </s-text>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      )}
    </s-stack>
  );
}
