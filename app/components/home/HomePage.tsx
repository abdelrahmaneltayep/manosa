import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";
import type {
  ActivityView,
  AskView,
  BriefingView,
  HomeView,
  KpiView,
  SetupView,
} from "~/components/home/types";

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
      <Kpis view={view.kpis} />
      <Briefing view={view.briefing} />
      <Ask view={view.ask} />
      <Setup view={view.setup} />
      <Activity view={view.activity} />
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

        {view.confirmingMute ? (
          <s-banner tone="warning">
            <s-heading>
              {t("home.briefing.confirmMuteHeading", {
                kind: t(`home.briefing.mutedKind.${view.confirmingMute}`),
              })}
            </s-heading>
            <s-paragraph>{t("home.briefing.confirmMuteBody")}</s-paragraph>
            <s-stack direction="inline" gap="small" alignItems="center">
              <form method="post">
                <input type="hidden" name="intent" value="mute" />
                <input type="hidden" name="kind" value={view.confirmingMute} />
                <s-button type="submit" tone="critical">
                  {t("home.briefing.confirmMuteYes")}
                </s-button>
              </form>
              <s-link href="/app">{t("home.briefing.confirmMuteNo")}</s-link>
            </s-stack>
          </s-banner>
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
                {/* Two steps, because muting is not reversible from the row:
                    the checklist asks "Don't show this type again?" rather
                    than silently muting on one click. Asking is a link so
                    that nothing is written until the merchant says yes. */}
                <s-button
                  href={`/app?confirm=${encodeURIComponent(item.kind)}`}
                  variant="tertiary"
                >
                  {t("home.briefing.mute")}
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        ))}
        <Muted view={view} />
      </s-stack>
    </s-section>
  );
}

/**
 * The kinds the merchant has silenced, and the way back.
 *
 * Without this, "Not this again" is a one-way door: the kind never appears
 * again and nothing on any screen says it was muted. The checklist puts this
 * list in Settings, which is 6.2 — it lives here until then rather than not
 * existing.
 */
