import { compareMoney, money, subtractMoney, type Money } from "@mannon/pricing-engine";

import type { CartFacts, LimitVerdict, OrderLimit, Violation } from "./types";

/**
 * Which limit applies to this buyer, and whether their cart satisfies it.
 *
 * Exactly one limit applies. A cart that had to satisfy several would be one a
 * merchant cannot reason about — "add $38" and "remove 4 items" at the same
 * time — so the most specific one wins and the rest are ignored: the buyer's
 * group first, then the store-wide fallback.
 */

const sameCountry = (a: string, b: string) =>
  a.trim().toUpperCase() === b.trim().toUpperCase();

function appliesInCountry(limit: OrderLimit, countryCode: string | null): boolean {
  if (limit.countries.length === 0) return true;
  // An unknown country does not satisfy a country-scoped limit. Failing open
  // here is the safe direction: a limit is a restriction, and applying one we
  // are not sure about would block a real order.
  if (!countryCode) return false;
  return limit.countries.some((code) => sameCountry(code, countryCode));
}

/** The limit that governs this buyer, or null. */
export function limitFor(
  limits: readonly OrderLimit[],
  cart: CartFacts,
): OrderLimit | null {
  const usable = limits.filter(
    (limit) => limit.enabled && appliesInCountry(limit, cart.countryCode),
  );

  // Most specific first: a tier's own limit beats the store-wide one.
  const forGroup = usable.find(
    (limit) => limit.groupId !== null && cart.groupIds.includes(limit.groupId),
  );
  if (forGroup) return forGroup;

  return usable.find((limit) => limit.groupId === null) ?? null;
}

/** Why no limit applied, so the caller can say something true about it. */
function skipReason(
  limits: readonly OrderLimit[],
  cart: CartFacts,
): LimitVerdict["skipped"] {
  if (limits.length === 0) return "no_limit_for_this_buyer";
  if (limits.every((limit) => !limit.enabled)) return "disabled";

  const enabled = limits.filter((limit) => limit.enabled);
  if (enabled.every((limit) => !appliesInCountry(limit, cart.countryCode))) {
    return "wrong_country";
  }
  return "no_limit_for_this_buyer";
}

export function evaluateLimits(
  limits: readonly OrderLimit[],
  cart: CartFacts,
  options: { posBypasses?: boolean } = {},
): LimitVerdict {
  // A limit is a rule about wholesale buyers. A guest browsing the same
  // storefront has no tier and no terms, and telling them they are $38 short
  // of a minimum they were never subject to is nonsense.
  if (!cart.isAuthenticated) {
    return { violations: [], applied: null, skipped: "guest" };
  }

  // A minimum written for a website is not a rule about a till.
  if (cart.isPos && options.posBypasses !== false) {
    return { violations: [], applied: null, skipped: "pos_bypass" };
  }

  // An empty cart is not an order. This runs on the cart page as well as at
  // checkout, and "add $200 to reach your $200 minimum" on an empty basket is
  // noise in front of somebody who has not started yet.
  if (cart.totalQuantity <= 0 && cart.subtotal.amount <= 0) {
    return { violations: [], applied: null, skipped: "empty_cart" };
  }

  const applied = limitFor(limits, cart);
  if (!applied) {
    return { violations: [], applied: null, skipped: skipReason(limits, cart) };
  }

  return { violations: violationsFor(applied, cart), applied, skipped: null };
}

function violationsFor(limit: OrderLimit, cart: CartFacts): Violation[] {
  const violations: Violation[] = [];

  if (limit.minSubtotal && sameCurrency(limit.minSubtotal, cart.subtotal)) {
    if (compareMoney(cart.subtotal, limit.minSubtotal) < 0) {
      violations.push({
        code: "below_minimum_subtotal",
        limitId: limit.id,
        required: limit.minSubtotal,
        actual: cart.subtotal,
        gap: subtractMoney(limit.minSubtotal, cart.subtotal),
      });
    }
  }

  if (limit.maxSubtotal && sameCurrency(limit.maxSubtotal, cart.subtotal)) {
    if (compareMoney(cart.subtotal, limit.maxSubtotal) > 0) {
      violations.push({
        code: "above_maximum_subtotal",
        limitId: limit.id,
        required: limit.maxSubtotal,
        actual: cart.subtotal,
        gap: subtractMoney(cart.subtotal, limit.maxSubtotal),
      });
    }
  }

  if (limit.minQuantity !== null && cart.totalQuantity < limit.minQuantity) {
    violations.push({
      code: "below_minimum_quantity",
      limitId: limit.id,
      required: limit.minQuantity,
      actual: cart.totalQuantity,
      gap: limit.minQuantity - cart.totalQuantity,
    });
  }

  if (limit.maxQuantity !== null && cart.totalQuantity > limit.maxQuantity) {
    violations.push({
      code: "above_maximum_quantity",
      limitId: limit.id,
      required: limit.maxQuantity,
      actual: cart.totalQuantity,
      gap: cart.totalQuantity - limit.maxQuantity,
    });
  }

  const increment = limit.quantityIncrement;
  if (increment !== null && increment > 1 && cart.totalQuantity > 0) {
    const remainder = cart.totalQuantity % increment;
    if (remainder !== 0) {
      violations.push({
        code: "not_a_multiple",
        limitId: limit.id,
        required: increment,
        actual: cart.totalQuantity,
        // Up to the next case, not down: a buyer told to remove items to make
        // a case pack work is being asked to buy less, which is not what a
        // case pack is for.
        gap: increment - remainder,
      });
    }
  }

  return violations;
}

/**
 * Money is never compared across currencies.
 *
 * A limit written in USD says nothing about a cart priced in EUR, and guessing
 * would block a real order on an exchange rate we invented.
 */
function sameCurrency(a: Money, b: Money): boolean {
  return a.currencyCode === b.currencyCode;
}

/** Convenience for callers building a cart from integers. */
export function cartSubtotal(amount: number, currencyCode: string): Money {
  return money(amount, currencyCode);
}
