import { useTranslation } from "react-i18next";

import {
  AgingChart,
  FunnelChart,
  RankedChart,
  RevenueChart,
} from "~/components/analytics/Charts";
import { CHART_STYLES } from "~/components/analytics/palette";
import { AskBar } from "~/components/analytics/AskBar";
import type {
  AnalyticsView,
  AskView,
  RankedRowView,
  RuleRowView,
} from "~/components/analytics/types";

/**
 * Seven charts, and the sentences that keep them honest.
 *
 * Three of those sentences matter more than any of the charts: what currency
 * every figure is in, what timezone every day was bucketed in, and which orders
 * were left out. A chart whose reader has to assume any of those is a chart
 * that can be confidently misread.
 */
export function AnalyticsPage({
  view,
  ask,
}: {
  view: AnalyticsView;
  /** ✦ Ask your data. Absent in the state captures that do not exercise it. */
  ask?: AskView;
}) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("analytics.heading")}>
      {/* Roles, not hexes, in the markup — so the two modes swap in one place. */}
      <style dangerouslySetInnerHTML={{ __html: CHART_STYLES }} />

      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>{t("analytics.description")}</s-paragraph>
          <RangePicker view={view} />
          <s-link href="/app/analytics/review">{t("analytics.monthlyReview")}</s-link>
        </s-stack>
      </s-section>

      {ask ? <AskBar view={ask} /> : null}
      {view.loading ? <Skeleton /> : null}
      {view.isExample ? <ExampleBanner /> : null}
      {view.partial ? <PartialBanner view={view} /> : null}
      <Caveats view={view} />

      <div
        className={view.isExample ? "mn-viz--example" : undefined}
        {...(view.loading ? { hidden: true } : {})}
      >
        <Card
          heading={t("analytics.revenue.heading")}
          csv="revenue"
          view={view}
          empty={view.revenue.wholesale.points.length === 0}
        >
          <s-stack direction="block" gap="base">
            {/* A single current value is a stat, not a chart. */}
            <s-text color="subdued">
              {t("analytics.aov", { value: view.aov.value, count: view.aov.orders })}
            </s-text>
            <RevenueChart
              wholesale={view.revenue.wholesale}
              retail={view.revenue.retail}
              partial={view.partial}
              annotations={view.annotations}
              axisTicks={view.axisTicks}
            />
          </s-stack>
        </Card>

        <RankedCard
          heading={t("analytics.byGroup.heading")}
          csv="groups"
          rows={view.byGroup}
          view={view}
          // Invariant 5: the rules card discloses the analogous hazard, so
          // this one must too.
          note={t("analytics.byGroup.note")}
        />
        <RankedCard
          heading={t("analytics.topBuyers.heading")}
          csv="buyers"
          rows={view.topBuyers}
          view={view}
        />
        <RankedCard
          heading={t("analytics.topProducts.heading")}
          csv="products"
          rows={view.topProducts}
          view={view}
          note={[
            t("analytics.lineLevel"),
            ...(view.ordersMissingLines > 0
              ? [t("analytics.missingLines", { count: view.ordersMissingLines })]
              : []),
          ].join(" ")}
        />

        <RulesCard view={view} />

        <Card
          heading={t("analytics.funnel.heading")}
          csv="funnel"
          view={view}
          empty={view.funnel.every((step) => step.value === 0)}
        >
          <s-stack direction="block" gap="base">
            <FunnelChart steps={view.funnel} alt={t("analytics.funnel.alt")} />
            <s-table>
              <s-table-header-row>
                <s-table-header>{t("analytics.funnel.colStep")}</s-table-header>
                <s-table-header>{t("analytics.funnel.colCount")}</s-table-header>
                <s-table-header>{t("analytics.funnel.colOfPrevious")}</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {view.funnel.map((step) => (
                  <s-table-row key={step.key}>
                    <s-table-cell>{t(`analytics.funnel.${step.key}`)}</s-table-cell>
                    <s-table-cell>{step.value}</s-table-cell>
                    <s-table-cell>{step.ofPrevious ?? "—"}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-stack>
        </Card>

        <Card
          heading={t("analytics.aging.heading")}
          csv="aging"
          view={view}
          empty={view.aging.every((row) => row.value === 0)}
        >
          <s-stack direction="block" gap="base">
            {/* Stated, because the range picker at the top of the page reads
                as a filter on everything below it — and this chart is a
                standing balance, not a period figure. */}
            <s-text color="subdued">{t("analytics.aging.asOf")}</s-text>
            <AgingChart rows={view.aging} alt={t("analytics.aging.alt")} />
            <s-table>
              <s-table-header-row>
                <s-table-header>{t("analytics.aging.colBucket")}</s-table-header>
                <s-table-header>{t("analytics.aging.colOwed")}</s-table-header>
                <s-table-header>{t("analytics.aging.colInvoices")}</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {view.aging.map((row) => (
                  <s-table-row key={row.key}>
                    <s-table-cell>{t(`terms.bucket.${row.key}`)}</s-table-cell>
                    <s-table-cell>{row.amount}</s-table-cell>
                    <s-table-cell>{row.count}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-stack>
        </Card>
      </div>

      <Footer view={view} />
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */

function RangePicker({ view }: { view: AnalyticsView }) {
  const { t } = useTranslation();

  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      {view.ranges.map((days) => (
        <s-link
          key={days}
          href={`?range=${days}`}
          {...(days === view.range ? { "aria-current": "page" } : {})}
        >
          {t("analytics.range", { count: days })}
        </s-link>
      ))}
    </s-stack>
  );
}

/**
 * The window is still being read.
 *
 * The checklist's "skeleton chart + tiles". Hidden from assistive technology:
 * announcing four empty boxes is worse than announcing nothing, and the
 * heading above already says what is coming.
 */
function Skeleton() {
  const { t } = useTranslation();

  return (
    <s-section heading={t("analytics.loading")}>
      <s-stack direction="block" gap="base" accessibilityVisibility="hidden">
        {[0, 1, 2, 3].map((row) => (
          <s-box key={row} background="subdued" padding="base" borderRadius="base">
            <s-text color="subdued"> </s-text>
          </s-box>
        ))}
      </s-stack>
    </s-section>
  );
}

/**
 * Nothing has sold yet, so these are somebody else's numbers.
 *
 * Said before the charts and repeated by washing them out, because a sample
 * dashboard a merchant mistakes for their own is worse than an empty one.
 */
function ExampleBanner() {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-banner tone="info">
        <s-heading>{t("analytics.example.heading")}</s-heading>
        <s-paragraph>{t("analytics.example.body")}</s-paragraph>
      </s-banner>
    </s-section>
  );
}

function PartialBanner({ view }: { view: AnalyticsView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-banner tone="info">
        <s-paragraph>{t("analytics.partial", { count: view.historyDays })}</s-paragraph>
      </s-banner>
    </s-section>
  );
}

/** Orders this page could not add up, and why. Never silent. */
function Caveats({ view }: { view: AnalyticsView }) {
  const { t } = useTranslation();
  if (view.excludedOrders === 0 && !view.ordersCapped) return null;

  return (
    <s-section>
      <s-banner tone="warning">
        {view.excludedOrders > 0 ? (
          <s-paragraph>
            {t("analytics.excluded", {
              count: view.excludedOrders,
              currency: view.currencyCode,
            })}
          </s-paragraph>
        ) : null}
        {/* A charted subset that does not say it is a subset is the quietest
            way for a busy shop to be misinformed. */}
        {view.ordersCapped ? <s-paragraph>{t("analytics.capped")}</s-paragraph> : null}
      </s-banner>
    </s-section>
  );
}

function Card({
  heading,
  csv,
  view,
  empty,
  note,
  children,
}: {
  heading: string;
  csv: string;
  view: AnalyticsView;
  empty: boolean;
  note?: string | null;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <s-section heading={heading}>
      <s-stack direction="block" gap="base">
        {empty ? (
          <s-paragraph color="subdued">{t("analytics.noData")}</s-paragraph>
        ) : (
          children
        )}
        {note ? <s-text color="subdued">{note}</s-text> : null}
        {/* Per chart, and carrying the window the merchant is looking at. */}
        <s-link href={`/app/analytics/export?chart=${csv}&range=${view.range}`}>
          {t("analytics.exportChart")}
        </s-link>
      </s-stack>
    </s-section>
  );
}

function RankedCard({
  heading,
  csv,
  rows,
  view,
  note,
}: {
  heading: string;
  csv: string;
  rows: RankedRowView[];
  view: AnalyticsView;
  note?: string | null;
}) {
  const { t } = useTranslation();

  return (
    <Card heading={heading} csv={csv} view={view} empty={rows.length === 0} note={note}>
      <s-stack direction="block" gap="base">
        <RankedChart rows={rows} alt={heading} />
        <s-table>
          <s-table-header-row>
            <s-table-header>{t("analytics.colName")}</s-table-header>
            <s-table-header>{t("analytics.colRevenue")}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((row) => (
              <s-table-row key={row.key}>
                <s-table-cell>
                  {row.isRest ? <s-text color="subdued">{row.label}</s-text> : row.label}
                </s-table-cell>
                <s-table-cell>{row.money}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-stack>
    </Card>
  );
}

/**
 * What each rule earned.
 *
 * A rule renamed since the order was placed keeps its old name here, because
 * that is the name the buyer saw at checkout — and the row says so rather than
 * letting the merchant hunt for a rule that no longer exists under that name.
 */
function RulesCard({ view }: { view: AnalyticsView }) {
  const { t } = useTranslation();

  return (
    <Card
      heading={t("analytics.rules.heading")}
      csv="rules"
      view={view}
      empty={view.rules.length === 0}
    >
      <s-stack direction="block" gap="base">
        <RankedChart rows={view.rules} alt={t("analytics.rules.heading")} />
        <s-table>
          <s-table-header-row>
            <s-table-header>{t("analytics.rules.colRule")}</s-table-header>
            <s-table-header>{t("analytics.rules.colLines")}</s-table-header>
            <s-table-header>{t("analytics.rules.colDiscounted")}</s-table-header>
            <s-table-header>{t("analytics.rules.colRevenue")}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {view.rules.map((row: RuleRowView) => (
              <s-table-row key={row.key}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-text>{row.label}</s-text>
                    {row.stillExists ? null : (
                      <s-badge>{t("analytics.rules.gone")}</s-badge>
                    )}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  {t("analytics.rules.lines", { count: row.lines })}
                </s-table-cell>
                <s-table-cell>{row.discounted}</s-table-cell>
                <s-table-cell>{row.money}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-text color="subdued">{t("analytics.rules.note")}</s-text>
        <s-text color="subdued">{t("analytics.lineLevel")}</s-text>
      </s-stack>
    </Card>
  );
}

/**
 * What every number on this page is in.
 *
 * The checklist asks for it, and it is the difference between a chart and a
 * chart somebody can act on: a merchant in Riyadh reading UTC days would be
 * looking at the wrong week and would have no way to tell.
 */
function Footer({ view }: { view: AnalyticsView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-stack direction="block" gap="small">
        <s-text color="subdued">
          {t("analytics.footer.currency", { currency: view.currencyCode })}
        </s-text>
        <s-text color="subdued">
          {view.timeZone
            ? t("analytics.footer.timezone", { zone: view.timeZone })
            : t("analytics.footer.timezoneUnknown")}
        </s-text>
        <s-text color="subdued">{t("analytics.footer.reach")}</s-text>
      </s-stack>
    </s-section>
  );
}
