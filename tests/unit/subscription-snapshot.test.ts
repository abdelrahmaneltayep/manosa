import type { AppSubscription } from "@shopify/shopify-api";
import { describe, expect, it } from "vitest";

import { readSubscriptions } from "~/lib/billing/subscription.server";

const NOW = new Date("2026-06-15T12:00:00Z");

const subscription = (overrides: Partial<AppSubscription> = {}): AppSubscription =>
  ({
    id: "gid://shopify/AppSubscription/1",
    name: "growth-monthly",
    test: false,
    status: "ACTIVE",
    trialDays: 0,
    createdAt: "2026-06-01T12:00:00Z",
    currentPeriodEnd: "2026-07-01T12:00:00Z",
    lineItems: [],
    ...overrides,
  }) as AppSubscription;

/**
 * The snapshot for a reading we understand.
 *
 * `readSubscriptions` answers "known, and here it is" or "not known, and here
 * is why" — because an empty list and an unrecognised plan name are not the
 * same fact as "this shop cancelled", and writing Free on either of them cut a
 * paying merchant off and erased their grace period on a page load.
 */
function snapshotOf(subscriptions: AppSubscription[], now: Date) {
  const reading = readSubscriptions(subscriptions, now);
  if (!reading.known) throw new Error(`expected a known reading: ${reading.detail}`);
  return reading.snapshot;
}

describe("reading Shopify's subscription state", () => {
  /**
   * An empty list is not "this shop cancelled".
   *
   * Shopify's `check` filters `activeSubscriptions` by plan name **and** by
   * test mode, so a renamed plan, a flipped `SHOPIFY_BILLING_TEST_MODE` and a
   * frozen subscription Shopify omits all produce one. This used to return
   * Free, and `syncSubscription` wrote it onto the row — so a merchant inside
   * their documented seven-day grace lost it the first time they opened the
   * page they were told to open to fix their card.
   */
  it("does not read an empty list as a cancellation", () => {
    const reading = readSubscriptions([], NOW);
    expect(reading.known).toBe(false);
    expect(reading).toMatchObject({ reason: "no-subscriptions" });
  });

  it("maps an active subscription to its plan and interval", () => {
    const snapshot = snapshotOf([subscription()], NOW);
    expect(snapshot).toMatchObject({
      plan: "growth",
      interval: "monthly",
      status: "ACTIVE",
      subscriptionId: "gid://shopify/AppSubscription/1",
    });
    expect(snapshot.currentPeriodEnd?.toISOString()).toBe("2026-07-01T12:00:00.000Z");
  });

  it("recognises a trial that is still running and works out when it ends", () => {
    const snapshot = snapshotOf(
      [subscription({ trialDays: 14, createdAt: "2026-06-10T12:00:00Z" })],
      NOW,
    );
    expect(snapshot.status).toBe("TRIAL");
    expect(snapshot.trialEndsAt?.toISOString()).toBe("2026-06-24T12:00:00.000Z");
  });

  it("treats an elapsed trial as an ordinary active subscription", () => {
    const snapshot = snapshotOf(
      [subscription({ trialDays: 14, createdAt: "2026-05-01T12:00:00Z" })],
      NOW,
    );
    expect(snapshot.status).toBe("ACTIVE");
  });

  it("turns a frozen subscription into a grace period rather than a cut-off", () => {
    const snapshot = snapshotOf([subscription({ status: "FROZEN" })], NOW);
    expect(snapshot.status).toBe("PAST_DUE");
    expect(snapshot.graceEndsAt?.toISOString()).toBe("2026-06-22T12:00:00.000Z");
  });

  it.each(["CANCELLED", "EXPIRED", "DECLINED"] as const)(
    "treats %s as cancelled",
    (status) => {
      expect(snapshotOf([subscription({ status })], NOW).status).toBe("CANCELLED");
    },
  );

  it("unlocks nothing for a subscription still awaiting approval", () => {
    expect(snapshotOf([subscription({ status: "PENDING" })], NOW).status).toBe("NONE");
  });

  it("prefers the active subscription when a plan change reports two", () => {
    const snapshot = snapshotOf(
      [
        subscription({ id: "old", name: "pro-monthly", status: "CANCELLED" }),
        subscription({ id: "new", name: "agentic-annual", status: "ACTIVE" }),
      ],
      NOW,
    );
    expect(snapshot).toMatchObject({ plan: "agentic", interval: "annual" });
  });

  it("takes the newest when none is active", () => {
    const snapshot = snapshotOf(
      [
        subscription({
          name: "pro-monthly",
          status: "CANCELLED",
          createdAt: "2026-01-01T00:00:00Z",
        }),
        subscription({
          name: "growth-monthly",
          status: "CANCELLED",
          createdAt: "2026-05-01T00:00:00Z",
        }),
      ],
      NOW,
    );
    expect(snapshot.plan).toBe("growth");
  });

  /**
   * Renaming a plan without a migration silently dropped every paying merchant
   * to Free. The comment beside that code said it must not — "keep them
   * working and make the mismatch loud" — and the code returned Free anyway.
   *
   * There is a live subscription here; we simply cannot read it. That is never
   * a cancellation, and `syncSubscription` leaves the cached plan alone.
   */
  it("refuses to guess at a subscription name it does not know, and says why", () => {
    const reading = readSubscriptions(
      [subscription({ name: "enterprise-monthly" })],
      NOW,
    );

    expect(reading.known).toBe(false);
    expect(reading).toMatchObject({ reason: "unrecognised-plan" });
    if (!reading.known) {
      expect(reading.detail).toContain("enterprise-monthly");
      // Names what to check, not just that something is wrong.
      expect(reading.detail).toContain("growth-monthly");
    }
  });

  it("passes the test flag through", () => {
    expect(snapshotOf([subscription({ test: true })], NOW).isTest).toBe(true);
  });
});
