import type { Money } from "@mannon/pricing-engine";

/**
 * Net payment terms: the agreement that a buyer may take the goods now and pay
 * within an agreed number of days.
 *
 * Two numbers make it up, and they answer different questions. `days` is how
 * long they have. `creditLimit` is how much they may owe at once. A merchant
 * can set either without the other, and the two fail in different ways — one
 * makes an invoice late, the other stops a checkout.
 */
export interface Terms {
  /** Net 15, 30, 60, 90, or whatever the merchant typed. */
  days: number;
  /** The most they may owe at once. Null means no ceiling. */
  creditLimit: Money | null;
  /**
   * Where this came from. A buyer's own terms replace their group's rather
   * than adding to them, and the admin shows an "overridden" chip so a merchant
   * is never surprised by a tier's terms not applying to somebody in it.
   */
  source: "customer" | "group";
}

/** Terms as they are stored, before the customer-over-group rule is applied. */
export interface TermsSource {
  /** Days, or null when this level sets none. */
  days: number | null;
  /** Minor units, or null for no ceiling. */
  creditLimit: number | null;
}

/**
 * One unpaid or part-paid order.
 *
 * `amount` is what the order came to; `paid` is what has been received against
 * it. Partial payments are a fact of wholesale, and an invoice that is only
 * ever "paid" or "not paid" makes a merchant do the arithmetic in their head.
 */
export interface Invoice {
  id: string;
  /** The order number as the merchant says it: "#1001". */
  name: string;
  amount: Money;
  paid: Money;
  /** Null when the order was never put on terms. */
  dueAt: Date | null;
  /** Set once it is settled in full. */
  paidAt: Date | null;
}

/**
 * The aging buckets from the checklist: current, then how long past due.
 *
 * These are the buckets a merchant's accountant already uses, which is the
 * reason for them — a wholesale ledger that invented its own bands would not
 * reconcile against anything.
 */
export type AgingBucket = "current" | "days_1_15" | "days_16_30" | "days_30_plus";

export const AGING_BUCKETS: readonly AgingBucket[] = [
  "current",
  "days_1_15",
  "days_16_30",
  "days_30_plus",
] as const;

export interface BucketTotal {
  bucket: AgingBucket;
  /** What is still owed in this bucket. */
  outstanding: Money;
  invoiceCount: number;
}

export interface AgingSummary {
  buckets: BucketTotal[];
  /** Everything still owed, across every bucket. */
  outstanding: Money;
  /** Owed and past its due date. */
  overdue: Money;
  overdueCount: number;
  invoiceCount: number;
}

/** Why a buyer may not pay later. Never a bare `false`. */
export type IneligibleReason =
  "not_authenticated" | "no_terms" | "over_credit_limit" | "has_overdue";

export interface Eligibility {
  eligible: boolean;
  /** Null when eligible. */
  reason: IneligibleReason | null;
  /** The terms that applied, when there were any. */
  terms: Terms | null;
  /**
   * What they could still put on terms, when a credit limit applies.
   *
   * The checklist's edge case: "buyer at credit limit → agent and checkout both
   * say so with the same number". This is that number, and it comes from here
   * so there is only ever one of it.
   */
  headroom: Money | null;
}
