/**
 * The home page, as plain serialisable data.
 *
 * Everything on this page has already been decided by the time it gets here:
 * every figure formatted, every sentence chosen, every link resolved. The page
 * is a pure function of this, which is the only reason its states can be
 * exercised in an environment with no Polaris and no Shopify session.
 */

export interface BriefingItemView {
  kind: string;
  /** The agent's one line. Never contains a figure — see docs/adr/0021. */
  reason: string;
  /** Our own number, recomputed for this render. Pre-formatted. */
  figure: string;
  /** Where the merchant goes to see it for themselves. */
  href: string;
  /** The label on the item's single action button. */
  actionKey: string;
}

export interface BriefingView {
  /**
   * `ready` has items. `quiet` means nothing at all is true of this shop right
   * now. `cleared` means this morning's list is dealt with but other things
   * are outstanding and the briefing has not been rewritten yet. `empty` is day
   * one. `unavailable` means today's could not be written; when `items` is
   * non-empty it is the previous one, and `writtenAt` says when.
   */
  status: "ready" | "quiet" | "cleared" | "empty" | "unavailable" | "loading" | "off";
  items: BriefingItemView[];
  /** ISO. Null when nothing has ever been written. */
  writtenAt: string | null;
  /** The same moment, in the merchant's language. Formatted by the loader. */
  writtenAtLabel: string | null;
  /** Older than a day. The checklist's stale badge. */
  stale: boolean;
  /** Kinds the merchant has muted, each with a way back and a label. */
  muted: { kind: string; label: string }[];
  /** The kind whose "don't show this again?" is being asked. */
  confirmingMute: string | null;
}

export interface AskRowView {
  label: string;
  detail: string | null;
}

export interface AskView {
  /** False with no key: the bar is off and says why. */
  available: boolean;
  question: string;
  /** Three localized examples, rotated by the server. */
  examples: string[];
  /** The answer to the last question. */
  result: {
    headline: string;
    rows: AskRowView[];
    href: string;
    /** True when the answer is "here is where you do that", not a number. */
    isBuilder: boolean;
  } | null;
  /** Why there is no answer. `unparseable` carries three reformulations. */
  failure:
    | "no_key"
    | "timeout"
    | "rate_limited"
    | "refused"
    | "invalid_output"
    | "error"
    | "empty"
    | null;
  /** Shown under an unparseable ask — the checklist's three reformulations. */
  reformulations: string[];
  /** Seconds to wait, when the failure was a rate limit. */
  cooldownSeconds: number | null;
}

/** One KPI card. Nothing here is computed by the card. */
export interface KpiCardView {
  key: string;
  /** Pre-formatted: money in the shop's currency, or a count. */
  value: string;
  /** The same figure for the period before. Null when there is no comparison. */
  previous: string | null;
  /** Whole percent, signed. Null hides the delta — including when it is ∞. */
  deltaPercent: number | null;
  /** True when this shop has less than a week of history: the card shows "—". */
  partial: boolean;
  href: string;
}

export interface KpiView {
  period: number;
  periods: number[];
  cards: KpiCardView[];
  /** No wholesale order has ever been mirrored. The zeros get a sentence. */
  empty: boolean;
  /**
   * Days of history the shop has, when that is less than the period selected.
   *
   * Null when the period is fully covered. A store installed eight days ago
   * asking for ninety gets a figure covering eight, and saying so is the
   * difference between a number and a claim.
   */
  coversDays: number | null;
}

export interface SetupItemView {
  step: string;
  done: boolean;
  href: string;
  /** The merchant said so; we did not see it. Only the embed can be this. */
  attested: boolean;
}

export interface SetupView {
  items: SetupItemView[];
  done: number;
  total: number;
  complete: boolean;
  /** Collapsed to a ✓ pill. Re-opens on its own if a step stops being true. */
  dismissed: boolean;
}

export interface ActivityRowView {
  id: string;
  /** Already-translated sentence. */
  summary: string;
  /** Already-formatted: relative inside a week, absolute after it. */
  when: string;
  /** ISO, for the `datetime` attribute. */
  at: string;
  href: string | null;
  /** An agent did it — the ✦ chip. */
  agent: boolean;
  /** Already-translated label for the kind of thing this was. */
  kindLabel: string;
}

export interface ActivityView {
  rows: ActivityRowView[];
  /** Where "View all" goes. */
  href: string;
  /** Nothing has happened yet. */
  empty: boolean;
}

export interface HomeView {
  shopName: string;
  kpis: KpiView;
  briefing: BriefingView;
  ask: AskView;
  setup: SetupView;
  activity: ActivityView;
}
