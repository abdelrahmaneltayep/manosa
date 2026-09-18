import { db } from "~/db.server";
import type { Entitlements } from "~/lib/billing/entitlements.server";
import { LIMIT_KEYS, type LimitKey } from "~/lib/billing/plans";
import { shopScope } from "~/lib/tenant/shop-context.server";

/** Meters warn here, before the merchant hits the wall. */
export const USAGE_WARNING_THRESHOLD = 0.8;

export interface UsageMeter {
  key: LimitKey;
  used: number;
  /** null = unlimited on this plan. */
  limit: number | null;
  /** 0–1 against the limit; null when unlimited. */
  ratio: number | null;
  nearingLimit: boolean;
  atLimit: boolean;
}

/**
 * Count what the shop is using against its quotas.
 *
 * These were hard-coded `0` behind `TODO(phase 1.3)` and `TODO(phase 2.2)`
 * long after both phases shipped, and the zeros were not inert. They made the
 * meters read "Pricing rules 0 of 1" on a shop with forty rules; they made the
 * 80% warning and the at-limit banner unable to fire at all; and they fed
 * `planChangeFor`, so the downgrade preview — the screen whose entire job is
 * to name what will pause — reported no overage for any downgrade, ever.
 *
 * Archived rows do not count, because they are not applying: the same
 * condition the quota itself is checked against on create.
 */
async function countUsage(): Promise<Record<LimitKey, number>> {
  shopScope.require("countUsage");

  const [pricingRules, forms] = await Promise.all([
    db.pricingRule.count({ where: { archivedAt: null } }),
    db.registrationForm.count({ where: { archivedAt: null } }),
  ]);

  return { pricingRules, forms };
}

export function meterFor(key: LimitKey, used: number, limit: number | null): UsageMeter {
  const ratio = limit === null || limit === 0 ? null : used / limit;
  return {
    key,
    used,
    limit,
    ratio,
    nearingLimit: ratio !== null && ratio >= USAGE_WARNING_THRESHOLD && ratio < 1,
    atLimit: ratio !== null && ratio >= 1,
  };
}

export async function loadUsageMeters(entitlements: Entitlements): Promise<UsageMeter[]> {
  const counts = await countUsage();
  return LIMIT_KEYS.map((key) => meterFor(key, counts[key], entitlements.limits[key]));
}

/** Used by the gate: how many of a thing exist right now. */
export async function usageFor(key: LimitKey): Promise<number> {
  const counts = await countUsage();
  return counts[key];
}
