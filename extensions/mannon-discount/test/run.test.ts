import {
  parseMoney,
  resolvePrice,
  serializeRuleset,
  type PricingRule,
} from "@mannon/pricing-engine";
import { describe, expect, it, vi } from "vitest";

import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run";
import type { CartLine, FunctionInput } from "../src/api";

/**
 * These run the Function's logic exactly as Shopify does — it is a plain
 * `(input) => output` function; the CLI only wraps it in WebAssembly. So the
 * behaviour at checkout is fully testable here, without a store.
 */

const rule = (overrides: Partial<PricingRule> = {}): PricingRule =>
  ({
    id: "wholesale-35",
    name: "Wholesale 35% off",
    status: "active",
    priority: 100,
    combinable: false,
    kind: "percentage",
    value: { percentage: 35 },
    targets: { mode: "all" },
    audience: { mode: "tags", tags: ["wholesale"] },
    markets: { mode: "all", marketIds: [] },
    schedule: { startsAt: null, endsAt: null },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }) as PricingRule;

const line = (overrides: Partial<CartLine> = {}): CartLine =>
  ({
    id: "gid://shopify/CartLine/1",
    quantity: 1,
    cost: { amountPerQuantity: { amount: "10.00", currencyCode: "USD" } },
    merchandise: {
      __typename: "ProductVariant",
      id: "gid://shopify/ProductVariant/1",
      product: { id: "gid://shopify/Product/1", collections: null },
    },
    ...overrides,
  }) as CartLine;

function input({
  rules = [rule()],
  lines = [line()],
  tags = ["wholesale"],
  loggedIn = true,
  discountClasses = ["PRODUCT"],
  subtotal = "10.00",
  currency = "USD",
  rulesetOverride,
  companyId,
  collections,
}: {
  rules?: PricingRule[];
  lines?: CartLine[];
  tags?: string[];
  loggedIn?: boolean;
  discountClasses?: string[];
  subtotal?: string;
  currency?: string;
  rulesetOverride?: unknown;
  companyId?: string;
  collections?: string[];
} = {}): FunctionInput {
  return {
    cart: {
      cost: { subtotalAmount: { amount: subtotal, currencyCode: currency } },
      buyerIdentity: loggedIn
        ? {
            customer: {
              id: "gid://shopify/Customer/1",
              buyer: { jsonValue: { tags, groupIds: [] } },
            },
            ...(companyId ? { purchasingCompany: { company: { id: companyId } } } : {}),
          }
        : null,
      lines: lines.map((entry) =>
        collections && entry.merchandise.__typename === "ProductVariant"
          ? {
              ...entry,
              merchandise: {
                ...entry.merchandise,
                product: {
                  ...entry.merchandise.product,
                  collections: { jsonValue: collections },
                },
              },
            }
          : entry,
      ),
    },
    discount: {
      discountClasses,
      ruleset: {
        jsonValue: rulesetOverride ?? serializeRuleset(rules),
      },
    },
    localization: { country: { isoCode: "US" } },
  };
}

const candidates = (result: ReturnType<typeof cartLinesDiscountsGenerateRun>) =>
  result.operations[0]?.productDiscountsAdd.candidates ?? [];

