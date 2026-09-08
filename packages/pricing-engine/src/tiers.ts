import { compareMoney, type Money } from "./money";
import type { CartValueTier, VolumeTier } from "./types";

/**
 * The tier that applies at this quantity.
 *
 * Tiers are half-open at the top only where `maxQuantity` says so; a tier of
 * 5–19 covers exactly 5 through 19. Where two tiers would both match — which
 * validation rejects, but data can still arrive that way — the one with the
 * highest minimum wins, because that is the break the buyer actually reached.
 */
export function selectVolumeTier(
  tiers: readonly VolumeTier[],
  quantity: number,
): VolumeTier | null {
  let best: VolumeTier | null = null;

  for (const tier of tiers) {
    if (quantity < tier.minQuantity) continue;
    if (tier.maxQuantity !== null && quantity > tier.maxQuantity) continue;
    if (!best || tier.minQuantity > best.minQuantity) best = tier;
  }

  return best;
}

/** The next break above this quantity, if there is one. */
export function nextVolumeTier(
  tiers: readonly VolumeTier[],
  quantity: number,
): VolumeTier | null {
  let next: VolumeTier | null = null;

  for (const tier of tiers) {
    if (tier.minQuantity <= quantity) continue;
    if (!next || tier.minQuantity < next.minQuantity) next = tier;
  }

  return next;
}

export function selectCartValueTier(
  tiers: readonly CartValueTier[],
  subtotal: Money,
): CartValueTier | null {
  let best: CartValueTier | null = null;

  for (const tier of tiers) {
    if (tier.minSubtotal.currencyCode !== subtotal.currencyCode) continue;
    if (compareMoney(subtotal, tier.minSubtotal) < 0) continue;
    if (tier.maxSubtotal && compareMoney(subtotal, tier.maxSubtotal) > 0) continue;
    if (!best || compareMoney(tier.minSubtotal, best.minSubtotal) > 0) best = tier;
  }

  return best;
}
