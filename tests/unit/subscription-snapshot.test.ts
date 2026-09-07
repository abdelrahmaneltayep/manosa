import type { AppSubscription } from "@shopify/shopify-api";
import { describe, expect, it, vi } from "vitest";

import { snapshotFrom } from "~/lib/billing/subscription.server";

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

describe("reading Shopify's subscription state", () => {
  it("falls back to Free when there is no subscription", () => {
    expect(snapshotFrom([], NOW)).toMatchObject({ plan: "free", status: "NONE" });
  });

  it("maps an active subscription to its plan and interval", () => {
    const snapshot = snapshotFrom([subscription()], NOW);
    expect(snapshot).toMatchObject({
      plan: "growth",
      interval: "monthly",
      status: "ACTIVE",
      subscriptionId: "gid://shopify/AppSubscription/1",
    });
    expect(snapshot.currentPeriodEnd?.toISOString()).toBe("2026-07-01T12:00:00.000Z");
  });

  it("recognises a trial that is still running and works out when it ends", () => {
    const snapshot = snapshotFrom(
      [subscription({ trialDays: 14, createdAt: "2026-06-10T12:00:00Z" })],
      NOW,
    );
    expect(snapshot.status).toBe("TRIAL");
    expect(snapshot.trialEndsAt?.toISOString()).toBe("2026-06-24T12:00:00.000Z");
  });

  it("treats an elapsed trial as an ordinary active subscription", () => {
    const snapshot = snapshotFrom(
      [subscription({ trialDays: 14, createdAt: "2026-05-01T12:00:00Z" })],
      NOW,
    );
    expect(snapshot.status).toBe("ACTIVE");
  });

  it("turns a frozen subscription into a grace period rather than a cut-off", () => {
    const snapshot = snapshotFrom([subscription({ status: "FROZEN" })], NOW);
    expect(snapshot.status).toBe("PAST_DUE");
    expect(snapshot.graceEndsAt?.toISOString()).toBe("2026-06-22T12:00:00.000Z");
  });

  it.each(["CANCELLED", "EXPIRED", "DECLINED"] as const)(
    "treats %s as cancelled",
    (status) => {
      expect(snapshotFrom([subscription({ status })], NOW).status).toBe("CANCELLED");
    },
  );

  it("unlocks nothing for a subscription still awaiting approval", () => {
    expect(snapshotFrom([subscription({ status: "PENDING" })], NOW).status).toBe("NONE");
  });

  it("prefers the active subscription when a plan change reports two", () => {
    const snapshot = snapshotFrom(
      [
        subscription({ id: "old", name: "pro-monthly", status: "CANCELLED" }),
        subscription({ id: "new", name: "agentic-annual", status: "ACTIVE" }),
      ],
      NOW,
    );
    expect(snapshot).toMatchObject({ plan: "agentic", interval: "annual" });
  });

  it("takes the newest when none is active", () => {
    const snapshot = snapshotFrom(
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
   * Renaming a plan without a migration would otherwise silently drop every
   * paying merchant to Free. It still falls back safely, but loudly.
   */
  it("refuses to guess at a subscription name it does not know, and says so", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const snapshot = snapshotFrom([subscription({ name: "enterprise-monthly" })], NOW);

    expect(snapshot.plan).toBe("free");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("unrecognised subscription"),
    );
    error.mockRestore();
  });

  it("passes the test flag through", () => {
    expect(snapshotFrom([subscription({ test: true })], NOW).isTest).toBe(true);
  });
});
