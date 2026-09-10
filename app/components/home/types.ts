/**
 * The home page, as plain serialisable data.
 *
 * Phase 4.4 fills in the two ✦ surfaces — the Merchant Agent's briefing and the
 * Ask Mannon bar. The KPI cards, setup checklist and recent activity are 4.5.
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
   * `ready` has items. `quiet` ran and found nothing — a designed state.
   * `empty` is day one. `unavailable` means today's could not be had; when
   * `items` is non-empty it is yesterday's, and `writtenAt` says when.
   */
  status: "ready" | "quiet" | "empty" | "unavailable" | "loading" | "off";
  items: BriefingItemView[];
  /** ISO. Null when nothing has ever been written. */
  writtenAt: string | null;
  /** Older than a day. The checklist's stale badge. */
  stale: boolean;
  /** Kinds the merchant has muted, so Settings can show them. */
  muted: string[];
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

export interface HomeView {
  shopName: string;
  briefing: BriefingView;
  ask: AskView;
}
