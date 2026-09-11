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
} from "~/lib/analytics/geometry";
import type {
  AgingRowView,
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

/** The gridlines and the baseline. Hairlines, solid, one shade off the card. */
function Frame() {
  return (
    <>
      {gridlines().map((y, index) => (
        <line
          key={index}
          className="mn-grid"
          x1={box.x}
          x2={box.x + box.width}
          y1={round(y)}
          y2={round(y)}
        />
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
}: {
  wholesale: SeriesView;
  retail: SeriesView;
  partial: boolean;
  annotations: { key: string; day: string; label: string }[];
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
    <div className="mn-viz">
      <svg
        viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
        role="img"
        aria-label={t("analytics.revenue.alt")}
      >
        <Frame />

        {/* A marked day is a rule behind the marks, not on top of them: a
            store installed mid-window has a line starting at zero because the
            app was not there, which is not the same as nothing selling. */}
        {annotations.map((mark) => {
          const index = wholesale.points.findIndex((point) => point.day === mark.day);
          if (index < 0 || wholesale.points.length === 0) return null;
          const step = box.width / Math.max(1, wholesale.points.length);
          const x = round(box.x + index * step + step / 2);

          return (
            <g key={mark.key}>
              <line className="mn-axis" x1={x} x2={x} y1={box.y} y2={box.y + box.height}>
                <title>{mark.label}</title>
              </line>
              <text className="mn-label" x={x + 0.6} y={box.y + 2}>
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
          </>
        )}

        {days.map((label, index) =>
          shouldLabel(index, days.length) ? (
            <text
              key={index}
              className="mn-label"
              x={round(box.x + ((index + 0.5) * box.width) / Math.max(1, days.length))}
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
    <div className="mn-viz">
      <svg viewBox={`0 0 ${PLOT.width} ${PLOT.height}`} role="img" aria-label={alt}>
        {bars.map((bar, index) => (
          <g key={data[index]!.key}>
            <rect
              className="mn-s1"
              x={round(bar.x)}
              y={round(bar.y)}
              width={round(bar.width)}
              height={round(bar.height)}
              rx="0.4"
            >
              <title>{`${data[index]!.label} · ${data[index]!.money}`}</title>
            </rect>
            {/* Outside the bar end, always: a label inside a short bar is a
                label with its first characters cropped off. */}
            <text
              className="mn-value"
              x={round(bar.x + bar.width + 0.8)}
              y={round(bar.y + bar.height / 2 + 0.8)}
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
    <div className="mn-viz">
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
    <div className="mn-viz">
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
            >
              {data[index]!.amount}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