function Muted({ view }: { view: BriefingView }) {
  const { t } = useTranslation();
  if (view.muted.length === 0) return null;

  return (
    <s-stack direction="block" gap="small-100">
      <s-text color="subdued">
        {t("home.briefing.mutedHeading", { count: view.muted.length })}
      </s-text>
      <s-stack direction="inline" gap="small-100">
        {view.muted.map((entry) => (
          <form key={entry.kind} method="post">
            <input type="hidden" name="intent" value="unmute" />
            <input type="hidden" name="kind" value={entry.kind} />
            <s-button type="submit" variant="tertiary">
              {t("home.briefing.unmute", { kind: entry.label })}
            </s-button>
          </form>
        ))}
      </s-stack>
    </s-stack>
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

  if (view.status === "cleared") {
    return (
      // Not "all quiet": the list is done, but other things have come up since
      // it was written and the agent has not ranked them yet.
      <s-banner tone="info">
        <s-heading>{t("home.briefing.clearedHeading")}</s-heading>
        <s-paragraph>{t("home.briefing.clearedBody")}</s-paragraph>
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

  if (view.stale && view.writtenAtLabel) {
    return (
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-badge tone="warning">
          {t("home.briefing.stale", { when: view.writtenAtLabel })}
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
          {/* A number only when something measured one. Anthropic's
              `Retry-After` is not read anywhere, so there usually is not one,
              and inventing "30 seconds" is a claim the app cannot support. */}
          {view.cooldownSeconds === null
            ? t("home.ask.failure.rate_limited.body")
            : t("home.ask.failure.rate_limited.bodySeconds", {
                count: view.cooldownSeconds,
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
/* -------------------------------------------------------------------------- */

/**
 * The five numbers, and the period they are over.
 *
 * Skeletons are the same shape and height as the cards they become, because a
 * spinner that reflows the page is how you lose the CLS budget the checklist
 * treats as an acceptance criterion.
 */
function Kpis({ view }: { view: KpiView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("home.kpi.heading")}>
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small" alignItems="center">
          {view.periods.map((days) => (
            <s-link key={days} href={`/app?period=${days}`}>
              {days === view.period
                ? t("home.kpi.periodCurrent", { count: days })
                : t("home.kpi.period", { count: days })}
            </s-link>
          ))}
        </s-stack>

        {view.empty ? <s-paragraph>{t("home.kpi.emptyBody")}</s-paragraph> : null}

        {/* The period selector offers ninety days to a shop that has eight. */}
        {view.coversDays === null ? null : (
          <s-text color="subdued">
            {t("home.kpi.covers", { count: view.coversDays })}
          </s-text>
        )}

        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
          {view.cards.map((card) => (
            <s-box
              key={card.key}
              padding="base"
              minBlockSize="120px"
              borderWidth="base"
              borderStyle="solid"
              borderColor="base"
              borderRadius="base"
            >
              <s-stack direction="block" gap="small-500">
                <s-text color="subdued">{t(`home.kpi.card.${card.key}`)}</s-text>
                {card.partial ? (
                  <s-stack direction="block" gap="small-500">
                    <s-heading>—</s-heading>
                    <s-text color="subdued">{t("home.kpi.needsAWeek")}</s-text>
                  </s-stack>
                ) : (
                  <s-stack direction="block" gap="small-500">
                    <s-heading>{card.value}</s-heading>
                    {/* The previous period, so a merchant can make the
                        comparison themselves — including when the delta is
                        hidden because the base was zero. */}
                    {card.previous === null ? null : (
                      <s-text color="subdued">
                        {t("home.kpi.previous", { value: card.previous })}
                      </s-text>
                    )}
                    {/* Hidden when the base period was zero: "▲ ∞%" is not a
                        number, and "▲ 400%" off one order is a worse one. */}
                    {card.deltaPercent === null ? null : (
                      <s-badge tone={card.deltaPercent >= 0 ? "success" : "critical"}>
                        {t(
                          card.deltaPercent >= 0
                            ? "home.kpi.deltaUp"
                            : "home.kpi.deltaDown",
                          { percent: Math.abs(card.deltaPercent) },
                        )}
                      </s-badge>
                    )}
                  </s-stack>
                )}
                <s-link href={card.href}>{t(`home.kpi.link.${card.key}`)}</s-link>
              </s-stack>
            </s-box>
          ))}
        </s-grid>
      </s-stack>
    </s-section>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Six things, and a pill once they are done.
 *
 * The embed row is the only one that can be true on the merchant's word rather
 * than on something observed, and it says which — see `docs/adr/0022`.
 */
function Setup({ view }: { view: SetupView }) {
  const { t } = useTranslation();

  if (view.dismissed) {
    return (
      <s-section>
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-badge tone="success">
            {t("home.setup.pill", { done: view.done, total: view.total })}
          </s-badge>
          <form method="post">
            <input type="hidden" name="intent" value="reopenSetup" />
            <s-button type="submit" variant="tertiary">
              {t("home.setup.reopen")}
            </s-button>
          </form>
        </s-stack>
      </s-section>
    );
  }

  return (
    <s-section heading={t("home.setup.heading")}>
      <s-stack direction="block" gap="base">
        <s-text color="subdued">
          {t("home.setup.progress", { done: view.done, total: view.total })}
        </s-text>

        <s-stack direction="block" gap="small">
          {view.items.map((item) => (
            <s-stack key={item.step} direction="inline" gap="small" alignItems="center">
              <s-badge tone={item.done ? "success" : "neutral"}>
                {t(item.done ? "home.setup.done" : "home.setup.todo")}
              </s-badge>
              <s-link href={item.href}>{t(`home.setup.step.${item.step}`)}</s-link>
              {item.attested ? (
                <s-text color="subdued">{t("home.setup.yourWord")}</s-text>
              ) : null}
            </s-stack>
          ))}
        </s-stack>

        {/* The embed cannot be read without a protected scope, so the merchant
            can say. Offered only while it is outstanding. */}
        {view.items.some((item) => item.step === "embed" && !item.done) ? (
          <form method="post">
            <input type="hidden" name="intent" value="confirmEmbed" />
            <s-button type="submit" variant="tertiary">
              {t("home.setup.confirmEmbed")}
            </s-button>
          </form>
        ) : null}

        {view.complete ? (
          <form method="post">
            <input type="hidden" name="intent" value="dismissSetup" />
            <s-button type="submit" variant="tertiary">
              {t("home.setup.dismiss")}
            </s-button>
          </form>
        ) : null}

        <s-link href="/app/setup">{t("home.setup.wizard")}</s-link>
      </s-stack>
    </s-section>
  );
}

/* -------------------------------------------------------------------------- */

function Activity({ view }: { view: ActivityView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("home.activity.heading")}>
      {view.empty ? (
        <s-paragraph>{t("home.activity.empty")}</s-paragraph>
      ) : (
        <s-stack direction="block" gap="small">
          {view.rows.map((row) => (
            <s-stack key={row.id} direction="inline" gap="small" alignItems="center">
              {row.agent ? <s-badge tone="info">✦</s-badge> : null}
              <s-text color="subdued">{row.kindLabel}</s-text>
              {row.href ? (
                <s-link href={row.href}>{row.summary}</s-link>
              ) : (
                <s-text>{row.summary}</s-text>
              )}
              <s-text color="subdued">{row.when}</s-text>
            </s-stack>
          ))}
          <s-link href={view.href}>{t("home.activity.viewAll")}</s-link>
        </s-stack>
      )}
    </s-section>
  );
}
