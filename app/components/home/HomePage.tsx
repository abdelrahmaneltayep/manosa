import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";
import type { AskView, BriefingView, HomeView } from "~/components/home/types";

/**
 * Home — checklist §1's ✦ surfaces.
 *
 * The briefing decides nothing and claims nothing: every figure on it was
 * recomputed for this render, and every item is one click from the page that
 * proves it. The Ask bar answers questions and hands over links; it has no path
 * to a write, which is why "delete all my rules" can only ever open the page
 * where the merchant does that themselves.
 */
export function HomePage({ view }: { view: HomeView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("home.heading", { shop: view.shopName })}>
      <Briefing view={view.briefing} />
      <Ask view={view.ask} />
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function Briefing({ view }: { view: BriefingView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("home.briefing.heading")}>
      <s-stack direction="block" gap="base">
        <Header view={view} />

        {view.status === "loading" ? (
          // Three lines, so the card does not change height when they arrive.
          <s-stack direction="block" gap="small-100">
            <s-text color="subdued">{t("home.briefing.loading")}</s-text>
            <s-text color="subdued">···</s-text>
            <s-text color="subdued">···</s-text>
          </s-stack>
        ) : null}

        {view.items.map((item) => (
          <s-box
            key={item.kind}
            padding="base"
            borderWidth="base"
            borderStyle="solid"
            borderColor="base"
            borderRadius="base"
          >
            <s-stack direction="block" gap="small-100">
              <s-stack direction="inline" gap="small" alignItems="center">
                {/* Our number, not the agent's. */}
                <s-text type="strong">{item.figure}</s-text>
                <s-text>{item.reason}</s-text>
              </s-stack>
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-button href={item.href}>{t(item.actionKey)}</s-button>
                <form method="post">
                  <input type="hidden" name="intent" value="mute" />
                  <input type="hidden" name="kind" value={item.kind} />
                  <s-button type="submit" variant="tertiary">
                    {t("home.briefing.mute")}
                  </s-button>
                </form>
              </s-stack>
            </s-stack>
          </s-box>
        ))}
      </s-stack>
    </s-section>
  );
}

function Header({ view }: { view: BriefingView }) {
  const { t } = useTranslation();

  if (view.status === "off") {
    return (
      <s-banner tone="info">
        <s-heading>{t("home.briefing.offHeading")}</s-heading>
        <s-paragraph>{t("home.briefing.offBody")}</s-paragraph>
      </s-banner>
    );
  }

  if (view.status === "empty") {
    return (
      <s-banner tone="info">
        <s-heading>{t("home.briefing.emptyHeading")}</s-heading>
        <s-paragraph>{t("home.briefing.emptyBody")}</s-paragraph>
        <s-unordered-list>
          <s-list-item>{t("home.briefing.willWatch1")}</s-list-item>
          <s-list-item>{t("home.briefing.willWatch2")}</s-list-item>
        </s-unordered-list>
      </s-banner>
    );
  }

  if (view.status === "quiet") {
    return (
      <s-banner tone="success">
        <s-heading>{t("home.briefing.quietHeading")}</s-heading>
        <s-paragraph>{t("home.briefing.quietBody")}</s-paragraph>
      </s-banner>
    );
  }

  if (view.status === "unavailable") {
    return (
      <s-banner tone="warning">
        <s-heading>{t("home.briefing.unavailableHeading")}</s-heading>
        <s-paragraph>
          {t(
            view.items.length > 0
              ? "home.briefing.unavailableWithOld"
              : "home.briefing.unavailableAlone",
          )}
        </s-paragraph>
      </s-banner>
    );
  }

  if (view.stale && view.writtenAt) {
    return (
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-badge tone="warning">
          {t("home.briefing.stale", { when: view.writtenAt.slice(0, 10) })}
        </s-badge>
      </s-stack>
    );
  }

  return null;
}

/* -------------------------------------------------------------------------- */

function Ask({ view }: { view: AskView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("home.ask.heading")}>
      <s-stack direction="block" gap="base">
        {view.available ? null : (
          <s-banner tone="info">
            <s-heading>{t("home.ask.offHeading")}</s-heading>
            <s-paragraph>{t("home.ask.offBody")}</s-paragraph>
          </s-banner>
        )}

        <form method="post">
          <input type="hidden" name="intent" value="ask" />
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-text-field
              name="question"
              label={t("home.ask.label")}
              placeholder={view.examples[0] ?? ""}
              value={view.question}
              {...whenDisabled(!view.available)}
            />
            <s-button type="submit" variant="primary" {...whenDisabled(!view.available)}>
              {t("home.ask.action")}
            </s-button>
          </s-stack>
        </form>

        <s-stack direction="block" gap="small-100">
          <s-text color="subdued">{t("home.ask.examplesHeading")}</s-text>
          {view.examples.map((example) => (
            <s-text key={example} color="subdued">
              “{example}”
            </s-text>
          ))}
        </s-stack>

        <AskFailure view={view} />
        <AskResult view={view} />
      </s-stack>
    </s-section>
  );
}

function AskFailure({ view }: { view: AskView }) {
  const { t } = useTranslation();
  if (!view.failure) return null;

  if (view.failure === "rate_limited") {
    return (
      <s-banner tone="warning">
        <s-heading>{t("home.ask.failure.rate_limited.heading")}</s-heading>
        <s-paragraph>
          {t("home.ask.failure.rate_limited.body", {
            count: view.cooldownSeconds ?? 30,
          })}
        </s-paragraph>
      </s-banner>
    );
  }

  const unparseable = view.failure === "invalid_output" || view.failure === "refused";

  return (
    <s-banner tone="warning">
      <s-heading>{t(`home.ask.failure.${view.failure}.heading`)}</s-heading>
      <s-paragraph>{t(`home.ask.failure.${view.failure}.body`)}</s-paragraph>
      {/* The checklist's three reformulations — ours, not the model's, because
          the model is the thing that just failed. */}
      {unparseable && view.reformulations.length > 0 ? (
        <s-unordered-list>
          {view.reformulations.map((example) => (
            <s-list-item key={example}>{example}</s-list-item>
          ))}
        </s-unordered-list>
      ) : null}
    </s-banner>
  );
}

function AskResult({ view }: { view: AskView }) {
  const { t } = useTranslation();
  if (!view.result) return null;

  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderStyle="solid"
      borderColor="base"
      borderRadius="base"
    >
      <s-stack direction="block" gap="small">
        <s-heading>{view.result.headline}</s-heading>
        {view.result.rows.length > 0 ? (
          <s-unordered-list>
            {view.result.rows.map((row) => (
              <s-list-item key={row.label}>
                {row.detail ? `${row.label} — ${row.detail}` : row.label}
              </s-list-item>
            ))}
          </s-unordered-list>
        ) : null}
        <s-button href={view.result.href}>
          {t(view.result.isBuilder ? "home.ask.take-me" : "home.ask.seeAll")}
        </s-button>
        {view.result.isBuilder ? (
          // The one promise this bar makes: it never did the thing.
          <s-text color="subdued">{t("home.ask.builderNote")}</s-text>
        ) : null}
      </s-stack>
    </s-box>
  );
}
