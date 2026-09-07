import {
  hasFeature,
  limitFor,
  loadEntitlements,
  type Entitlements,
} from "~/lib/billing/entitlements.server";
import {
  lowestPlanWithFeature,
  PLANS,
  type FeatureKey,
  type LimitKey,
  type PlanKey,
} from "~/lib/billing/plans";

/**
 * Thrown when a request asks for something the shop's plan does not include.
 *
 * Carries the plan that would unlock it, so the UI can offer a specific
 * upgrade instead of a generic wall.
 */
export class FeatureLockedError extends Error {
  readonly kind = "feature-locked" as const;

  constructor(
    readonly feature: FeatureKey,
    readonly currentPlan: PlanKey,
    readonly requiredPlan: PlanKey,
  ) {
    super(
      `"${feature}" is not included in the ${currentPlan} plan. It unlocks on ${requiredPlan}.`,
    );
    this.name = "FeatureLockedError";
  }
}

export class LimitReachedError extends Error {
  readonly kind = "limit-reached" as const;

  constructor(
    readonly limit: LimitKey,
    readonly used: number,
    readonly allowed: number,
    readonly currentPlan: PlanKey,
    readonly requiredPlan: PlanKey,
  ) {
    super(
      `The ${currentPlan} plan allows ${allowed} ${limit} and ${used} are in use. ` +
        `${requiredPlan} removes the limit.`,
    );
    this.name = "LimitReachedError";
  }
}

/**
 * Server-side gate. Every action that creates or uses a paid capability calls
 * one of these.
 *
 * The teaser and the disabled button in the UI are courtesy; this is the
 * enforcement. A merchant who crafts the request by hand still gets stopped
 * here, which is the whole point of gating on the server.
 */
export async function assertFeature(
  feature: FeatureKey,
  entitlements?: Entitlements,
): Promise<Entitlements> {
  const current = entitlements ?? (await loadEntitlements());
  if (!hasFeature(current, feature)) {
    throw new FeatureLockedError(
      feature,
      current.effectivePlan,
      lowestPlanWithFeature(feature),
    );
  }
  return current;
}

/**
 * Check a quota before creating the (n+1)th thing.
 *
 * `used` is passed in rather than counted here so the caller can count inside
 * the same transaction as the insert. Counting separately leaves a race where
 * two concurrent creates both see `used = limit - 1`.
 */
export async function assertWithinLimit(
  limit: LimitKey,
  used: number,
  entitlements?: Entitlements,
): Promise<Entitlements> {
  const current = entitlements ?? (await loadEntitlements());
  const allowed = limitFor(current, limit);

  if (allowed !== null && used >= allowed) {
    throw new LimitReachedError(
      limit,
      used,
      allowed,
      current.effectivePlan,
      firstPlanWithoutLimit(limit),
    );
  }
  return current;
}

/** The cheapest plan that removes a quota. */
function firstPlanWithoutLimit(limit: LimitKey): PlanKey {
  const found = Object.values(PLANS)
    .sort((a, b) => a.rank - b.rank)
    .find((plan) => plan.limits[limit] === null);
  return found?.key ?? "agentic";
}

export function isPlanGateError(
  error: unknown,
): error is FeatureLockedError | LimitReachedError {
  return error instanceof FeatureLockedError || error instanceof LimitReachedError;
}
