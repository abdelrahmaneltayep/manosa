import type { ReasonCode, RejectionReason } from "~/lib/forms/approval";
import type { TagCondition, TagRuleIssue } from "~/lib/customers/tagging";

/**
 * Everything the customer screens render, as plain serialisable data.
 *
 * The pages are pure functions of these, so every state in checklist §3 —
 * empty, still syncing, deleted in Shopify, group gone, over plan — is
 * rendered and asserted in a test. The embedded admin cannot be driven outside
 * the Shopify iframe, so this is where those states are actually exercised.
 */

export interface CustomerRowView {
  id: string;
  /** Company if we have one, otherwise the person's name, otherwise email. */
  name: string;
  email: string | null;
  /** Null when they belong to no group — priced by tags alone. */
  group: { id: string; name: string; color: string | null } | null;
  /** "Net 30", or null when they pay up front. */
  terms: string | null;
  /** Formatted through the pricing engine's money formatter. Shopify's own
   *  lifetime total, not a price this app computed. */
  lifetimeSpend: string;
  orderCount: number;
  /** ISO date, or null when they have never ordered. */
  lastOrderAt: string | null;
  /** Whole days since the last order, or null. */
  daysSinceLastOrder: number | null;
  atRisk: boolean;
  taxExempt: boolean;
  status: "PENDING" | "APPROVED" | "REJECTED";
  tags: string[];
  /** Set when Shopify no longer has this customer. */
  deletedInShopify: boolean;
  /** ✦ Reorder prediction. Needs the AI layer, so false until phase 4. */
  dueToReorder: boolean;
}

export interface CustomerListView {
  rows: CustomerRowView[];
  total: number;
  page: number;
  pageSize: number;
  /** Buyers before filters — tells "no buyers yet" from "nothing matched". */
  totalUnfiltered: number;
  search: string;
  filters: {
    groupId: string;
    terms: string;
    taxExempt: string;
    atRisk: boolean;
  };
  /** Groups for the filter and the row's group picker. */
  groups: { id: string; name: string }[];
  /** True while the first sync from Shopify is still running. */
  syncing: boolean;
  /** Customers mirrored so far, shown during the first sync. */
  syncedSoFar: number;
  /** Set when Shopify did not answer and this list is from our mirror only. */
  staleMinutesAgo: number | null;
  /** Buyers whose group was deleted and now price on tags alone. */
  orphanedCount: number;
  /** The store's own word for a wholesale buyer. */
  wholesaleTag: string;
  /** How many days without an order counts as at risk. */
  atRiskDays: number;
  /** ✦ Segment builder needs the AI layer (phase 4.3). */
  aiAvailable: boolean;
}

export interface GroupRowView {
  id: string;
  name: string;
  handle: string;
  tag: string;
  color: string | null;
  memberCount: number;
  terms: string | null;
  /** Active pricing rules whose audience names this group's tag. */
  pricingRuleCount: number;
}

export interface GroupListView {
  rows: GroupRowView[];
  /** Starter templates still on offer. Empty once both have been taken. */
  templates: { key: string; name: string }[];
  /** Set when a delete was refused because the group still has members. */
  blockedDelete: { id: string; name: string; memberCount: number } | null;
  /** Destinations offered when a delete is blocked. */
  destinations: { id: string; name: string }[];
  error: "duplicate_handle" | null;
}

export interface GroupBundleSection {
  key: "pricing" | "limits" | "terms" | "shipping" | "visibility";
  /** Where the merchant goes to change it. */
  href: string | null;
  /** One line of what is attached today. */
  summary: string;
  /** True while the feature that owns this section has not shipped. */
  comingIn: string | null;
}

export interface GroupDetailView {
  group: GroupRowView & {
    description: string | null;
    /** Days as typed, so a rejected form gives back what was entered. */
    netTermsDays: string;
    /** Decimal, in the shop's currency. Empty means no ceiling. */
    creditLimit: string;
  };
  currencyCode: string;
  sections: GroupBundleSection[];
  members: CustomerRowView[];
  memberTotal: number;
  page: number;
  pageSize: number;
  saving: boolean;
  error: "duplicate_handle" | null;
}

export interface CustomerDetailView {
  customer: CustomerRowView & {
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    phone: string | null;
    countryCode: string | null;
    vatNumber: string | null;
    vatVerifiedAt: string | null;
    internalNote: string | null;
    currencyCode: string;
    syncedAt: string;
    /** This buyer's own terms. Empty means "whatever their group says". */
    netTermsDays: string;
    creditLimit: string;
  };
  /** Already-translated summary of the terms that actually apply to them. */
  terms: {
    summary: string;
    /** True when their own terms replace their group's — the chip. */
    overridden: boolean;
    /** The group's terms, named so the merchant knows what they are replacing. */
    groupSummary: string | null;
    /** Already-formatted, e.g. "$1,200.50 outstanding · 1 overdue". */
    ledgerSummary: string | null;
    ledgerHref: string;
  };
  groups: { id: string; name: string }[];
  /** Tags already in use in this store, for the tag field's autocomplete. */
  knownTags: string[];
  /** Set when tax-exempt was refused for want of a VAT id. */
  vatRequired: boolean;
  saving: boolean;
}

export interface TagRuleRowView {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  matchMode: "all" | "any";
  conditions: TagCondition[];
  /** Rendered sentences, one per condition. */
  conditionSummaries: string[];
  addTags: string[];
  removeTags: string[];
  lastRunAt: string | null;
  lastMatchCount: number | null;
  /** Conditions that could not be read. The rule is held back if any are. */
  unreadableCount: number;
}

