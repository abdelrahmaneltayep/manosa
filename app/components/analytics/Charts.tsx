import { useTranslation } from "react-i18next";

import {
  columns,
  gridlines,
  inner,
  line,
  niceMax,
  PLOT,
  polyline,
  rows,
  round,
  shouldLabel,
  withEndRoom,
  dayX,
} from "~/lib/analytics/geometry";
import type {
  AgingRowView,
  CountSeriesView,
  FunnelStepView,
  RankedRowView,
  SeriesView,
} from "~/components/analytics/types";

/**
 * The marks.
 *
 * Server-rendered SVG, no library and no client script: a theme app extension
 * has a Lighthouse budget and an embedded admin page has an LCP one, and a
 * chart that is one `<svg>` in the HTML costs neither. It also means every
 * state can be captured with `renderToStaticMarkup`, which is the only way a
 * chart gets looked at in this environment at all.
 *
 * Each chart ships with `<title>` on every mark — a real tooltip, from the
 * browser, for free — and a table beside it. Identity is never colour alone.
 */

const box = inner();

/* -------------------------------------------------------------------------- */

/**
 * The gridlines, the baseline, and the value axis.
 *
 * The axis labels are the reason a reader can tell a tall bar from a big
 * number. Without them `niceMax` is actively misleading: a peak of 12.3M
 * rounds the top of the scale to 20M, so the tallest mark reaches 62% of the
 * plot and nothing on screen says why.
 */
function Frame({ ticks }: { ticks?: readonly string[] }) {
  const lines = gridlines();

  return (
    <>
      {lines.map((y, index) => (
        <line
          key={index}
          className="mn-grid"
          x1={box.x}
          x2={box.x + box.width}
          y1={round(y)}
          y2={round(y)}
        />
      ))}

      {(ticks ?? []).map((label, index) => (
        <text
          key={`v${index}`}
          className="mn-label"
          x={box.x}
          y={round(lines[index]! - 0.6)}
          textAnchor="start"
          direction="ltr"
        >
          {label}
        </text>
      ))}
      <line
        className="mn-axis"
        x1={box.x}
        x2={box.x + box.width}
        y1={round(box.y + box.height)}
        y2={round(box.y + box.height)}
      />
    </>
  );
}

/**
 * Wholesale against retail, over time.
 *
 * The one categorical chart on the page: two series, two hues, a legend, and
 * both direct-labelled at the end of the line. Under a week of history it
 * draws bars and no line — a line through four points is a shape drawn on
 * noise, and the checklist says so.
 */