describe("applying wholesale prices at checkout", () => {
  it("discounts a tagged buyer's line to the engine's price", () => {
    const result = cartLinesDiscountsGenerateRun(input());

    expect(candidates(result)).toHaveLength(1);
    // $10.00 less 35% is $6.50, so $3.50 comes off each unit.
    expect(candidates(result)[0]!.value.fixedAmount).toEqual({
      amount: "3.50",
      appliesToEachItem: true,
    });
    expect(result.operations[0]!.productDiscountsAdd.selectionStrategy).toBe("ALL");
  });

  it("names the winning rule, so checkout shows the merchant's own wording", () => {
    const result = cartLinesDiscountsGenerateRun(input());
    expect(candidates(result)[0]!.message).toBe("Wholesale 35% off");
  });

  it("charges an untagged customer the shelf price", () => {
    expect(candidates(cartLinesDiscountsGenerateRun(input({ tags: [] })))).toEqual([]);
  });

  it("charges a guest the shelf price", () => {
    expect(candidates(cartLinesDiscountsGenerateRun(input({ loggedIn: false })))).toEqual(
      [],
    );
  });

  it("discounts per unit, so quantity multiplies correctly", () => {
    const result = cartLinesDiscountsGenerateRun(
      input({ lines: [line({ quantity: 12 })], subtotal: "120.00" }),
    );
    expect(candidates(result)[0]!.value.fixedAmount).toEqual({
      amount: "3.50",
      appliesToEachItem: true,
    });
  });

  it("prices each line independently", () => {
    const second = line({
      id: "gid://shopify/CartLine/2",
      cost: { amountPerQuantity: { amount: "120.00", currencyCode: "USD" } },
      merchandise: {
        __typename: "ProductVariant",
        id: "gid://shopify/ProductVariant/2",
        product: { id: "gid://shopify/Product/2", collections: null },
      },
    });

    const result = cartLinesDiscountsGenerateRun(
      input({ lines: [line(), second], subtotal: "130.00" }),
    );

    expect(candidates(result).map((c) => c.value.fixedAmount.amount)).toEqual([
      "3.50",
      "42.00",
    ]);
  });

  it("applies volume tiers at the line's quantity", () => {
    const tiers = rule({
      id: "tiers",
      name: "Volume breaks",
      kind: "volume_tier",
      value: {
        tiers: [
          { minQuantity: 5, maxQuantity: 19, kind: "percentage", percentage: 5 },
          { minQuantity: 20, maxQuantity: null, kind: "percentage", percentage: 12 },
        ],
      },
    });

    const atFive = cartLinesDiscountsGenerateRun(
      input({ rules: [tiers], lines: [line({ quantity: 5 })] }),
    );
    const atTwenty = cartLinesDiscountsGenerateRun(
      input({ rules: [tiers], lines: [line({ quantity: 20 })] }),
    );

    expect(candidates(atFive)[0]!.value.fixedAmount.amount).toBe("0.50");
    expect(candidates(atTwenty)[0]!.value.fixedAmount.amount).toBe("1.20");
  });

  it("uses the cart subtotal for cart-value rules", () => {
    const cartRule = rule({
      id: "cart",
      name: "8% over $1,000",
      kind: "cart_value_tier",
      value: {
        tiers: [
          {
            minSubtotal: parseMoney("1000.00", "USD"),
            maxSubtotal: null,
            kind: "percentage",
            percentage: 8,
          },
        ],
      },
    });

    const under = cartLinesDiscountsGenerateRun(
      input({ rules: [cartRule], subtotal: "300.00" }),
    );
    const over = cartLinesDiscountsGenerateRun(
      input({ rules: [cartRule], subtotal: "1500.00" }),
    );

    expect(candidates(under)).toEqual([]);
    expect(candidates(over)[0]!.value.fixedAmount.amount).toBe("0.80");
  });

  it("reads collection targeting from the product metafield", () => {
    const collectionRule = rule({
      id: "new-only",
      name: "New collection",
      targets: { mode: "collections", collectionIds: ["gid://shopify/Collection/new"] },
    });

    const inCollection = cartLinesDiscountsGenerateRun(
      input({ rules: [collectionRule], collections: ["gid://shopify/Collection/new"] }),
    );
    const outOfCollection = cartLinesDiscountsGenerateRun(
      input({ rules: [collectionRule], collections: ["gid://shopify/Collection/other"] }),
    );

    expect(candidates(inCollection)).toHaveLength(1);
    expect(candidates(outOfCollection)).toEqual([]);
  });

  it("matches a B2B company from the purchasing company", () => {
    const companyRule = rule({
      id: "company",
      name: "Company rate",
      audience: { mode: "companies", companyIds: ["gid://shopify/Company/7"] },
    });

    expect(
      candidates(
        cartLinesDiscountsGenerateRun(
          input({ rules: [companyRule], companyId: "gid://shopify/Company/7", tags: [] }),
        ),
      ),
    ).toHaveLength(1);
  });
});

