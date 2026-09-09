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
  group: GroupRowView & { description: string | null };
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
