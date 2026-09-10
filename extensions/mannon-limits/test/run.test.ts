import { DEFAULT_MESSAGES, serializeLimits, type OrderLimit } from "@mannon/order-limits";
import { parseMoney } from "@mannon/pricing-engine";
import { describe, expect, it } from "vitest";

import type { RunInput } from "../src/api";
import { run } from "../src/run";

/**
 * The Function is a plain `(input) => output`; the CLI only wraps it in
 * WebAssembly. So these exercise the real checkout behaviour without a store.
 */

const usd = (value: string) => parseMoney(value, "USD");

const limit = (overrides: Partial<OrderLimit> = {}): OrderLimit => ({
  id: "l1",
  enabled: true,
  groupId: null,
  minSubtotal: null,
  maxSubtotal: null,
  minQuantity: null,
  maxQuantity: null,
  quantityIncrement: null,
  countries: [],
  ...overrides,
});

function input(options: {
  limits?: OrderLimit[];
  messages?: Partial<typeof DEFAULT_MESSAGES>;
  subtotal?: string;
  quantity?: number;
  authenticated?: boolean;
  groupIds?: string[];
  country?: string;
  /** Overrides the whole published metafield, for the malformed cases. */
  published?: unknown;
}): RunInput {
  const limits = options.limits ?? [];
  const published =
    options.published !== undefined
      ? options.published
      : serializeLimits(limits, { ...DEFAULT_MESSAGES, ...options.messages }, true);

  return {
    cart: {
      cost: {
        subtotalAmount: { amount: options.subtotal ?? "250.00", currencyCode: "USD" },
      },
      lines: [{ quantity: options.quantity ?? 10 }],
      buyerIdentity: {
        isAuthenticated: options.authenticated ?? true,
        customer: {
          metafield: {
            jsonValue: { tags: ["wholesale"], groupIds: options.groupIds ?? [] },
          },
        },
      },
    },
    localization: { country: { isoCode: options.country ?? "SA" } },
    shop: { metafield: { jsonValue: published } },
  };
}

describe("blocking a cart", () => {
  it("says nothing when the cart qualifies", () => {
    expect(run(input({ limits: [limit({ minSubtotal: usd("200.00") })] }))).toEqual({
      errors: [],
    });
  });

  it("shows the merchant's message with the gap filled in", () => {
    const result = run(
      input({ limits: [limit({ minSubtotal: usd("200.00") })], subtotal: "162.00" }),
    );

    expect(result.errors).toHaveLength(1);
    // The checklist's example, rendered by the merchant's own template.
    expect(result.errors[0]!.localizedMessage).toBe(
      "Add USD 38.00 to reach your USD 200.00 minimum order.",
    );
    expect(result.errors[0]!.target).toBe("$.cart");
  });

  it("uses the merchant's own wording when they have written some", () => {
    const result = run(
      input({
        limits: [limit({ minSubtotal: usd("200.00") })],
        subtotal: "162.00",
        messages: { below_minimum_subtotal: "You need {{gap}} more, habibi." },
      }),
    );
    expect(result.errors[0]!.localizedMessage).toBe("You need USD 38.00 more, habibi.");
  });

  it("counts every line towards the quantity", () => {
    const result = run({
      ...input({ limits: [limit({ minQuantity: 24 })] }),
      cart: {
        ...input({ limits: [limit({ minQuantity: 24 })] }).cart,
        lines: [{ quantity: 6 }, { quantity: 6 }, { quantity: 6 }],
      },
    });
    expect(result.errors[0]!.localizedMessage).toBe(
      "Add 6 more items to reach the 24 minimum.",
    );
  });

  it("reports a case pack in the merchant's words", () => {
    const result = run(
      input({ limits: [limit({ quantityIncrement: 6 })], quantity: 20 }),
    );
    expect(result.errors[0]!.localizedMessage).toBe(
      "These are sold in cases of 6. Add 4 to complete a case.",
    );
  });

  it("reports every unmet bound, not just the first", () => {
    const result = run(
      input({
        limits: [limit({ minSubtotal: usd("200.00"), minQuantity: 24 })],
        subtotal: "100.00",
        quantity: 4,
      }),
    );
    expect(result.errors).toHaveLength(2);
  });
});

describe("who is never blocked", () => {
  it("a guest", () => {
    expect(
      run(
        input({
          limits: [limit({ minSubtotal: usd("200.00") })],
          subtotal: "1.00",
          authenticated: false,
        }),
      ).errors,
    ).toEqual([]);
  });

  it("somebody with an empty cart", () => {
    // "Add $200 to reach your $200 minimum" in front of an empty basket is
    // noise at somebody who has not started.
    expect(
      run(
        input({
          limits: [limit({ minSubtotal: usd("200.00") })],
          subtotal: "0.00",
          quantity: 0,
        }),
      ).errors,
    ).toEqual([]);
  });

  it("a buyer outside the country a limit is scoped to", () => {
    expect(
      run(
        input({
          limits: [limit({ minSubtotal: usd("200.00"), countries: ["SA"] })],
          subtotal: "1.00",
          country: "AE",
        }),
      ).errors,
    ).toEqual([]);
  });

  it("a buyer whose own tier has a lower minimum", () => {
    const result = run(
      input({
        limits: [
          limit({ id: "store", minSubtotal: usd("500.00") }),
          limit({ id: "gold", groupId: "g1", minSubtotal: usd("100.00") }),
        ],
        subtotal: "150.00",
        groupIds: ["g1"],
      }),
    );
    expect(result.errors).toEqual([]);
  });
});

describe("it never blocks a whole store", () => {
  it("passes everything when nothing has been published", () => {
    // A validation Function that fails blocks every checkout, wholesale and
    // retail alike.
    expect(run({ ...input({}), shop: {} }).errors).toEqual([]);
    expect(run({ ...input({}), shop: { metafield: null } }).errors).toEqual([]);
  });

  it("passes everything on a metafield it cannot read", () => {
    expect(run(input({ published: "not json at all" })).errors).toEqual([]);
    expect(run(input({ published: { v: 99, limits: [] } })).errors).toEqual([]);
    expect(run(input({ published: 42 })).errors).toEqual([]);
  });

  it("passes everything on a cart it cannot read", () => {
    const broken = {
      cart: {
        cost: { subtotalAmount: { amount: "oops", currencyCode: "USD" } },
        lines: [],
      },
      localization: { country: { isoCode: "SA" } },
      shop: { metafield: { jsonValue: serializeLimits([], DEFAULT_MESSAGES, true) } },
    } as unknown as RunInput;

    expect(run(broken).errors).toEqual([]);
  });

  it("passes everything when the input is missing entirely", () => {
    expect(run({} as unknown as RunInput).errors).toEqual([]);
    expect(run(null as unknown as RunInput).errors).toEqual([]);
  });

  it("treats a buyer with no published facts as having no tier", () => {
    const noFacts = {
      ...input({ limits: [limit({ groupId: "g1", minSubtotal: usd("500.00") })] }),
    };
    noFacts.cart.buyerIdentity!.customer = null;
    // No tier means the group limit does not apply, and there is no store-wide
    // one, so nothing blocks.
    expect(run(noFacts).errors).toEqual([]);
  });
});
