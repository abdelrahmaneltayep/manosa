import type { ActivityRowView } from "~/components/home/types";

/** One row of the full log. Home's row, plus who did it. */
export interface ActivityLogRowView extends ActivityRowView {
  actorLabel: string | null;
}

export interface ActivityLogView {
  rows: ActivityLogRowView[];
  filter: string;
  filters: string[];
  /** Where "Show more" goes. Null when this is the end of the log. */
  nextHref: string | null;
}
