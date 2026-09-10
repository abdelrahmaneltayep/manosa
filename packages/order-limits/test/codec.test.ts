import { parseMoney } from "@mannon/pricing-engine";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MESSAGES,
  deserializeLimits,
  renderMessage,
  serializeLimits,
} from "../src/codec";
import type { OrderLimit } from "../src/types";

const usd = (value: string) => parseMoney(value, "USD");

const limit = (overrides: Partial<OrderLimit> = {}): OrderLimit => ({
  id: "l1",
  enabled: true,
  groupId: "g1",
  minSubtotal: usd("200.00"),
  maxSubtotal: null,
  minQuantity: 24,
  maxQuantity: null,
  quantityIncrement: 6,
  countries: ["SA"],
  ...overrides,
});

describe("the published limits", () => {
  it("round-trips", () => {
    const wire = serializeLimits([limit()], DEFAULT_MESSAGES, true);
    const read = deserializeLimits(wire);

    expect(read.errors).toEqual([]);
    expect(read.limits).toEqual([limit()]);
    expect(read.posBypasses).toBe(true);
  });

  it("survives a JSON string, which is what a metafield may hand back", () => {
    const wire = JSON.stringify(serializeLimits([limit()], DEFAULT_MESSAGES, false));
    const read = deserializeLimits(wire);

    expect(read.limits).toHaveLength(1);
    expect(read.posBypasses).toBe(false);
  });

  it("never throws on nonsense", () => {
    // A validation Function that crashes blocks every checkout in the store.
    expect(deserializeLimits(null).limits).toEqual([]);
    expect(deserializeLimits("not json").errors).toHaveLength(1);
    expect(deserializeLimits(42).limits).toEqual([]);
    expect(deserializeLimits({ v: 1, limits: "no" }).limits).toEqual([]);
  });

  it("refuses a format it does not know, which lets orders through", () => {
    const read = deserializeLimits({ v: 99, limits: [limit()] });
    // Dropping the limits is the safe direction for a blocker.
    expect(read.limits).toEqual([]);
    expect(read.errors[0]).toContain("v99");
  });

  it("drops a limit it cannot read and names it", () => {
    const read = deserializeLimits({
      v: 1,
      limits: [{ id: "good", enabled: true }, "nonsense", { enabled: true }],
    });
    expect(read.limits.map((entry) => entry.id)).toEqual(["good"]);
    expect(read.errors).toHaveLength(2);
  });

  it("falls back to the default wording for a blank template", () => {
    // A blank template leaves the buyer blocked with nothing to read.
    const read = deserializeLimits({
      v: 1,
      limits: [],
      messages: {
        below_minimum_subtotal: "   ",
        not_a_multiple: "Cases of {{required}}.",
      },
    });
    expect(read.messages.below_minimum_subtotal).toBe(
      DEFAULT_MESSAGES.below_minimum_subtotal,
    );
    expect(read.messages.not_a_multiple).toBe("Cases of {{required}}.");
  });
});

describe("rendering a message", () => {
  it("fills in the numbers the checklist asks for", () => {
    expect(
      renderMessage(DEFAULT_MESSAGES.below_minimum_subtotal, {
        gap: "$38.00",
        required: "$200.00",
        actual: "$162.00",
      }),
    ).toBe("Add $38.00 to reach your $200.00 minimum order.");
  });

  it("tolerates spacing in the placeholders", () => {
    expect(
      renderMessage("Add {{ gap }} more.", { gap: "4", required: "", actual: "" }),
    ).toBe("Add 4 more.");
  });

  it("leaves an unknown placeholder alone rather than blanking it", () => {
    expect(
      renderMessage("Ask {{merchant}} about {{gap}}", {
        gap: "4",
        required: "",
        actual: "",
      }),
    ).toBe("Ask {{merchant}} about 4");
  });
});
