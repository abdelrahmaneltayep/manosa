import { describe, expect, it } from "vitest";

import {
  assertEnvironment,
  BillingTestModeInProduction,
} from "~/lib/config/environment.server";
import { testModeFor, testModeForced } from "~/lib/billing/test-mode.server";

/**
 * Which charge a shop gets, and which deployments may decide it.
 *
 * `SHOPIFY_BILLING_TEST_MODE` was read straight from `process.env` at three
 * call sites and checked nowhere. It is one variable for a whole process, and
 * the README told operators to set it per store — so on a multi-tenant
 * deployment it was wrong for somebody whichever way it was set: true billed
 * every merchant nothing, false refused every development store a subscription
 * with a message that named no cause.
 */

describe("which charge a shop gets", () => {
  it("is a test charge on a development store, with nothing to configure", () => {
    expect(testModeFor({ isDevelopmentStore: true }, "false")).toBe(true);
  });

  it("is a live charge on a real store", () => {
    expect(testModeFor({ isDevelopmentStore: false }, "false")).toBe(false);
  });

  it("is a live charge for a shop we have no record of yet", () => {
    // Free is what a shop with no record gets, and a live charge is the answer
    // that cannot quietly give a paid plan away.
    expect(testModeFor(null, "false")).toBe(false);
  });

  it("lets a developer force test mode for a store that is not a dev store", () => {
    expect(testModeFor({ isDevelopmentStore: false }, "true")).toBe(true);
    expect(testModeForced("true")).toBe(true);
  });

  it("treats anything but the exact string as off", () => {
    for (const value of ["", "1", "yes", "TRUE", undefined]) {
      expect(testModeFor({ isDevelopmentStore: false }, value)).toBe(false);
    }
  });
});

describe("the production guard", () => {
  it("refuses to start a production process in test mode", () => {
    expect(() => assertEnvironment("production", "true")).toThrow(
      BillingTestModeInProduction,
    );
  });

  it("says why, in words an operator can act on", () => {
    try {
      assertEnvironment("production", "true");
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("SHOPIFY_BILLING_TEST_MODE");
      expect(message).toContain("subscribes to a paid plan for nothing");
      // And it names the thing that makes the variable unnecessary.
      expect(message).toContain("partnerDevelopment");
    }
  });

  it("leaves development alone", () => {
    expect(() => assertEnvironment("development", "true")).not.toThrow();
  });

  it("does not object to a production process billing for real", () => {
    expect(() => assertEnvironment("production", "false")).not.toThrow(
      BillingTestModeInProduction,
    );
  });
});
