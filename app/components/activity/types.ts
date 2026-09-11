import type { ActivityRowView } from "~/components/home/types";

/** One row of the full log. Home's row, plus who did it. */
export interface ActivityLogRowView extends ActivityRowView {
  actorLabel: string | null;
}

export interface ActivityLogView {
  rows: ActivityLogRowView[];
  filter: string;
  filters: string[];
  /**
   * Checklist §8 asks for the log to be filterable **by actor, action and
   * date**, not only by category. The first is the question a merchant opens
   * this page with: did a person do this, or did Claude?
   */
  /** Each category link, carrying the filters the merchant already set. */
  filterHrefs: Record<string, string>;
  actor: string;
  actors: string[];
  /** One exact action, e.g. "pricing_rule.created", or empty for any. */
  action: string;
  /** Every action this shop has actually recorded, for the picker. */
  actions: { value: string; label: string }[];
  from: string;
  to: string;
  /** How far back the log goes, stated rather than left to be discovered. */
  retentionMonths: number;
  /** The oldest entry that will still be here tomorrow, as a date. */
  keptFrom: string;
  /** Whether any filter is set, so "no rows" can say which. */
  filtered: boolean;
  /** Where "Show more" goes. Null when this is the end of the log. */
  nextHref: string | null;
}
