import { publishedFrom, serializeSettings } from "@mannon/net-terms";
import { money, zero } from "@mannon/pricing-engine";
import { describe, expect, it } from "vitest";

import type { RunInput } from "../src/api";
import { run } from "../src/run";

/**
 * What a buyer is offered at checkout.
 *
 * The Function decides nothing itself, so these do not re-test the eligibility
 * rules — `packages/net-terms` owns those. What they test is the wiring: that
 * the right metafields are read, the right method is matched, and that nothing
 * on any path throws.
 */

const METHOD = {
  id: "gid://shopify/PaymentCustomizationPaymentMethod/1",
  name: "Net terms",
};
const CARD = {
  id: "gid://shopify/PaymentCustomizationPaymentMethod/2",
  name: "Credit card",
};

const usd = (amount: number) => money(amount, "USD");

const buyerFacts = (terms: unknown) => ({ tags: ["wholesale"], groupIds: [], terms });

const input = (
  overrides: {
    terms?: unknown;
    isAuthenticated?: boolean;
    settings?: unknown;
    methods?: { id: string; name: string }[];
    total?: string;
  } = {},
): RunInput => ({
  cart: {
    cost: { totalAmount: { amount: overrides.total ?? "500.00", currencyCode: "USD" } },
    buyerIdentity: {
      isAuthenticated: overrides.isAuthenticated ?? true,
      customer: { metafield: { jsonValue: buyerFacts(overrides.terms ?? null) } },
    },
  },
  paymentMethods: overrides.methods ?? [CARD, METHOD],
  shop: { metafield: { jsonValue: overrides.settings ?? serializeSettings() } },
});

const eligible = publishedFrom(
  { days: 30, creditLimit: null, source: "group" },
  zero("USD"),
  0,
);

describe("who sees pay later", () => {
  it("renames it for an eligible buyer so it says their terms", () => {
    const result = run(input({ terms: eligible }));
    expect(result.operations).toEqual([
      { rename: { paymentMethodId: METHOD.id, name: "Pay later (Net 30)" } },
    ]);
  });

  it("hides it from a buyer with no terms", () => {
    expect(run(input({ terms: null })).operations).toEqual([
      { hide: { paymentMethodId: METHOD.id } },
    ]);
  });

  it("hides it from a guest", () => {
    // A retail customer should never learn that trade credit exists.
    expect(run(input({ terms: eligible, isAuthenticated: false })).operations).toEqual([
      { hide: { paymentMethodId: METHOD.id } },
    ]);
  });

  it("hides it from a buyer whose cart would take them over their limit", () => {
    const terms = publishedFrom(
      { days: 30, creditLimit: usd(100000), source: "group" },
      usd(80000),
      0,
    );
    expect(run(input({ terms, total: "300.00" })).operations).toEqual([
      { hide: { paymentMethodId: METHOD.id } },
    ]);
  });

  it("leaves it for a cart that exactly reaches the limit", () => {
    const terms = publishedFrom(
      { days: 30, creditLimit: usd(100000), source: "group" },
      usd(80000),
      0,
    );
    expect(run(input({ terms, total: "200.00" })).operations).toEqual([
      { rename: { paymentMethodId: METHOD.id, name: "Pay later (Net 30)" } },
    ]);
  });

  it("hides it from a buyer with an overdue invoice", () => {
    const terms = publishedFrom(
      { days: 30, creditLimit: null, source: "group" },
      usd(50000),
      1,
    );
    expect(run(input({ terms })).operations).toEqual([
      { hide: { paymentMethodId: METHOD.id } },
    ]);
  });

  it("never touches any method but the merchant's own", () => {
    const result = run(input({ terms: null }));
    expect(JSON.stringify(result)).not.toContain(CARD.id);
  });
});

describe("the merchant's settings", () => {
  it("matches the method by the name they configured", () => {
    const invoice = { id: "gid://method/9", name: "Invoice me" };
    const result = run(
      input({
        terms: null,
        settings: serializeSettings({ methodName: "Invoice me" }),
        methods: [CARD, invoice],
      }),
    );
    expect(result.operations).toEqual([{ hide: { paymentMethodId: invoice.id } }]);
  });

  it("matches loosely on case and spacing, as merchants type it", () => {
    const result = run(
      input({ terms: null, methods: [{ id: "m", name: "  NET TERMS " }] }),
    );
    expect(result.operations).toEqual([{ hide: { paymentMethodId: "m" } }]);
  });

  it("leaves the name alone when the merchant turned renaming off", () => {
    const result = run(
      input({ terms: eligible, settings: serializeSettings({ showDaysInName: false }) }),
    );
    expect(result.operations).toEqual([]);
  });

  it("does nothing when the method does not exist in this checkout", () => {
    expect(run(input({ terms: null, methods: [CARD] })).operations).toEqual([]);
  });

  it("falls back to the default name when the settings are unreadable", () => {
    expect(run(input({ terms: null, settings: "not json" })).operations).toEqual([
      { hide: { paymentMethodId: METHOD.id } },
    ]);
  });
});

describe("never throws, and fails closed", () => {
  it("survives an input with nothing in it", () => {
    expect(() => run({} as RunInput)).not.toThrow();
    expect(run({} as RunInput).operations).toEqual([]);
  });

  it("hides the method when the buyer facts are garbage", () => {
    // Failing towards *not* extending credit: the cost is a buyer who has to
    // pay now, not a merchant shipping goods for free.
    for (const terms of ["not json", 42, [], { days: "soon" }]) {
      expect(run(input({ terms })).operations).toEqual([
        { hide: { paymentMethodId: METHOD.id } },
      ]);
    }
  });

  it("hides the method when the payment list itself throws", () => {
    const hostile = input({ terms: eligible });
    Object.defineProperty(hostile.cart, "cost", {
      get() {
        throw new Error("boom");
      },
    });

    expect(() => run(hostile)).not.toThrow();
    expect(run(hostile).operations).toEqual([{ hide: { paymentMethodId: METHOD.id } }]);
  });

  it("treats an unreadable cart total as zero rather than losing the method", () => {
    const terms = publishedFrom(
      { days: 30, creditLimit: usd(100000), source: "group" },
      usd(80000),
      0,
    );
    expect(run(input({ terms, total: "not a number" })).operations).toEqual([
      { rename: { paymentMethodId: METHOD.id, name: "Pay later (Net 30)" } },
    ]);
  });

  it("does nothing when the merchant left the method name empty", () => {
    const result = run(input({ terms: null, settings: { v: 1, methodName: "" } }));
    // The empty name falls back to the default, which is still a real name —
    // an empty one would match every method and hide the whole payment step.
    expect(result.operations).toEqual([{ hide: { paymentMethodId: METHOD.id } }]);
  });
});
