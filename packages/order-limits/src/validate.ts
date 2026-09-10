import { compareMoney } from "@mannon/pricing-engine";

import type { OrderLimit } from "./types";

/**
 * Checking a limit before it is saved.
 *
 * The checklist asks for one thing in particular: a minimum above a maximum is
 * blocked inline. It has to be, because such a limit blocks *every* order and
 * the merchant would find out from a buyer who cannot check out.
 */

export type LimitIssueCode =
  | "no_bounds"
  | "min_above_max_subtotal"
  | "min_above_max_quantity"
  | "negative"
  | "increment_too_small"
  | "increment_conflicts_with_minimum"
  | "increment_conflicts_with_maximum";

export interface LimitIssue {
  code: LimitIssueCode;
  /** Filled into the message: the number that makes the conflict concrete. */
  detail?: string;
}

export function validateLimit(limit: OrderLimit): LimitIssue[] {
  const issues: LimitIssue[] = [];

  const hasBound =
    limit.minSubtotal !== null ||
    limit.maxSubtotal !== null ||
    limit.minQuantity !== null ||
    limit.maxQuantity !== null ||
    (limit.quantityIncrement !== null && limit.quantityIncrement > 1);

  if (!hasBound) issues.push({ code: "no_bounds" });

  for (const amount of [limit.minSubtotal, limit.maxSubtotal]) {
    if (amount && amount.amount < 0) issues.push({ code: "negative" });
  }
  for (const count of [limit.minQuantity, limit.maxQuantity]) {
    if (count !== null && count < 0) issues.push({ code: "negative" });
  }

  if (
    limit.minSubtotal &&
    limit.maxSubtotal &&
    limit.minSubtotal.currencyCode === limit.maxSubtotal.currencyCode &&
    compareMoney(limit.minSubtotal, limit.maxSubtotal) > 0
  ) {
    issues.push({ code: "min_above_max_subtotal" });
  }

  if (
    limit.minQuantity !== null &&
    limit.maxQuantity !== null &&
    limit.minQuantity > limit.maxQuantity
  ) {
    issues.push({ code: "min_above_max_quantity" });
  }

  const increment = limit.quantityIncrement;
  if (increment !== null && increment !== 0 && increment < 2) {
    // An increment of 1 constrains nothing and an increment of 0 is a division
    // by zero waiting to happen. Both mean "no case packs", which is what null
    // says without pretending.
    issues.push({ code: "increment_too_small" });
  }

  if (increment !== null && increment > 1) {
    // A minimum of 10 with cases of 4 means the smallest allowed order is 12,
    // which is not what the merchant typed. Better said out loud than
    // discovered by a buyer.
    if (limit.minQuantity !== null && limit.minQuantity % increment !== 0) {
      issues.push({
        code: "increment_conflicts_with_minimum",
        detail: String(Math.ceil(limit.minQuantity / increment) * increment),
      });
    }
    // A maximum below one case makes every order impossible.
    if (limit.maxQuantity !== null && limit.maxQuantity < increment) {
      issues.push({ code: "increment_conflicts_with_maximum" });
    }
  }

  return issues;
}
