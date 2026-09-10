import { useTranslation } from "react-i18next";

import { whenChecked, whenDisabled } from "~/components/boolean-attribute";
import type { GuardrailsView, PublishView } from "~/components/agent/types";
import { AgentTabs } from "~/components/agent/AgentTabs";

/**
 * What the agent may do, and whether it is live.
 *
 * One screen for both because they are one decision: a merchant who is about
 * to put a concierge in front of their buyers wants the switches and the
 * "is it on" in the same field of view, not a settings page and a publish page
 * that can disagree.
 */
export function GuardrailsPage({ view }: { view: GuardrailsView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("agent.heading")}>
      <s-section>
        <AgentTabs current="guardrails" />
        <s-paragraph>{t("agent.description")}</s-paragraph>
      </s-section>

      {view.entitled ? null : <Locked view={view} />}

      <Publish view={view} />

      <form method="post">
        <input type="hidden" name="intent" value="save" />

        {/* The navigation that loses the work is on this page: the tabs sit
            above the form, so "type an off-limits subject, click Test mode to
            try it" would discard it silently. */}
        <ui-save-bar id="agent-guardrails-save-bar">
          <button type="submit" variant="primary" />
          <button type="reset" />
        </ui-save-bar>

        <Abilities view={view} />
        <Tone view={view} />
        <Instructions view={view} />
        <OffLimits view={view} />

        <s-section>
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-button variant="primary" type="submit" {...whenDisabled(!view.entitled)}>
              {t("agent.save")}
            </s-button>
            {view.saved ? <s-badge tone="success">{t("agent.saved")}</s-badge> : null}
          </s-stack>
        </s-section>
      </form>

      <Review view={view} />
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function Locked({ view }: { view: GuardrailsView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-banner tone="info">
        <s-heading>{t("agent.locked.heading")}</s-heading>
        {/* Features pause, data is never deleted: an agent that was live stays
            unpublished rather than losing its guardrails. */}
        <s-paragraph>{t("agent.locked.body", { plan: view.requiredPlan })}</s-paragraph>
        <s-button href="/app/plans">{t("agent.locked.action")}</s-button>
      </s-banner>
    </s-section>
  );
}

function Publish({ view }: { view: GuardrailsView }) {
  const { t } = useTranslation();
  const publish = view.publish;

  if (publish.published) return <Live publish={publish} entitled={view.entitled} />;

  return (
    <s-section heading={t("agent.publish.heading")}>
      <s-stack direction="block" gap="base">
        <s-paragraph color="subdued">{t("agent.publish.body")}</s-paragraph>

        {publish.refused.length > 0 ? (
          <s-banner tone="critical">
            <s-heading>{t("agent.publish.refusedHeading")}</s-heading>
            <s-paragraph>
              {t("agent.publish.refusedBody", {
                steps: publish.refused
                  .map((step) => t(`agent.publish.step.${step}`))
                  .join(", "),
              })}
            </s-paragraph>
          </s-banner>
        ) : null}

        <s-unordered-list>
          {publish.items.map((item) => (
            <s-list-item key={item.step}>
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-badge tone={item.done ? "success" : "neutral"}>
                  {t(item.done ? "agent.publish.done" : "agent.publish.todo")}
                </s-badge>
                <s-text>{t(`agent.publish.step.${item.step}`)}</s-text>
                {item.done ? null : (
                  <s-link href={item.href}>{t("agent.publish.doIt")}</s-link>
                )}
              </s-stack>
            </s-list-item>
          ))}
        </s-unordered-list>

        <form method="post">
          <input type="hidden" name="intent" value="publish" />
          <s-button
            variant="primary"
            type="submit"
            {...whenDisabled(!publish.ready || !view.entitled)}
          >
            {t("agent.publish.action")}
          </s-button>
        </form>

        {publish.ready ? null : (
          <s-paragraph color="subdued">{t("agent.publish.notReady")}</s-paragraph>
        )}
      </s-stack>
    </s-section>
  );
}

function Live({ publish, entitled }: { publish: PublishView; entitled: boolean }) {
  const { t } = useTranslation();

  // Our switch is on. Whether a buyer can actually reach it depends on a theme
  // app embed the merchant turns on in the theme editor, and this app has no
  // scope to read a theme — only the App Proxy, which a live embed calls.
  const reaching = publish.embedLive || publish.embedAttested;

  return (
    <s-section heading={t("agent.publish.heading")}>
      <s-stack direction="block" gap="base">
        <s-banner tone={reaching ? "success" : "warning"}>
          <s-heading>
            {t(
              publish.justPublished
                ? "agent.publish.confirmedHeading"
                : "agent.publish.liveHeading",
            )}
          </s-heading>
          <s-paragraph>
            {t(reaching ? "agent.publish.liveBody" : "agent.publish.embedUnknown")}
          </s-paragraph>
          {publish.embedLive ? null : (
            <s-paragraph color="subdued">
              {t(
                publish.embedAttested
                  ? "agent.publish.embedAttested"
                  : "agent.publish.embedHow",
              )}
            </s-paragraph>
          )}
          {publish.storefrontUrl ? (
            <s-link href={publish.storefrontUrl} target="_blank">
              {t("agent.publish.visit")}
            </s-link>
          ) : (
            <s-paragraph color="subdued">{t("agent.publish.noDomain")}</s-paragraph>
          )}
        </s-banner>

        {/* One click, no dialog. A merchant switching this off is usually
            doing it because something is wrong, and a confirmation is a
            sentence they read while it is still talking to their buyers. */}
        <form method="post">
          <input type="hidden" name="intent" value="unpublish" />
          <s-button type="submit" {...whenDisabled(!entitled)}>
            {t("agent.publish.unpublish")}
          </s-button>
        </form>
      </s-stack>
    </s-section>
  );
}

/* -------------------------------------------------------------------------- */

function Abilities({ view }: { view: GuardrailsView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("agent.abilities.heading")}>
      <s-stack direction="block" gap="base">
        <s-paragraph color="subdued">{t("agent.abilities.body")}</s-paragraph>

        {view.abilities.map((ability) => (
          <s-checkbox
            key={ability.key}
            name={ability.key}
            value="1"
            label={t(`agent.abilities.${ability.key}`)}
            details={t(`agent.abilities.${ability.key}Help`)}
            {...whenChecked(ability.on)}
            {...whenDisabled(!view.entitled)}
          />
        ))}

        <s-checkbox
          name="guestMode"
          value="1"
          label={t("agent.guestMode.label")}
          details={t("agent.guestMode.help")}
          {...whenChecked(view.guestMode)}
          {...whenDisabled(!view.entitled)}
        />

        {/* The checklist asks for this to be stated, and it is true: a turn
            reads the guardrails when it starts, so a conversation already in
            flight finishes under the rules it began with. */}
        <s-paragraph color="subdued">{t("agent.abilities.note")}</s-paragraph>
      </s-stack>
    </s-section>
  );
}

