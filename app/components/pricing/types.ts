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
  /**
   * How long an archived rule stays restorable.
   *
   * From `ARCHIVE_RETENTION_DAYS`, not typed into the page: the same number
   * appears in the audit entry the merchant reads and in the job that enforces
   * it, and two of the three being right is the kind of drift nobody notices.
   */
  archiveRetentionDays: number;
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

/* -------------------------------------------------------------------------- */
/* ✦ Describe a rule                                                           */
/* -------------------------------------------------------------------------- */

/** An ambiguous term from the draft, and the shop's best guesses at it. */
export interface ClarificationView {
  /** Stable form-field key: the field and the term the model used. */
  key: string;
  field: string;
  term: string;
  options: { id: string; label: string }[];
}

export interface MarginFindingView {
  /** SKU when the merchant set one, otherwise the product's name. */
  label: string;
  title: string;
  quantity: number;
  unitPrice: string;
  unitCost: string;
  shortfall: string;
}

export interface MarginGuardView {
  /** "unavailable" is a real answer: Shopify did not tell us, so we do not say. */
  status: "checked" | "unavailable";
  checked: number;
  costUnknown: number;
  /** The rule covers more than was priced. */
  sampled: boolean;
  belowCostCount: number;
  /** The three worst, which is what the chip lists. */
  worst: MarginFindingView[];
}

export interface DraftCardView {
  name: string;
  kindLabel: string;
  /** Tiers and the headline discount, as chips: "10–49 · 5% off". */
  chips: string[];
  targetsSummary: string;
  audienceSummary: string;
  scheduleSummary: string | null;
  combinable: boolean;
  /** What the model said it assumed. Shown verbatim, never as a fact. */
  notes: string | null;
  /** The draft, carried back to the server on approve, edit and answer. */
  payload: string;
  /** The same rule as the manual builder's fields, for "Edit". */
  builderFields: { name: string; value: string }[];
}

/** Why there is no draft on screen. Each one has a manual path beside it. */
export type DescribeFailure =
  | "no_key"
  | "timeout"
  | "rate_limited"
  | "refused"
  | "invalid_output"
  | "error"
  | "empty";

export interface DescribeRuleView {
  /** False when there is no Anthropic key: composer off, builder untouched. */
  aiAvailable: boolean;
  sentence: string;
  /** Three localized examples, shown under the box. */
  examples: string[];
  failure: DescribeFailure | null;
  draft: DraftCardView | null;
  clarifications: ClarificationView[];
  margin: MarginGuardView | null;
  /** Below-cost findings mean approving takes an explicit tick. */
  approveAnywayRequired: boolean;
  /** They approved without ticking it. */
  approveAnywayMissing: boolean;
  /** Free plan has run out of rules — approve would fail, so it says so first. */
  atRuleLimit: boolean;
}
