import { subtractMoney, type Money } from "./money";
import type { PriceResolution } from "./types";

export interface MarginReport {
  unitPrice: Money;
  unitCost: Money;
  /** Price less cost. Negative means the rule sells below cost. */
  margin: Money;
  /** Margin as a share of price, or null when the price is zero. */
  marginRatio: number | null;
  belowCost: boolean;
}

/**
 * What a resolved price leaves after cost.
 *
 * The margin guard (spec §2) warns before a rule is saved, and the analytics
 * pages report on the same number. Both read it from here so a "sells below
 * cost" warning and the price it is warning about can never disagree.
 */
export function marginFor(resolution: PriceResolution, unitCost: Money): MarginReport {
  const margin = subtractMoney(resolution.unitPrice, unitCost);

  return {
    unitPrice: resolution.unitPrice,
    unitCost,
    margin,
    marginRatio:
      resolution.unitPrice.amount === 0
        ? null
        : margin.amount / resolution.unitPrice.amount,
    belowCost: margin.amount < 0,
  };
}