function Tone({ view }: { view: GuardrailsView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("agent.tone.heading")}>
      <s-select
        name="tone"
        label={t("agent.tone.label")}
        value={view.tone}
        {...whenDisabled(!view.entitled)}
      >
        {view.tones.map((tone) => (
          <s-option key={tone} value={tone}>
            {t(`agent.tone.${tone}`)}
          </s-option>
        ))}
      </s-select>
    </s-section>
  );
}

function Instructions({ view }: { view: GuardrailsView }) {
  const { t } = useTranslation();
  const tooLong = view.error?.field === "customInstructions";

  return (
    <s-section heading={t("agent.instructions.heading")}>
      <s-stack direction="block" gap="base">
        <s-text-area
          name="customInstructions"
          label={t("agent.instructions.label")}
          details={t("agent.instructions.help", { max: view.maxWords })}
          value={view.customInstructions}
          rows={5}
          {...whenDisabled(!view.entitled)}
          {...(tooLong
            ? { error: t("agent.instructions.tooLong", { max: view.maxWords }) }
            : {})}
        />

        <s-text color="subdued">
          {t("agent.instructions.count", {
            count: view.words,
            max: view.maxWords,
          })}
        </s-text>

        {view.warnings.length > 0 ? (
          <s-banner tone="warning">
            <s-heading>{t("agent.instructions.warningsHeading")}</s-heading>
            <s-unordered-list>
              {view.warnings.map((warning) => (
                <s-list-item key={`${warning.key}:${warning.phrase}`}>
                  {t("agent.instructions.warning", {
                    phrase: warning.phrase,
                    reason: t(warning.key),
                  })}
                </s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        ) : null}
      </s-stack>
    </s-section>
  );
}

function OffLimits({ view }: { view: GuardrailsView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("agent.offLimits.heading")}>
      <s-text-area
        name="offLimits"
        label={t("agent.offLimits.label")}
        details={t("agent.offLimits.help")}
        value={view.offLimits.join("\n")}
        rows={4}
        {...whenDisabled(!view.entitled)}
      />
    </s-section>
  );
}

/**
 * "I have read these."
 *
 * Its own form, deliberately separate from Save: the pre-publish checklist
 * asks whether the merchant reviewed the guardrails, and a box that ticks
 * itself every time somebody presses Save answers a different question.
 */
function Review({ view }: { view: GuardrailsView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("agent.review.heading")}>
      <s-stack direction="block" gap="small">
        <s-paragraph color="subdued">{t("agent.review.help")}</s-paragraph>
        {view.reviewed ? (
          <s-badge tone="success">{t("agent.review.done")}</s-badge>
        ) : (
          <form method="post">
            <input type="hidden" name="intent" value="review" />
            <s-button type="submit" {...whenDisabled(!view.entitled)}>
              {t("agent.review.action")}
            </s-button>
          </form>
        )}
      </s-stack>
    </s-section>
  );
}
