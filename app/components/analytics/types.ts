/**
 * The analytics page, as plain serialisable data.
 *
 * Every figure arrives already formatted in the shop's own currency, and every
 * date already bucketed in the shop's own timezone — the page states both in
 * its footer, and a component that reformatted either would be a second place
 * for them to disagree.
 */

export interface PointView {
  /** The store-local day, `YYYY-MM-DD`. */
  day: string;
  /** Short, for the axis: "1 Sep". */
  label: string;
  value: number;
  /** Already formatted, for the tooltip and the table. */
  money: string;
}

export interface SeriesView {
  /** A catalogue key — "wholesale", "retail". */
  key: string;
  points: PointView[];
  total: string;
}

export interface CountPointView {
  /** The store-local day, `YYYY-MM-DD`. */
  day: string;
  label: string;
  /** A count, not money. Nothing here is ever currency-formatted.  */
  value: number;
}

export interface CountSeriesView {
  key: string;
  points: CountPointView[];
  total: number;
}

export interface RankedRowView {
  key: string;
  label: string;
  value: number;
  money: string;
  /** The row standing in for everything below the cut. */
  isRest: boolean;
}

export interface RuleRowView extends RankedRowView {
  lines: number;
  discounted: string;
  /** No current rule carries this name — renamed, or deleted. */
  stillExists: boolean;
}

export interface FunnelStepView {
  key: string;
  value: number;
  /** Of the step before it. Null on the first, which has nothing to be of. */
  ofPrevious: string | null;
}

export interface AgingRowView {
  key: string;
  amount: string;
  value: number;
  count: number;
}

export interface AnnotationView {
  key: string;
  day: string;
  label: string;
}

export interface AnalyticsView {
  /**
   * The window is still being read.
   *
   * Checklist §7 asks for "skeleton chart + tiles". Real here rather than
   * theoretical: the range picker does full navigations against a loader that
   * runs seven queries, so there is a moment with nothing on screen.
   */
  loading: boolean;

  /** 7, 30 or 90. */
  range: number;
  ranges: number[];

  /**
   * Nothing has ever sold. The charts below are an example, and say so.
   */
  isExample: boolean;
  /** Under a week of history: bars, no trend line, and the page says why. */
  partial: boolean;
  historyDays: number;

  /** What every number here is in. Stated in the footer, not assumed. */
  currencyCode: string;
  /** The store's IANA zone, or null when Shopify has not told us yet. */
  timeZone: string | null;

  /** Orders this app could not add up, because they are in another currency. */
  excludedOrders: number;
  /** Orders whose lines Shopify did not fully return. */
  ordersMissingLines: number;
  /** The window held more orders than one view reads. */
  ordersCapped: boolean;

  annotations: AnnotationView[];
  /** Value-axis labels for the revenue chart, top to bottom. */
  axisTicks: string[];
  /** Average wholesale order value, and how many orders it averages. */
  aov: { value: string; orders: number };
  revenue: { wholesale: SeriesView; retail: SeriesView };
  /** Value-axis labels for the orders chart — whole counts, top to bottom. */
  countTicks: number[];
  orderCounts: { wholesale: CountSeriesView; retail: CountSeriesView };
  byGroup: RankedRowView[];
  topBuyers: RankedRowView[];
  topProducts: RankedRowView[];
  rules: RuleRowView[];
  funnel: FunnelStepView[];
  aging: AgingRowView[];
}

/* -------------------------------------------------------------------------- */

/**
 * The eight charts, by key.
 *
 * Lives here rather than beside the CSV writer because the *page* needs it:
 * `AskView.chart` is one of these, and typing it `string` is what let the ask
 * bar cite `analytics.groups.heading` to a merchant for three of them.
 */
export const CHART_KEYS = [
  "revenue",
  "orders",
  "groups",
  "buyers",
  "products",
  "rules",
  "funnel",
  "aging",
] as const;
export type ChartKey = (typeof CHART_KEYS)[number];

export const isChartKey = (value: string): value is ChartKey =>
  (CHART_KEYS as readonly string[]).includes(value);

/**
 * A chart key, as the catalogue spells it.
 *
 * Three of the seven differ (`groups` → `byGroup`), and interpolating the key
 * straight into `analytics.${chart}.heading` printed the raw key at the
 * merchant. Exhaustive by type, so a new chart cannot be added without one.
 */
export const CHART_HEADING: Record<ChartKey, string> = {
  revenue: "analytics.revenue.heading",
  orders: "analytics.orders.heading",
  groups: "analytics.byGroup.heading",
  buyers: "analytics.topBuyers.heading",
  products: "analytics.topProducts.heading",
  rules: "analytics.rules.heading",
  funnel: "analytics.funnel.heading",
  aging: "analytics.aging.heading",
};

/* -------------------------------------------------------------------------- */

export interface AskView {
  /** Off without the plan, or without a key. The page says which. */
  available: boolean;
  locked: "plan" | "no_key" | null;
  requiredPlan: string | null;
  /** What the merchant typed, echoed back. */
  question: string;
  /** The answer, already substituted. Null when there is not one. */
  reply: string | null;
  /** The chart it came from — the checklist's "from: Revenue by group". */
  chart: ChartKey | null;
  /** The filter state that reproduces it. */
  href: string | null;
  /** Charts that could answer something, when the chosen one could not. */
  insteadTry: ChartKey[];
  /**
   * The chosen chart was empty and so was every other one.
   *
   * Distinct from `insteadTry: []` meaning "nothing was asked": without it the
   * page came back byte-identical to before the click, so a merchant on a shop
   * with no history pressed Ask and was shown nothing at all.
   */
  nothingToAnswer: boolean;
  /** A question is in flight. Two model calls, up to ~80s. */
  pending: boolean;
  failure: string | null;
}

export interface ReviewSectionView {
  kind: string;
  headline: string;
  body: string;
  /** A page the merchant acts on. Never something this app did. */
  action: string | null;
  actionHref: string | null;
  /** The figures this section was written from — the "why" expander. */
  because: string[];
}

export interface ReviewDiffView {
  key: string;
  /** Already formatted and signed: "+$2,400.00", "−3". */
  label: string;
  better: boolean;
}

export interface ReviewView {
  month: string;
  /** "September 2026", in the merchant's language. */
  monthLabel: string;
  generatedAt: string;
  quiet: boolean;
  sections: ReviewSectionView[];
  /** Null when there is nothing to compare against — see `noDiffBecause`. */
  diff: ReviewDiffView[] | null;
  /**
   * Why there is no diff. "first" means there is no earlier month at all;
   * "previousQuiet" means there is one and it had no wholesale activity. The
   * page said "this is your first review" for both, while the month switcher
   * directly above it listed the two months before.
   */
  noDiffBecause: "first" | "previousQuiet" | null;
  /** Every month kept, newest first, for the list beside it. */
  months: { month: string; label: string; current: boolean }[];
  /** Older months exist beyond this page — `?before=`. Null at the end. */
  olderHref: string | null;
  /** Newer months exist — `?after=`. Null on the newest page. */
  newerHref: string | null;
}

export interface ReviewsView {
  available: boolean;
  locked: "plan" | "no_key" | null;
  requiredPlan: string | null;
  /** Null when nothing has been written yet. */
  latest: ReviewView | null;
  /** True on the 1st-of-month path: nothing yet, but something is coming. */
  scheduled: boolean;
  /**
   * The month whose review was attempted and failed, if one was.
   *
   * Without it a review that could not be written is indistinguishable from
   * one that has not been written yet, and the page tells a merchant their
   * first review is coming about a month it already gave up on.
   */
  failedMonth: string | null;
}
