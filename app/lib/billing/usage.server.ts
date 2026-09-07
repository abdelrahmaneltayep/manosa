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
 * The counts are zero until the features that produce them exist — pricing
 * rules in phase 1.3, forms in 2.2. Each is a one-line change here when its
 * table lands, and `tests/unit/usage.test.ts` covers the meter arithmetic now
 * so those changes arrive already verified.
 */
async function countUsage(): Promise<Record<LimitKey, number>> {
  shopScope.require("countUsage");

  return {
    // TODO(phase 1.3): db.pricingRule.count({ where: { archivedAt: null } })
    pricingRules: 0,
    // TODO(phase 2.2): db.registrationForm.count({ where: { archivedAt: null } })
    forms: 0,
  };
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
