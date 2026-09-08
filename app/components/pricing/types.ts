import type { RuleIssue, RuleKind, RuleStatus, SkipReason } from "@mannon/pricing-engine";

/**
 * Everything the pricing screens render, as plain serialisable data.
 *
 * The pages are pure functions of these, so every state in checklist §2 —
 * empty, partial, cached, conflicted, over quota — is rendered and asserted in
 * a test. The embedded admin cannot be driven outside the Shopify iframe, so
 * this is where those states are actually exercised.
 */

export interface RuleRowView {
  id: string;
  name: string;
  kind: RuleKind;
  status: RuleStatus;
  priority: number;
  /** Pre-summarised: "3 collections", "Tagged wholesale". */
  targetsSummary: string;
  audienceSummary: string;
  /** null means never measured, which is not the same as zero. */
  usage30d: number | null;
  /** Older than 30 days with no uses. A new rule is never flagged. */
  unused: boolean;
  missingTargetCount: number;
  /** Whole days until it starts, or null. */
  startsInDays: number | null;
  endsInDays: number | null;
  ended: boolean;
  duplicateName: boolean;
  archivedAt: string | null;
}

export interface RuleListView {
  rows: RuleRowView[];
  total: number;
  page: number;
  pageSize: number;
  /** Rules in this shop ignoring search — tells empty from no-results. */
  totalUnfiltered: number;
  search: string;
  archived: boolean;
  sort: string;
  /** Rules whose stored shape could not be read. Always zero in practice. */
  unreadableCount: number;
  /** Set when Shopify did not answer and this list is from cache. */
  cachedMinutesAgo: number | null;
  /** How many rules are live at checkout, and when they got there. */
  published: { ruleCount: number; at: string | null } | null;
  /** Set when the last publish failed. */
  publishError: "failed" | "too_large" | null;
  /** Free plan has run out of rules. */
  atRuleLimit: boolean;
  /** ✦ Describe a rule needs the AI layer (phase 4.2). */
  aiAvailable: boolean;
}

export interface TierView {
  minQuantity: string;
  maxQuantity: string;
  kind: "percentage" | "amount_off" | "fixed_price";
  value: string;
}

export interface RuleFormView {
  id: string | null;
  version: number;
  name: string;
  status: RuleStatus;
  kind: RuleKind;
  priority: number;
  combinable: boolean;
  percentage: string;
  amount: string;
  cartMinimum: string;
  tiers: TierView[];
  targetMode: string;
  targetCollectionIds: string;
  targetProductIds: string;
  targetVariantIds: string;
  excludeCollectionIds: string;
  audienceMode: string;
  audienceTags: string;
  audienceCustomerIds: string;
  audienceCompanyIds: string;
  marketMode: string;
  marketIds: string;
  startsAt: string;
  endsAt: string;
  currencyCode: string;
}

export interface PreviewView {
  /** Shelf price, formatted. */
  was: string;
  /** What the buyer pays, formatted. */
  now: string;
  changed: boolean;
  quantity: number;
  /** Set when the preview itself failed — never blocks saving. */
  unavailable: boolean;
}

export interface RuleBuilderView {
  form: RuleFormView;
  issues: RuleIssue[];
  /** Another rule already has this name. A warning, not an error. */
  duplicateName: string | null;
  preview: PreviewView | null;
  /** Someone else saved this rule while it was open. */
  conflict: { name: string; theirVersion: number; theirUpdatedAt: string } | null;
  saving: boolean;
}

export interface TraceRowView {
  ruleId: string;
  ruleName: string;
  applied: boolean;
  reason: SkipReason | null;
  priceAfter: string | null;
}

export interface ExplainView {
  unitPrice: string;
  basePrice: string;
  clampedAtZero: boolean;
  trace: TraceRowView[];
}

export interface PricingSettingsView {
  /** In the order they resolve: first in the list wins. */
  order: { id: string; name: string; kind: RuleKind; combinable: boolean }[];
  anyCombinable: boolean;
  explain: ExplainView | null;
  explainInput: {
    variantId: string;
    tags: string;
    quantity: string;
    price: string;
  };
  orderSaved: boolean;
}
