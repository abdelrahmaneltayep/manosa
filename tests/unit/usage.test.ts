import { describe, expect, it } from "vitest";

import { meterFor, USAGE_WARNING_THRESHOLD } from "~/lib/billing/usage.server";

describe("usage meters", () => {
  it("reports nothing to warn about on an unlimited plan", () => {
    const meter = meterFor("pricingRules", 250, null);
    expect(meter.ratio).toBeNull();
    expect(meter.nearingLimit).toBe(false);
    expect(meter.atLimit).toBe(false);
  });

  it("stays quiet below the warning threshold", () => {
    const meter = meterFor("pricingRules", 7, 10);
    expect(meter.nearingLimit).toBe(false);
    expect(meter.atLimit).toBe(false);
  });

  it("warns from 80% up", () => {
    expect(USAGE_WARNING_THRESHOLD).toBe(0.8);
    const meter = meterFor("pricingRules", 8, 10);
    expect(meter.nearingLimit).toBe(true);
    expect(meter.atLimit).toBe(false);
  });

  it("switches from nearing to reached at the limit, not before", () => {
    expect(meterFor("forms", 9, 10).nearingLimit).toBe(true);
    const at = meterFor("forms", 10, 10);
    expect(at.nearingLimit).toBe(false);
    expect(at.atLimit).toBe(true);
  });

  it("treats being over the limit as reached, not as a new state", () => {
    // Possible after a downgrade: what exists is kept, and stops applying.
    const meter = meterFor("pricingRules", 14, 1);
    expect(meter.atLimit).toBe(true);
    expect(meter.nearingLimit).toBe(false);
  });

  it("handles a limit of one, which is the Free plan", () => {
    expect(meterFor("forms", 0, 1)).toMatchObject({
      nearingLimit: false,
      atLimit: false,
    });
    expect(meterFor("forms", 1, 1)).toMatchObject({ nearingLimit: false, atLimit: true });
  });

  it("does not divide by zero on a limit of zero", () => {
    const meter = meterFor("forms", 0, 0);
    expect(meter.ratio).toBeNull();
    expect(Number.isNaN(meter.ratio ?? 0)).toBe(false);
  });
});
