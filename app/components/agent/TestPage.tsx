import { useTranslation } from "react-i18next";

import { AgentTabs } from "~/components/agent/AgentTabs";
import { whenDisabled } from "~/components/boolean-attribute";
import type { TestTurnView, TestView } from "~/components/agent/types";

/**
 * The merchant, rehearsing.
 *
 * Against a real buyer's real context — their tags, their group, their rules,
 * their terms — because a rehearsal against a made-up buyer proves nothing
 * about the prices this agent will quote. Every read works exactly as it will
 * on the storefront; every write is skipped, and the screen says so in the one
 * place a merchant cannot miss it.
 */
export function TestPage({ view }: { view: TestView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("agent.test.heading")}>
      <s-section>
        <AgentTabs current="test" />
        {/* The checklist's "clearly watermarked". First thing on the page,
            before the picker, and repeated on the transcript row. */}
        <s-banner tone="info">
          <s-heading>{t("agent.test.watermark")}</s-heading>
          <s-paragraph>{t("agent.test.watermarkBody")}</s-paragraph>
        </s-banner>
      </s-section>

      {view.entitled ? null : (
        <s-section>
          <s-banner tone="info">
            <s-heading>{t("agent.locked.heading")}</s-heading>
            <s-paragraph>
              {t("agent.locked.body", { plan: view.requiredPlan })}
            </s-paragraph>
            <s-button href="/app/plans">{t("agent.locked.action")}</s-button>
          </s-banner>
        </s-section>
      )}

      {view.noKey ? (
        <s-section>
          <s-banner tone="warning">
            <s-heading>{t("agent.test.noKeyHeading")}</s-heading>
            {/* Invariant 4: no key, no conversation, and the screen says which
                of those it is rather than blaming the merchant's settings. */}
            <s-paragraph>{t("agent.test.noKeyBody")}</s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      {view.buyers.length === 0 ? <NoBuyers /> : <Chat view={view} />}
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function NoBuyers() {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{t("agent.test.noBuyersHeading")}</s-heading>
        <s-paragraph color="subdued">{t("agent.test.noBuyersBody")}</s-paragraph>
        <s-link href="/app/customers/applications">
          {t("agent.test.noBuyersAction")}
        </s-link>
      </s-stack>
    </s-section>
  );
}

function Chat({ view }: { view: TestView }) {
  const { t } = useTranslation();

  return (
    <>
      <s-section heading={t("agent.test.buyerHeading")}>
        <form method="get">
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-select
              name="buyer"
              label={t("agent.test.buyerLabel")}
              value={view.buyerId ?? ""}
            >
              {view.buyers.map((buyer) => (
                <s-option key={buyer.customerId} value={buyer.customerId}>
                  {buyer.name}
                </s-option>
              ))}
            </s-select>
            <s-button type="submit">{t("agent.test.choose")}</s-button>
          </s-stack>
        </form>
      </s-section>

      <s-section heading={t("agent.test.conversationHeading")}>
        <s-stack direction="block" gap="base">
          {view.turns.length === 0 ? (
            <s-paragraph color="subdued">{t("agent.test.empty")}</s-paragraph>
          ) : (
            view.turns.map((turn, index) => <Turn key={index} turn={turn} />)
          )}

          {view.cart ? <Cart view={view} /> : null}

          {view.failure ? (
            <s-banner tone="critical">
              <s-heading>{t("agent.test.failureHeading")}</s-heading>
              <s-paragraph>{t(`agent.failure.${view.failure}`)}</s-paragraph>
            </s-banner>
          ) : null}

          <form method="post">
            <input type="hidden" name="intent" value="say" />
            <input type="hidden" name="buyer" value={view.buyerId ?? ""} />
            <s-stack direction="block" gap="small">
              <s-text-area
                name="message"
                label={t("agent.test.messageLabel")}
                details={t("agent.test.messageHelp")}
                rows={3}
                {...whenDisabled(!view.entitled || view.buyerId === null)}
              />
              <s-button
                variant="primary"
                type="submit"
                {...whenDisabled(!view.entitled || view.buyerId === null)}
              >
                {t("agent.test.send")}
              </s-button>
            </s-stack>
          </form>

          {/* Its own form: `s-button` carries no name or value, so an intent
              has to arrive as a hidden field. */}
          <form method="post">
            <input type="hidden" name="intent" value="restart" />
            <input type="hidden" name="buyer" value={view.buyerId ?? ""} />
            <s-button type="submit" {...whenDisabled(!view.entitled)}>
              {t("agent.test.restart")}
            </s-button>
          </form>

          {view.completed ? (
            <s-badge tone="success">{t("agent.test.completed")}</s-badge>
          ) : null}
        </s-stack>
      </s-section>
    </>
  );
}

function Turn({ turn }: { turn: TestTurnView }) {
  const { t } = useTranslation();

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-badge>{t(`agent.transcript.role.${turn.role}`)}</s-badge>
        {turn.text === "" ? (
          <s-paragraph color="subdued">{t("agent.transcript.emptyTurn")}</s-paragraph>
        ) : (
          <s-paragraph>{turn.text}</s-paragraph>
        )}
        {turn.refusal ? (
          <s-text color="subdued">
            {t("agent.transcript.refusal", { reason: turn.refusal })}
          </s-text>
        ) : null}
      </s-stack>
    </s-box>
  );
}

function Cart({ view }: { view: TestView }) {
  const { t } = useTranslation();
  if (!view.cart) return null;

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-heading>{t("agent.test.cartHeading")}</s-heading>
        <s-table>
          <s-table-header-row>
            <s-table-header>{t("agent.test.cartItem")}</s-table-header>
            <s-table-header>{t("agent.test.cartQuantity")}</s-table-header>
            <s-table-header>{t("agent.test.cartUnit")}</s-table-header>
            <s-table-header>{t("agent.test.cartTotal")}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {view.cart.lines.map((line, index) => (
              <s-table-row key={index}>
                <s-table-cell>
                  <s-stack direction="block" gap="none">
                    <s-text>{line.title}</s-text>
                    {/* Invariant 5: which rule set this price, for the
                        merchant checking their own rules from the outside. */}
                    {line.rule ? <s-text color="subdued">{line.rule}</s-text> : null}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{line.quantity}</s-table-cell>
                <s-table-cell>{line.unitPrice}</s-table-cell>
                <s-table-cell>{line.lineTotal}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-text>{t("agent.test.cartSubtotal", { total: view.cart.subtotal })}</s-text>
        <s-text color="subdued">{t("agent.test.cartNote")}</s-text>
      </s-stack>
    </s-box>
  );
}
