/**
 * Settings, as plain serialisable data.
 *
 * Every consequence a merchant needs in order to decide is computed on the
 * server and arrives beside the control that causes it — how many rules a
 * discount-combination change affects, what the storefront will read like,
 * what pausing stops. A toggle whose effect a merchant has to guess is a
 * toggle they will not touch.
 */

export interface SettingsIssueView {
  field: string;
  /** Already translated, and already beside its field. */
  message: string;
}

export interface WholesaleSettingsView {
  wholesaleTag: string;
  wholesaleOrderTag: string;
  /** How many buyers currently carry the tag — renaming does not move them. */
  taggedBuyers: number;
}

export interface DisplaySettingsView {
  showCompareAt: boolean;
  hidePricesFromGuests: boolean;
  taxDisplay: "excl" | "incl";
  /**
   * What a buyer will read on a product page — priced by the engine from this
   * shop's own highest-priority rule, or blank when there is nothing to show
   * (no rules, or the app paused). Never a made-up figure: the first version
   * hardcoded a 30% discount and labelled it "A buyer will read:".
   */
  preview: {
    price: string | null;
    compareAt: string | null;
    taxNote: string;
    /** The rule the example came from, so the merchant can check it. */
    ruleName?: string;
  };
}

export interface DiscountSettingsView {
  allowShopifyDiscounts: boolean;
  /** Rules this change affects, and where to read them. */
  combinableRules: number;
  combinableHref: string;
}

export interface TaxSettingsView {
  requireVatForTaxExempt: boolean;
  /** Buyers already tax-exempt without a VAT id on file. */
  exemptWithoutVat: number;
}

export interface OrderSettingsView {
  posBypassesLimits: boolean;
  quoteExpiryDays: number;
  quoteReminderDays: number;
  /** Quotes already sent, whose dates this cannot move. */
  quotesOutstanding: number;
}

export interface SenderSettingsView {
  senderEmail: string;
  senderDomain: string | null;
  /**
   * Four states, and they are not the same thing.
   *
   * `none` — no sender set, so nothing can be sent at all.
   * `unchecked` — set, but the records have never been looked at.
   * `failed` — looked at, and they are not right yet.
   * `verified` — looked at, and they are.
   *
   * `unchecked` is deliberately not called "unverified": this app has not
   * checked, which is a different claim from having checked and failed.
   */
  status: "none" | "unchecked" | "failed" | "verified";
  checkedAt: string | null;
  error: string | null;
  /** The DNS records to add, as the provider gave them. */
  records: { kind: string; host: string; value: string }[];
  /** The address mail actually goes out as while this is not verified. */
  fallbackFrom: string | null;
  /** No provider is configured at all, so Verify cannot do anything. */
  verifiable: boolean;
}

/** One sample of the merchant's own writing. */
export interface BrandVoiceSampleView {
  id: string;
  label: string;
  body: string;
  added: string;
}

export interface AgentControlsView {
  /**
   * What Claude may do without being asked.
   *
   * Before 6.5 there was no such control: every ✦ surface asked only whether
   * an API key was set, so "may Claude screen my applicants" had no answer a
   * merchant could give.
   */
  mayScreen: boolean;
  mayDraft: boolean;
  /** Null when a key is set; otherwise the toggles are moot and say so. */
  noKey: boolean;
  /** The merchant's own writing, so generated copy sounds like them. */
  samples: BrandVoiceSampleView[];
  /** How many samples are worth having, from the checklist's "2-3". */
  samplesWanted: number;
  /** Briefing kinds the merchant asked not to see, and their labels. */
  mutedBriefings: { kind: string; label: string }[];
  /** Where the audit log lives, and how far back it goes. */
  auditHref: string;
  retentionDays: number;
}

export interface DangerZoneView {
  paused: boolean;
  pausedAt: string | null;
  /** Rules that stop applying — or start again — if this is pressed. */
  ruleCount: number;
  /** Set while the confirm is open. */
  confirming: boolean;
  /**
   * False when the app is paused here but the empty ruleset never reached
   * Shopify — the publish failed part-way, so checkout is still discounting
   * and the banner must not claim otherwise.
   */
  reachedCheckout: boolean;
}

export interface SettingsView {
  wholesale: WholesaleSettingsView;
  display: DisplaySettingsView;
  discounts: DiscountSettingsView;
  tax: TaxSettingsView;
  orders: OrderSettingsView;
  agent: AgentControlsView;
  sender: SenderSettingsView;
  danger: DangerZoneView;
  /** The section that was just saved, for the "Saved" confirmation. */
  saved: string | null;
  /** The section whose save failed, and the fields that stopped it. */
  failedSection: string | null;
  issues: SettingsIssueView[];
}
