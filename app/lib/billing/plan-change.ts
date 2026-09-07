import {
  PLANS,
  type FeatureKey,
  type LimitKey,
  type PlanInterval,
  type PlanKey,
} from "~/lib/billing/plans";

export type ChangeDirection = "upgrade" | "downgrade" | "interval-only" | "same";

export interface LimitImpact {
  key: LimitKey;
  used: number;
  /** null = unlimited after the change. */
  becomes: number | null;
  /** How many exist beyond what the target plan allows. */
  overBy: number;
}

export interface PlanChange {
  from: PlanKey;
  to: PlanKey;
  fromInterval: PlanInterval | null;
  toInterval: PlanInterval;
  direction: ChangeDirection;
  /** Capabilities the merchant gains. */
  gaining: FeatureKey[];
  /** Capabilities that will pause. Nothing is deleted. */
  losing: FeatureKey[];
  /** Quotas that tighten, and by how much the shop is already over. */
  limitImpacts: LimitImpact[];
  /** True when something the merchant already made would be paused. */
  hasOverage: boolean;
  price: number;
}

/**
 * Work out exactly what changing plan does — before the merchant is charged.
 *
 * Pure, and it enumerates losses rather than glossing them: the Plans page has
 * to be able to say "these three rules pause" and mean it. Built for Shopify
 * forbids dark patterns, so a downgrade must be as legible as an upgrade.
 */
export function planChangeFor({
  from,
  to,
  fromInterval,
  toInterval,
  usage,
}: {
  from: PlanKey;
  to: PlanKey;
  fromInterval: PlanInterval | null;
  toInterval: PlanInterval;
  usage: Record<LimitKey, number>;
}): PlanChange {
  const source = PLANS[from];
  const target = PLANS[to];

  const direction: ChangeDirection =
    target.rank > source.rank
      ? "upgrade"
      : target.rank < source.rank
        ? "downgrade"
        : fromInterval && fromInterval !== toInterval
          ? "interval-only"
          : "same";

  const gaining = target.features.filter((feature) => !source.features.includes(feature));
  const losing = source.features.filter((feature) => !target.features.includes(feature));

  const limitImpacts: LimitImpact[] = (Object.keys(usage) as LimitKey[]).flatMap(
    (key) => {
      const becomes = target.limits[key];
      const current = source.limits[key];

      // Only report a limit that actually tightens.
      const tightens = becomes !== null && (current === null || becomes < current);
      if (!tightens) return [];

      const used = usage[key];
      return [{ key, used, becomes, overBy: Math.max(0, used - becomes) }];
    },
  );

  return {
    from,
    to,
    fromInterval,
    toInterval,
    direction,
    gaining: [...gaining],
    losing: [...losing],
    limitImpacts,
    hasOverage: limitImpacts.some((impact) => impact.overBy > 0),
    price: toInterval === "annual" ? target.annualPrice : target.monthlyPrice,
  };
}
