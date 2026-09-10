import {
  addMoney,
  compareMoney,
  money,
  subtractMoney,
  zero,
  type Money,
} from "@mannon/pricing-engine";

import type { Eligibility, Terms, TermsSource } from "./types";

/**
 * Whose terms apply.
 *
 * A buyer's own terms replace their group's; they do not add to them and they
 * do not merge field by field. Merging would produce terms neither the merchant
 * nor the buyer ever agreed to — Net 30 from the tier with a credit limit from
 * the override is a third arrangement nobody wrote down.
 *
 * A buyer with no days set has no terms, whatever their credit limit says: a
 * ceiling on an agreement that does not exist is not an agreement.
 */
export function effectiveTerms(
  customer: TermsSource | null,
  group: TermsSource | null,
): Terms | null {
  const chosen =
    customer && customer.days !== null
      ? { level: "customer" as const, source: customer }
      : group && group.days !== null
        ? { level: "group" as const, source: group }
        : null;

  if (!chosen || chosen.source.days === null) return null;
  if (!Number.isInteger(chosen.source.days) || chosen.source.days <= 0) return null;

  return {
    days: chosen.source.days,
    creditLimit: null,
    source: chosen.level,
  };
}

/**
 * The same choice, with the credit limit resolved in the shop's currency.
 *
 * Split from `effectiveTerms` because the currency is not the pure module's to
 * know — the caller has it, and a limit built with the wrong one would compare
 * two amounts that are not comparable.
 */
export function termsWithLimit(
  customer: TermsSource | null,
  group: TermsSource | null,
  currencyCode: string,
): Terms | null {
  const terms = effectiveTerms(customer, group);
  if (!terms) return null;

  const level = terms.source === "customer" ? customer : group;
  const limit = level?.creditLimit ?? null;

  return {
    ...terms,
    creditLimit: limit === null || limit < 0 ? null : money(limit, currencyCode),
  };
}

/** True when a buyer's own terms replace a group's — the "overridden" chip. */
export function isOverridden(
  customer: TermsSource | null,
  group: TermsSource | null,
): boolean {
  return (
    customer?.days !== null &&
    customer?.days !== undefined &&
    group?.days !== null &&
    group?.days !== undefined
  );
}

export interface EligibilityFacts {
  /** Terms only exist for a buyer with an account we can recognise. */
  isAuthenticated: boolean;
  terms: Terms | null;
  /** What they already owe. */
  outstanding: Money;
  /** How many of those invoices are past their due date. */
  overdueCount: number;
  /** What they are trying to put on terms now. */
  cartTotal: Money;
}

/**
 * May this buyer pay later?
 *
 * One function, asked by the checkout Function, the ledger and — later — the
 * Buyer Agent, so all three give the same answer with the same number in it.
 * The checklist is explicit that they must: "buyer at credit limit → agent and
 * checkout both say so with the same number".
 *
 * Never throws, and never returns a bare `false`: an ineligible buyer is told
 * nothing at checkout (the method is simply absent), but the merchant's admin
 * has to be able to say why.
 */
export function checkEligibility(facts: EligibilityFacts): Eligibility {
  const { terms } = facts;

  if (!facts.isAuthenticated) {
    return { eligible: false, reason: "not_authenticated", terms: null, headroom: null };
  }

  if (!terms) {
    return { eligible: false, reason: "no_terms", terms: null, headroom: null };
  }

  // An overdue invoice stops further credit before a limit does. A buyer who
  // has not paid the last one is the case a credit limit is a proxy for, and
  // saying "you are over your limit" when they are not would be wrong.
  if (facts.overdueCount > 0) {
    return { eligible: false, reason: "has_overdue", terms, headroom: null };
  }

  if (!terms.creditLimit) {
    return { eligible: true, reason: null, terms, headroom: null };
  }

  // Currencies that do not match are not compared. A store whose buyer checks
  // out in another currency gets no terms rather than a limit enforced against
  // a number that means something else.
  if (
    facts.outstanding.currencyCode !== terms.creditLimit.currencyCode ||
    facts.cartTotal.currencyCode !== terms.creditLimit.currencyCode
  ) {
    return { eligible: false, reason: "over_credit_limit", terms, headroom: null };
  }

  const headroom = subtractMoney(terms.creditLimit, facts.outstanding);
  const wouldOwe = addMoney(facts.outstanding, facts.cartTotal);

  if (compareMoney(wouldOwe, terms.creditLimit) > 0) {
    return {
      eligible: false,
      reason: "over_credit_limit",
      terms,
      // Never negative: a buyer already past their limit has no headroom, and
      // "-$300 remaining" is not a sentence anybody should read.
      headroom: headroom.amount > 0 ? headroom : zero(terms.creditLimit.currencyCode),
    };
  }

  return { eligible: true, reason: null, terms, headroom };
}

/** When an order placed now falls due. */
export function dueDateFor(placedAt: Date, days: number): Date {
  const due = new Date(placedAt.getTime());
  due.setUTCDate(due.getUTCDate() + days);
  return due;
}