/**
 * The property that makes the Buyer Agent trustworthy: what it quotes and what
 * checkout charges are the same number, because both ask the same module.
 */
describe("checkout agrees with the engine", () => {
  const cases: { name: string; rules: PricingRule[]; quantity: number }[] = [
    { name: "percentage", rules: [rule()], quantity: 3 },
    {
      name: "fixed contract price",
      rules: [
        rule({
          id: "fixed",
          kind: "fixed_price",
          value: { base: parseMoney("8.00", "USD"), overrides: {} },
        }),
      ],
      quantity: 2,
    },
    {
      name: "stacked discounts",
      rules: [
        rule({ id: "a", combinable: true, priority: 10, value: { percentage: 10 } }),
        rule({
          id: "b",
          combinable: true,
          priority: 20,
          kind: "amount_off",
          value: { base: parseMoney("1.00", "USD"), overrides: {} },
        }),
      ],
      quantity: 1,
    },
    {
      name: "a rule that rounds",
      rules: [rule({ id: "third", value: { percentage: 33.33 } })],
      quantity: 7,
    },
  ];

  it.each(cases)("$name", ({ rules, quantity }) => {
    const result = cartLinesDiscountsGenerateRun(
      input({ rules, lines: [line({ quantity })] }),
    );

    const expected = resolvePrice({
      rules,
      context: {
        customer: {
          id: "gid://shopify/Customer/1",
          tags: ["wholesale"],
          groupIds: [],
          companyId: null,
        },
        product: {
          productId: "gid://shopify/Product/1",
          variantId: "gid://shopify/ProductVariant/1",
          collectionIds: [],
          price: parseMoney("10.00", "USD"),
          cost: null,
        },
        quantity,
        market: { marketId: "", countryCode: "", currencyCode: "USD" },
        cartSubtotal: parseMoney("10.00", "USD"),
        now: new Date(),
      },
    });

    const discountPerUnit = Number(candidates(result)[0]?.value.fixedAmount.amount ?? 0);
    const chargedPerUnit = 10 - discountPerUnit;

    expect(chargedPerUnit.toFixed(2)).toBe((expected.unitPrice.amount / 100).toFixed(2));
  });
});

describe("failing safely", () => {
  it("does nothing when the discount is not a product discount", () => {
    expect(
      cartLinesDiscountsGenerateRun(input({ discountClasses: ["SHIPPING"] })),
    ).toEqual({ operations: [] });
  });

  it("does nothing when no ruleset has been published", () => {
    const bare = input();
    bare.discount.ruleset = null;
    expect(cartLinesDiscountsGenerateRun(bare)).toEqual({ operations: [] });
  });

  /**
   * A Function that throws applies no discounts at all, so every wholesale
   * buyer in the store quietly pays retail. One bad rule must cost that rule.
   */
  it("keeps the good rules when one is malformed", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const wire = serializeRuleset([rule()]) as unknown as { rules: unknown[] };
    wire.rules.push({ id: "broken", kind: "nonsense" });

    const result = cartLinesDiscountsGenerateRun(input({ rulesetOverride: wire }));

    expect(candidates(result)).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("broken"));
    error.mockRestore();
  });

  it("charges the shelf price rather than throwing on a corrupt ruleset", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      cartLinesDiscountsGenerateRun(input({ rulesetOverride: "{not json" })),
    ).toEqual({ operations: [] });
    error.mockRestore();
  });

  it("ignores a line that is not a product variant", () => {
    const custom = {
      ...line(),
      merchandise: { __typename: "CustomProduct" },
    } as CartLine;
    expect(candidates(cartLinesDiscountsGenerateRun(input({ lines: [custom] })))).toEqual(
      [],
    );
  });

  it("never emits a negative or zero discount", () => {
    // A fixed price above the shelf price would raise the charge, which a
    // discount cannot express and a buyer would not accept.
    const expensive = rule({
      id: "higher",
      kind: "fixed_price",
      value: { base: parseMoney("15.00", "USD"), overrides: {} },
    });
    expect(
      candidates(cartLinesDiscountsGenerateRun(input({ rules: [expensive] }))),
    ).toEqual([]);
  });

  /**
   * Market scoping needs a country-to-market map the Function does not have.
   * Dropping those rules is deliberate: an `exclude` rule with no market id
   * would otherwise match everywhere and give away a discount the merchant
   * scoped away.
   */
  it("stands aside on market-scoped rules rather than guessing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scoped = rule({ id: "gcc", markets: { mode: "exclude", marketIds: ["m-eu"] } });

    expect(candidates(cartLinesDiscountsGenerateRun(input({ rules: [scoped] })))).toEqual(
      [],
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("market scoping"));
    warn.mockRestore();
  });

  it("skips a cart-value rule priced in another currency", () => {
    const cartRule = rule({
      id: "cart-eur",
      kind: "cart_value_tier",
      value: {
        tiers: [
          {
            minSubtotal: parseMoney("100.00", "EUR"),
            maxSubtotal: null,
            kind: "percentage",
            percentage: 8,
          },
        ],
      },
    });
    expect(
      candidates(cartLinesDiscountsGenerateRun(input({ rules: [cartRule] }))),
    ).toEqual([]);
  });
});

