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

  annotations: AnnotationView[];
  revenue: { wholesale: SeriesView; retail: SeriesView };
  byGroup: RankedRowView[];
  topBuyers: RankedRowView[];
  topProducts: RankedRowView[];
  rules: RuleRowView[];
  funnel: FunnelStepView[];
  aging: AgingRowView[];
}
