import { useTranslation } from "react-i18next";

import { AgentTabs } from "~/components/agent/AgentTabs";
import { whenDisabled } from "~/components/boolean-attribute";
import type { TranscriptTurnView, TranscriptView } from "~/components/agent/types";

/**
 * One conversation, both halves.
 *
 * What the buyer read, and beside it what the agent was doing — which tool
 * ran, which facts it was given, and why it refused when it did. A turn nobody
 * could answer shows as exactly that rather than being left out, which is the
 * only way this screen is worth reading.
 */
export function TranscriptPage({ view }: { view: TranscriptView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("agent.transcript.heading", { buyer: view.buyer })}>
      <s-section>
        <AgentTabs current="log" />
        <s-link href="/app/storefront-agent/log">{t("agent.transcript.back")}</s-link>
      </s-section>

      {view.testMode ? (
        <s-section>
          <s-banner tone="info">
            <s-heading>{t("agent.test.watermark")}</s-heading>
            <s-paragraph>{t("agent.transcript.testBody")}</s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      <s-section>
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-badge>{t(`agent.outcome.${view.outcome}`)}</s-badge>
          <s-text color="subdued">
            {t("agent.transcript.started", { when: view.startedAt })}
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading={t("agent.transcript.turnsHeading")}>
        <s-stack direction="block" gap="base">
          {view.turns.length === 0 ? (
            <s-paragraph color="subdued">{t("agent.transcript.noTurns")}</s-paragraph>
          ) : (
            view.turns.map((turn) => <Turn key={turn.id} turn={turn} />)
          )}
        </s-stack>
      </s-section>

      <TakeOver view={view} />
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function Turn({ turn }: { turn: TranscriptTurnView }) {
  const { t } = useTranslation();

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-badge tone={turn.role === "MERCHANT" ? "success" : "neutral"}>
            {t(`agent.transcript.role.${turn.role}`)}
          </s-badge>
          <s-text color="subdued">{turn.when}</s-text>
        </s-stack>

        {turn.joined ? (
          // The row that says a person joined. Checked *before* the empty-text
          // branch: this used to be stored with no text, so the one row that
          // exists to say "a person joined here" read as "the agent couldn't
          // answer this one".
          <s-paragraph>{t("agent.transcript.joined")}</s-paragraph>
        ) : turn.text === "" ? (
          // Invariant 4 on the one screen that decides whether a merchant
          // trusts this: a turn that produced nothing says so.
          <s-paragraph color="subdued">{t("agent.transcript.emptyTurn")}</s-paragraph>
        ) : (
          <s-paragraph>{turn.text}</s-paragraph>
        )}

        {turn.refusal && !turn.joined ? (
          <s-text color="subdued">
            {t("agent.transcript.refusal", { reason: turn.refusalLabel })}
          </s-text>
        ) : null}

        {turn.tool ? (
          <s-text color="subdued">
            {t("agent.transcript.tool", { tool: t(`agent.tool.${turn.tool}`) })}
          </s-text>
        ) : null}

        {turn.facts.length > 0 ? (
          <s-text color="subdued">
            {t("agent.transcript.facts", { facts: turn.facts.join(" · ") })}
          </s-text>
        ) : null}
      </s-stack>
    </s-box>
  );
}

/**
 * A person joins.
 *
 * Taking over is one press and it is not undoable by design: the agent has
 * announced a human in the buyer's thread, and "actually, never mind" would
 * mean a buyer who was told a person had joined going back to talking to a
 * model. So the button confirms, and the reply box below it takes over on its
 * own — replying *is* taking over, whether or not the button was used first.
 */
function TakeOver({ view }: { view: TranscriptView }) {
  const { t } = useTranslation();

  if (view.testMode) {
    return (
      <s-section heading={t("agent.transcript.takeOverHeading")}>
        <s-paragraph color="subdued">{t("agent.transcript.testNoTakeOver")}</s-paragraph>
      </s-section>
    );
  }

  return (
    <s-section heading={t("agent.transcript.takeOverHeading")}>
      <s-stack direction="block" gap="base">
        {view.takenOver ? (
          <s-banner tone="info">
            <s-paragraph>
              {t("agent.transcript.takenOver", { when: view.takenOverWhen ?? "" })}
            </s-paragraph>
          </s-banner>
        ) : (
          <form method="post">
            <input type="hidden" name="intent" value="takeOver" />
            <s-stack direction="block" gap="small">
              <s-paragraph color="subdued">
                {t("agent.transcript.takeOverHelp")}
              </s-paragraph>
              <s-button variant="primary" type="submit" {...whenDisabled(!view.entitled)}>
                {t("agent.transcript.takeOver")}
              </s-button>
            </s-stack>
          </form>
        )}

        <form method="post">
          <input type="hidden" name="intent" value="reply" />
          <s-stack direction="block" gap="small">
            <s-text-area
              name="text"
              label={t("agent.transcript.replyLabel")}
              details={t("agent.transcript.replyHelp", { max: view.maxReplyChars })}
              rows={3}
              maxLength={view.maxReplyChars}
              {...whenDisabled(!view.entitled)}
              {...(view.tooLong
                ? { error: t("agent.transcript.tooLong", { max: view.maxReplyChars }) }
                : {})}
            />
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button type="submit" {...whenDisabled(!view.entitled)}>
                {t("agent.transcript.send")}
              </s-button>
              {view.sent ? (
                <s-badge tone="success">{t("agent.transcript.sent")}</s-badge>
              ) : null}
            </s-stack>
          </s-stack>
        </form>
      </s-stack>
    </s-section>
  );
}