export function RevenueChart({
  wholesale,
  retail,
  partial,
  annotations,
  axisTicks,
}: {
  wholesale: SeriesView;
  retail: SeriesView;
  partial: boolean;
  annotations: { key: string; day: string; label: string }[];
  /**
   * The value-axis labels, top to bottom, already formatted in the shop's
   * currency. Formatted on the server, because money formatting lives there
   * and a component that did its own would be a second place for the page and
   * its CSV to disagree.
   */
  axisTicks: readonly string[];
}) {
  const { t } = useTranslation();
  const days = wholesale.points.map((point) => point.label);
  const max = niceMax([
    ...wholesale.points.map((point) => point.value),
    ...retail.points.map((point) => point.value),
  ]);

  const bars = columns(
    wholesale.points.map((point) => point.value),
    { max },
  );
  const retailBars = columns(
    retail.points.map((point) => point.value),
    { max },
  );

  return (
    <div className="mn-viz" dir="ltr">
      <svg
        viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
        role="img"
        aria-label={t("analytics.revenue.alt")}
      >
        <Frame ticks={axisTicks} />

        {/* A marked day is a rule behind the marks, not on top of them: a
            store installed mid-window has a line starting at zero because the
            app was not there, which is not the same as nothing selling. */}
        {annotations.map((mark, order) => {
          const index = wholesale.points.findIndex((point) => point.day === mark.day);
          if (index < 0 || wholesale.points.length === 0) return null;

          // The same x the data point uses. These used to be computed from
          // slot centres while the line used gap edges, so a rule reading "the
          // app arrived here" pointed half a day away from the point it named.
          const x = round(dayX(index, wholesale.points.length));
          // Past the middle, the label goes on the other side — otherwise a
          // shop that installed recently, which is exactly when this mark
          // matters, has its label silently clipped by the viewBox.
          const flip = x > box.x + box.width * 0.55;
          // Stacked when two marks are close: install and publish in the same
          // fortnight is the ordinary onboarding path, and both were drawn on
          // the same line.
          const y = round(box.y + 2 + order * 2.6);

          return (
            <g key={mark.key}>
              <line className="mn-axis" x1={x} x2={x} y1={box.y} y2={box.y + box.height}>
                <title>{mark.label}</title>
              </line>
              <text
                className="mn-label"
                x={round(flip ? x - 0.6 : x + 0.6)}
                y={y}
                textAnchor={flip ? "end" : "start"}
                direction="ltr"
              >
                {mark.label}
              </text>
            </g>
          );
        })}

        {partial ? (
          <>
            {bars.map((bar, index) => (
              <rect
                key={`w${index}`}
                className="mn-s1"
                x={round(bar.x)}
                y={round(bar.y)}
                width={round(bar.width / 2)}
                height={round(bar.height)}
                rx="0.4"
              >
                <title>{`${days[index]} · ${wholesale.points[index]?.money ?? ""}`}</title>
              </rect>
            ))}
            {retailBars.map((bar, index) => (
              <rect
                key={`r${index}`}
                className="mn-s2"
                // The 2px surface gap, in viewBox units: a border around each
                // bar would read as chrome.
                x={round(bar.x + bar.width / 2 + 0.2)}
                y={round(bar.y)}
                width={round(bar.width / 2)}
                height={round(bar.height)}
                rx="0.4"
              >
                <title>{`${days[index]} · ${retail.points[index]?.money ?? ""}`}</title>
              </rect>
            ))}
          </>
        ) : (
          <>
            <polyline
              className="mn-line mn-line-s1"
              points={polyline(
                line(
                  wholesale.points.map((point) => point.value),
                  { max },
                ),
              )}
            />
            <polyline
              className="mn-line mn-line-s2"
              points={polyline(
                line(
                  retail.points.map((point) => point.value),
                  { max },
                ),
              )}
            />
            {/* A hit target per day, carrying both series' figures. Invisible,
                because a dot on every point of a ninety-day chart is noise —
                but hoverable, which is the only way a line chart answers
                "what was that day?" without a client-side tooltip. */}
            {line(
              wholesale.points.map((point) => point.value),
              { max },
            ).map((point, index) => (
              <circle
                key={index}
                cx={round(point.x)}
                cy={round(point.y)}
                r="1.2"
                fill="transparent"
              >
                <title>
                  {`${days[index]} · ${t("analytics.revenue.wholesale", {
                    total: wholesale.points[index]?.money ?? "",
                  })} · ${t("analytics.revenue.retail", {
                    total: retail.points[index]?.money ?? "",
                  })}`}
                </title>
              </circle>
            ))}
          </>
        )}

        {days.map((label, index) =>
          shouldLabel(index, days.length) ? (
            <text
              key={index}
              className="mn-label"
              x={round(dayX(index, days.length))}
              y={round(PLOT.height - 2)}
              textAnchor="middle"
            >
              {label}
            </text>
          ) : null,
        )}
      </svg>

      {/* Always present for two series, and both direct-labelled with their
          own total — so identity never rests on colour. */}
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-text>
          <span
            className="mn-swatch"
            style={{ backgroundColor: "var(--mn-series-1)" }}
            aria-hidden="true"
          />
          {t("analytics.revenue.wholesale", { total: wholesale.total })}
        </s-text>
        <s-text>
          <span
            className="mn-swatch"
            style={{ backgroundColor: "var(--mn-series-2)" }}
            aria-hidden="true"
          />
          {t("analytics.revenue.retail", { total: retail.total })}
        </s-text>
      </s-stack>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * How many orders a day, wholesale beside retail.
 *
 * Bars at every window width, where the revenue chart draws a line above a
 * week of history. An order count is a whole thing that either happened or did
 * not, and a line between two and three orders draws a value — two and a half
 * — that cannot exist. The axis is whole numbers for the same reason.
 *
 * Its own chart rather than a second axis on revenue: a count and an amount
 * are different measures on different scales, and one pair of axes makes
 * whichever is smaller look like nothing happened.
 */
export function OrdersChart({
  wholesale,
  retail,
  ticks,
  alt,
}: {
  wholesale: CountSeriesView;
  retail: CountSeriesView;
  /** Whole counts, top to bottom. The first is the top of the scale. */
  ticks: readonly number[];
  alt: string;
}) {
  const { t } = useTranslation();
  const days = wholesale.points.map((point) => point.label);
  // The same number the axis is labelled with, never a second computation:
  // marks scaled against one max under labels printed from another is the way
  // a chart lies without any figure on it being wrong.
  const max = ticks[0] ?? 1;

  const bars = columns(
    wholesale.points.map((point) => point.value),
    { max },
  );
  const retailBars = columns(
    retail.points.map((point) => point.value),
    { max },
  );

  return (
    <div className="mn-viz" dir="ltr">
      <svg viewBox={`0 0 ${PLOT.width} ${PLOT.height}`} role="img" aria-label={alt}>
        <Frame ticks={ticks.map((tick) => String(tick))} />

        {bars.map((bar, index) => (
          <rect
            key={`w${index}`}
            className="mn-s1"
            x={round(bar.x)}
            y={round(bar.y)}
            width={round(bar.width / 2)}
            height={round(bar.height)}
            rx="0.4"
          >
            <title>
              {`${days[index]} · ${t("analytics.orders.wholesale", {
                count: wholesale.points[index]?.value ?? 0,
              })}`}
            </title>
          </rect>
        ))}
        {retailBars.map((bar, index) => (
          <rect
            key={`r${index}`}
            className="mn-s2"
            x={round(bar.x + bar.width / 2 + 0.2)}
            y={round(bar.y)}
            width={round(bar.width / 2)}
            height={round(bar.height)}
            rx="0.4"
          >
            <title>
              {`${days[index]} · ${t("analytics.orders.retail", {
                count: retail.points[index]?.value ?? 0,
              })}`}
            </title>
          </rect>
        ))}

        {days.map((label, index) =>
          shouldLabel(index, days.length) ? (
            <text
              key={index}
              className="mn-label"
              x={round(dayX(index, days.length))}
              y={round(PLOT.height - 2)}
              textAnchor="middle"
            >
              {label}
            </text>
          ) : null,
        )}
      </svg>

      <s-stack direction="inline" gap="base" alignItems="center">
        <s-text>
          <span
            className="mn-swatch"
            style={{ backgroundColor: "var(--mn-series-1)" }}
            aria-hidden="true"
          />
          {t("analytics.orders.wholesale", { count: wholesale.total })}
        </s-text>
        <s-text>
          <span
            className="mn-swatch"
            style={{ backgroundColor: "var(--mn-series-2)" }}
            aria-hidden="true"
          />
          {t("analytics.orders.retail", { count: retail.total })}
        </s-text>
      </s-stack>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * A ranked bar chart: groups, buyers, products, rules.
 *
 * One hue for every bar. Colouring each one darker-where-bigger would encode
 * the bar's length twice and say nothing the length does not already say.
 */
export function RankedChart({ rows: data, alt }: { rows: RankedRowView[]; alt: string }) {
  // The longest bar reaches the full plot width, so its label is written past
  // the end of it. Without room reserved, that label leaves the viewBox.
  const plot = withEndRoom(data.map((row) => row.money));
  const bars = rows(
    data.map((row) => row.value),
    { plot },
  );

  return (
    <div className="mn-viz" dir="ltr">
      <svg viewBox={`0 0 ${PLOT.width} ${PLOT.height}`} role="img" aria-label={alt}>
        {bars.map((bar, index) => (
          <g key={data[index]!.key}>
            <rect
              // The remainder row is a total, not a buyer. Given the same hue
              // it became the longest bar on some charts while sitting last,
              // so the chart read as neither sorted nor legible.
              className={data[index]!.isRest ? "mn-rest" : "mn-s1"}
              x={round(bar.x)}
              y={round(bar.y)}
              width={round(bar.width)}
              height={round(bar.height)}
              rx="0.4"
            >
              <title>{`${data[index]!.label} · ${data[index]!.money}`}</title>
            </rect>
            {/* Outside the bar end, always: a label inside a short bar is a
                label with its first characters cropped off.

                `text-anchor` and `direction` are set explicitly because these
                charts are drawn in physical coordinates while the page around
                them may be RTL. Without them the default `start` resolves to
                the *right* edge in Arabic, so every value was anchored past
                its bar and ran leftwards straight across it. */}
            <text
              className="mn-value"
              x={round(bar.x + bar.width + 0.8)}
              y={round(bar.y + bar.height / 2 + 0.8)}
              textAnchor="start"
              direction="ltr"
            >
              {data[index]!.money}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** The registration funnel: an ordered scale, so one hue light → dark. */
export function FunnelChart({ steps, alt }: { steps: FunnelStepView[]; alt: string }) {
  const { t } = useTranslation();
  const plot = withEndRoom(steps.map((step) => String(step.value)));
  const bars = rows(
    steps.map((step) => step.value),
    { plot },
  );

  return (
    <div className="mn-viz" dir="ltr">
      <svg viewBox={`0 0 ${PLOT.width} ${PLOT.height}`} role="img" aria-label={alt}>
        {bars.map((bar, index) => (
          <g key={steps[index]!.key}>
            <rect
              x={round(bar.x)}
              y={round(bar.y)}
              width={round(bar.width)}
              height={round(bar.height)}
              rx="0.4"
              fill={`var(--mn-step-${index + 1})`}
            >
              <title>{`${t(`analytics.funnel.${steps[index]!.key}`)} · ${steps[index]!.value}`}</title>
            </rect>
            <text
              className="mn-value"
              x={round(bar.x + bar.width + 0.8)}
              y={round(bar.y + bar.height / 2 + 0.8)}
              textAnchor="start"
              direction="ltr"
            >
              {steps[index]!.value}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/** The aging report: ordered bands, so the same one-hue ramp. */
export function AgingChart({ rows: data, alt }: { rows: AgingRowView[]; alt: string }) {
  const { t } = useTranslation();
  const plot = withEndRoom(data.map((row) => row.amount));
  const bars = rows(
    data.map((row) => row.value),
    { plot },
  );

  return (
    <div className="mn-viz" dir="ltr">
      <svg viewBox={`0 0 ${PLOT.width} ${PLOT.height}`} role="img" aria-label={alt}>
        {bars.map((bar, index) => (
          <g key={data[index]!.key}>
            <rect
              x={round(bar.x)}
              y={round(bar.y)}
              width={round(bar.width)}
              height={round(bar.height)}
              rx="0.4"
              fill={`var(--mn-step-${Math.min(4, index + 1)})`}
            >
              <title>{`${t(`terms.bucket.${data[index]!.key}`)} · ${data[index]!.amount}`}</title>
            </rect>
            <text
              className="mn-value"
              x={round(bar.x + bar.width + 0.8)}
              y={round(bar.y + bar.height / 2 + 0.8)}
              textAnchor="start"
              direction="ltr"
            >
              {data[index]!.amount}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
