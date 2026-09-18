import { db, type DbTransaction } from "~/db.server";
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
import { shopScope } from "~/lib/tenant/shop-context.server";

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

/**
 * Create the (n+1)th thing, with the count and the insert in one transaction.
 *
 * `assertWithinLimit` documents the race in its own docstring and could not
 * close it: `count()` → check → `create()` with the count outside a transaction
 * leaves two concurrent requests both seeing `limit - 1`. Measured, not
 * theorised — two concurrent `createForm` calls on a one-form plan, repeated
 * ten times, produced **two forms on nine of the ten attempts**.
 *
 * A transaction alone is not enough either: Postgres' default READ COMMITTED
 * lets both transactions count the same rows, because neither has written
 * anything the other can conflict on. So this takes a per-shop advisory lock
 * first — held until the transaction ends, released automatically however it
 * ends — which serialises exactly the shops that are racing and nothing else.
 *
 * Keyed on shop **and** limit, so a merchant creating a form does not wait
 * behind one creating a pricing rule.
 */
export async function createWithinLimit<T>(
  limit: LimitKey,
  count: (tx: DbTransaction) => Promise<number>,
  create: (tx: DbTransaction) => Promise<T>,
  entitlements?: Entitlements,
): Promise<T> {
  const shop = shopScope.require("createWithinLimit");
  const current = entitlements ?? (await loadEntitlements());

  // Unlimited plans pay nothing for the lock: there is no count to protect.
  if (limitFor(current, limit) === null) {
    return db.$transaction((tx) => create(tx));
  }

  return db.$transaction(async (tx) => {
    // `hashtextextended` gives a bigint, which is what the one-argument form
    // takes. Two shops colliding on the hash would only mean one waits for the
    // other, never a wrong answer.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${shop}:${limit}`}, 0))`;

    await assertWithinLimit(limit, await count(tx), current);
    return create(tx);
  });
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