/**
 * Money on the wire, and the cart it used to take down with it.
 *
 * `parseMoney` throws on excess precision, by design, and the Function fed it
 * Shopify's own `MoneyV2.amount` strings without normalising them. Two ways
 * that ended badly, both of them silent.
 */
describe("reading Shopify's money strings", () => {
  it("prices a zero-decimal currency, which used to price nothing at all", () => {
    // Shopify serialises MoneyV2 with a decimal point whatever the currency, so
    // a ¥1,000 line arrives as "1000.0". JPY allows no decimals, so that threw,
    // the catch returned no operations, and every wholesale buyer in a yen
    // store paid retail — for ever, with a console.error nobody reads.
    const result = cartLinesDiscountsGenerateRun(
      input({
        currency: "JPY",
        subtotal: "10000.0",
        lines: [
          line({
            cost: { amountPerQuantity: { amount: "1000.0", currencyCode: "JPY" } },
          }),
        ],
      }),
    );

    // ¥1,000 less 35% is ¥650, so ¥350 comes off — in whole yen, no decimals.
    expect(candidates(result)).toHaveLength(1);
    expect(candidates(result)[0]!.value.fixedAmount).toEqual({
      amount: "350",
      appliesToEachItem: true,
    });
  });

  it("costs one line, not the cart, when a line's amount cannot be read", () => {
    // The file's own header promises exactly this. `discountFor` was called
    // inside the loop but guarded only by the try around the whole run, so one
    // odd amount removed the discount from every other line in the cart.
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = cartLinesDiscountsGenerateRun(
      input({
        subtotal: "20.00",
        lines: [
          line({
            id: "gid://shopify/CartLine/bad",
            // Sub-cent: a genuine rounding decision, which the parser refuses.
            cost: { amountPerQuantity: { amount: "10.005", currencyCode: "USD" } },
          }),
          line({ id: "gid://shopify/CartLine/good" }),
        ],
      }),
    );

    expect(candidates(result)).toHaveLength(1);
    expect(candidates(result)[0]!.targets).toEqual([
      { cartLine: { id: "gid://shopify/CartLine/good" } },
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps every other rule when the cart subtotal cannot be read", () => {
    // A subtotal we cannot represent skips cart-value tiers and nothing else.
    // It used to throw out of `generate` and cost the whole cart.
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = cartLinesDiscountsGenerateRun(
      input({ subtotal: "20.0005", currency: "USD" }),
    );

    expect(candidates(result)).toHaveLength(1);
    expect(candidates(result)[0]!.value.fixedAmount.amount).toBe("3.50");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
