import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";
import { CHART_HEADING, type AskView } from "~/components/analytics/types";

/**
 * ✦ Ask your data.
 *
 * Every answer carries two things the checklist asks for and one this app
 * insists on: the chart it came from, a link that reproduces it, and — when the
 * chart could not answer — the charts that could. There is no answer on this
 * screen without a citation, because an unciteable figure is one a merchant
 * cannot check.
 */
export function AskBar({ view }: { view: AskView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("ask.heading")}>
      <s-stack direction="block" gap="base">
        <s-paragraph color="subdued">{t("ask.body")}</s-paragraph>

        {view.locked ? (
          <s-banner tone="info">
            <s-paragraph>
              {view.locked === "plan"
                ? t("ask.lockedPlan", { plan: view.requiredPlan })
                : t("ask.lockedNoKey")}
            </s-paragraph>
            {view.locked === "plan" ? (
              <s-button href="/app/plans">{t("plans.seePlans")}</s-button>
            ) : null}
          </s-banner>
        ) : null}

        <form method="post">
          <input type="hidden" name="intent" value="ask" />
          <s-stack direction="block" gap="small">
            <s-text-field
              name="question"
              label={t("ask.label")}
              details={t("ask.help")}
              value={view.question}
              {...whenDisabled(!view.available)}
            />
            <s-button
              variant="primary"
              type="submit"
              {...whenDisabled(!view.available || view.pending)}
            >
              {t(view.pending ? "ask.asking" : "ask.action")}
            </s-button>
            {/* Two sequential model calls, each with a timeout and a retry — up
                to about eighty seconds. With no loading state the page was
                byte-identical to before the click and the button still live,
                so the obvious thing to do was click again. */}
            {view.pending ? (
              <s-text color="subdued">{t("ask.pendingHelp")}</s-text>
            ) : null}
          </s-stack>
        </form>

        {view.reply ? (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-paragraph>{view.reply}</s-paragraph>
              {/* The citation and the link that reproduces it. Never one
                  without the other: a chart named but not reachable is still
                  a figure the merchant has to take on trust. */}
              {view.chart && view.href ? (
                <s-text color="subdued">
                  {t("ask.from", { chart: t(CHART_HEADING[view.chart]) })}{" "}
                  <s-link href={view.href}>{t("ask.show")}</s-link>
                </s-text>
              ) : null}
            </s-stack>
          </s-box>
        ) : null}

        {view.insteadTry.length > 0 ? (
          <s-banner tone="info">
            {/* "No-data answer offers what *can* be answered." */}
            <s-paragraph>{t("ask.noData")}</s-paragraph>
            <s-unordered-list>
              {view.insteadTry.map((chart) => (
                <s-list-item key={chart}>{t(CHART_HEADING[chart])}</s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        ) : null}

        {view.nothingToAnswer ? (
          <s-banner tone="info">
            {/* "Offer what can be answered" has no branch when nothing can. */}
            <s-paragraph>{t("ask.nothingYet")}</s-paragraph>
          </s-banner>
        ) : null}

        {view.failure ? (
          <s-banner tone="warning">
            <s-paragraph>{t(`agent.failure.${view.failure}`)}</s-paragraph>
          </s-banner>
        ) : null}
      </s-stack>
    </s-section>
  );
}