export interface TagRuleListView {
  rows: TagRuleRowView[];
  /** Plan does not include auto-tagging. The list is a teaser only. */
  locked: boolean;
  /** The plan that unlocks it, when locked. */
  requiredPlan: string | null;
  /** Result of the last preview the merchant asked for. */
  preview: {
    examined: number;
    changed: number;
    /** A few examples, so "84 customers" is inspectable rather than a claim. */
    samples: { name: string; add: string[]; remove: string[] }[];
  } | null;
  /** Result of the last sweep that actually ran. */
  lastRun: { changed: number; failed: number; examined: number } | null;
  issues: TagRuleIssue[];
}

export interface ApplicationRowView {
  id: string;
  company: string | null;
  contact: string;
  email: string;
  formName: string;
  /** Whole days since it arrived. Zero means today. */
  daysAgo: number;
  submittedAt: string;
  vatStatus: "NONE" | "VALID" | "INVALID" | "UNVERIFIED";
  vatNote: string | null;
  uploads: { id: string; fileName: string; scanned: boolean }[];
  /** The evaluator's verdict. `null` when the merchant has not set criteria. */
  criteria: { met: boolean; reasons: ReasonCode[] } | null;
  /** Other applications waiting from the same email domain. */
  sameDomainCount: number;
  /** They already have a Shopify customer account. */
  existingCustomer: boolean;
  /** ✦ Claude's read on it. A recommendation — never a decision. */
  screening: ScreeningRowView;
}

export interface ScreeningRowView {
  /**
   * `waiting` is genuinely "not looked at yet"; `unavailable` means it ran and
   * could not answer; `off` means nothing was ever attempted. Three different
   * sentences, because a merchant acts differently on each.
   */
  status: "waiting" | "recommend" | "look" | "unavailable" | "off";
  /** Signal codes and their numbers. Sentences are ours, so they translate. */
  reasons: { signal: string; detail: number | null }[];
}

export interface ApplicationsView {
  rows: ApplicationRowView[];
  total: number;
  page: number;
  pageSize: number;
  /** Applications waiting before filters — tells empty from no-results. */
  totalWaiting: number;
  search: string;
  /** Groups an approved buyer can join, with their terms. */
  groups: { id: string; name: string; terms: string | null }[];
  /** The live form to share from the empty state, if there is one. */
  shareUrl: string | null;
  /** True while the first page of applications is still loading. */
  loading: boolean;
  /** Set right after an approval, while it can still be taken back. */
  undo: { id: string; who: string; secondsLeft: number } | null;
  /** Set when an undo arrived too late. */
  undoExpired: boolean;
  /** The application whose email is being edited before sending. */
  editing: {
    id: string;
    intent: "approve" | "reject";
    subject: string;
    body: string;
    /** The reason a reject email was drafted around, carried back on send. */
    reason: string;
    note: string;
  } | null;
  /** Reasons offered in the reject flow. */
  rejectionReasons: RejectionReason[];
  /** True when there is a key, so screening can say anything at all. */
  aiScreening: boolean;
  /**
   * Why screening is off, when it is.
   *
   * The copy used to name the API key for every reason, so a merchant who had
   * switched screening off in Settings was told a false fact about their
   * deployment and sent to fix something that was not broken — which is the
   * exact sentence `docs/adr/0027` exists to replace.
   */
  screeningBlockedBy: "permission" | "plan" | "no_key" | null;
  /** ✦ Claude drafted the email in the panel; the merchant edits and sends. */
  emailDraft: { drafted: boolean; failure: string | null };
  /** No mail provider is configured, so no applicant is being told anything. */
  emailUnavailable: boolean;
}

/* -------------------------------------------------------------------------- */
/* ✦ Segment builder                                                           */
/* -------------------------------------------------------------------------- */

/** One condition as a chip: pre-rendered label, plus what it takes to remove. */
export interface SegmentChipView {
  index: number;
  /** Translated by the server — the label needs the group's name and money. */
  label: string;
  /** True when this is the chip the merchant should loosen first. */
  loosen: boolean;
}

export interface SegmentClarificationView {
  index: number;
  term: string;
  options: { id: string; label: string }[];
}

export interface SegmentDraftView {
  name: string;
  chips: SegmentChipView[];
  /** Live count for the chips as they stand. Null before it has been run. */
  count: number | null;
  /** A few members, so the count is inspectable. */
  samples: { id: string; name: string; email: string | null }[];
  /** Carried back on every round trip; re-read and re-checked each time. */
  payload: string;
  notes: string | null;
  clarifications: SegmentClarificationView[];
}

export interface SavedSegmentView {
  id: string;
  name: string;
  conditionCount: number;
  /** The last count and when it was taken — never presented as live truth. */
  lastCount: number | null;
  lastCountAt: string | null;
  fromSentence: boolean;
}

export interface SegmentsView {
  aiAvailable: boolean;
  sentence: string;
  examples: string[];
  /** Why there is no draft. Each one leaves the saved list untouched. */
  failure:
    | "no_key"
    | "timeout"
    | "rate_limited"
    | "refused"
    | "invalid_output"
    | "error"
    | "empty"
    | null;
  draft: SegmentDraftView | null;
  /** Set when saving was refused — a duplicate name, or nothing to save. */
  saveError: "duplicate_name" | "invalid" | null;
  saved: SavedSegmentView[];
}
