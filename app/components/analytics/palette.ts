/**
 * The chart palette, and why these hexes.
 *
 * Series colour is data encoding, not chrome. Polaris tokens dress the card,
 * the type and the rules around a chart — Shopify ships a separate palette for
 * the marks themselves for exactly this reason — so these are literal values,
 * chosen against a validator rather than by eye, and stepped separately for the
 * dark surface rather than flipped.
 *
 * Every set below was run through the six checks (lightness band, chroma floor,
 * CVD separation, normal-vision floor, contrast, and monotone lightness with
 * visible steps for the ordered ramps) against `#ffffff` and `#1a1a1a`, the
 * surfaces a Polaris card actually paints. `qa/6.2/REPORT.md` records the runs.
 *
 * Only two charts need more than one colour at a time, and only one of those is
 * categorical:
 *
 * - **Wholesale vs retail** is identity — two series, two hues.
 * - **The funnel and the aging report** are *ordered* scales, so they take one
 *   hue light→dark. A ramp on the nominal charts (buyers, products, rules)
 *   would double-encode bar length as colour and burn the only free channel on
 *   something the bar already says.
 */

export interface ChartPalette {
  /** Categorical slot 1, and the single hue every nominal bar chart uses. */
  series1: string;
  /** Categorical slot 2. Only the revenue chart has a second series. */
  series2: string;
  /** Ordered scale, light → dark. Four steps: the aging report's bands. */
  ramp4: readonly string[];
  /** Three steps: the registration funnel. */
  ramp3: readonly string[];
}

export const LIGHT: ChartPalette = {
  series1: "#2a78d6",
  series2: "#eb6834",
  ramp4: ["#86b6ef", "#2a78d6", "#1c5cab", "#104281"],
  ramp3: ["#86b6ef", "#2a78d6", "#104281"],
};

export const DARK: ChartPalette = {
  series1: "#3987e5",
  series2: "#d95926",
  ramp4: ["#cde2fb", "#9ec5f4", "#3987e5", "#256abf"],
  ramp3: ["#cde2fb", "#6da7ec", "#256abf"],
};

/**
 * The stylesheet the charts are written against.
 *
 * Roles, not hexes, in the markup — so the two modes swap in one place. Dark is
 * declared under both the media query and the explicit theme attribute, because
 * a merchant who has chosen light in a dark OS must get light.
 */
export const CHART_STYLES = `
.mn-viz {
  --mn-surface: var(--p-color-bg-surface, #ffffff);
  --mn-ink: var(--p-color-text, #1a1a1a);
  --mn-ink-muted: var(--p-color-text-secondary, #616161);
  --mn-grid: #e1e0d9;
  --mn-axis: #c3c2b7;
  --mn-series-1: ${LIGHT.series1};
  --mn-series-2: ${LIGHT.series2};
  --mn-step-1: ${LIGHT.ramp4[0]};
  --mn-step-2: ${LIGHT.ramp4[1]};
  --mn-step-3: ${LIGHT.ramp4[2]};
  --mn-step-4: ${LIGHT.ramp4[3]};
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .mn-viz {
    --mn-grid: #2c2c2a;
    --mn-axis: #383835;
    --mn-series-1: ${DARK.series1};
    --mn-series-2: ${DARK.series2};
    --mn-step-1: ${DARK.ramp4[0]};
    --mn-step-2: ${DARK.ramp4[1]};
    --mn-step-3: ${DARK.ramp4[2]};
    --mn-step-4: ${DARK.ramp4[3]};
  }
}
:root[data-theme="dark"] .mn-viz {
  --mn-grid: #2c2c2a;
  --mn-axis: #383835;
  --mn-series-1: ${DARK.series1};
  --mn-series-2: ${DARK.series2};
  --mn-step-1: ${DARK.ramp4[0]};
  --mn-step-2: ${DARK.ramp4[1]};
  --mn-step-3: ${DARK.ramp4[2]};
  --mn-step-4: ${DARK.ramp4[3]};
}
.mn-viz svg { display: block; width: 100%; height: auto; }
/* Hairlines, one shade off the surface, and solid: a dashed grid reads as a
   threshold when it is only a grid. */
.mn-viz .mn-grid { stroke: var(--mn-grid); stroke-width: 0.15; }
.mn-viz .mn-axis { stroke: var(--mn-axis); stroke-width: 0.2; }
.mn-viz .mn-label { fill: var(--mn-ink-muted); font-size: 2.1px; }
.mn-viz .mn-value { fill: var(--mn-ink); font-size: 2.3px; }
.mn-viz .mn-line { fill: none; stroke-width: 0.6; stroke-linejoin: round; stroke-linecap: round; }
.mn-viz .mn-s1 { fill: var(--mn-series-1); }
.mn-viz .mn-s2 { fill: var(--mn-series-2); }
.mn-viz .mn-line-s1 { stroke: var(--mn-series-1); }
.mn-viz .mn-line-s2 { stroke: var(--mn-series-2); }
/* The example state washes out the **marks**, never the words.
   Applied to the whole card it put every table figure, every label and seven
   export links at roughly 3.9:1 on white — under the AA floor, on interactive
   text. The banner and the labelled rows carry the message instead. */
.mn-viz--example .mn-viz svg { opacity: 0.5; }
/* The remainder row: the same hue, hollow, so it reads as a total rather than
   as one more buyer. */
.mn-viz .mn-rest {
  fill: var(--mn-surface);
  stroke: var(--mn-series-1);
  stroke-width: 0.3;
}
.mn-swatch {
  display: inline-block;
  inline-size: 0.75em;
  block-size: 0.75em;
  border-radius: 2px;
  margin-inline-end: 0.35em;
  vertical-align: baseline;
}
`;
