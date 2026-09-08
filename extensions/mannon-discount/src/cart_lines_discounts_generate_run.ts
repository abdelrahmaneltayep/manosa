import {
  deserializeRuleset,
  formatMoney,
  money,
  parseMoney,
  resolvePrice,
  type CustomerContext,
  type PricingContext,
  type PricingRule,
} from "@mannon/pricing-engine";

import {
  DISCOUNT_CLASS_PRODUCT,
  type CartLine,
  type CartLinesDiscountsGenerateRunResult,
  type FunctionInput,
} from "./api";

const NOTHING: CartLinesDiscountsGenerateRunResult = { operations: [] };

/**
 * Apply each approved buyer's wholesale price at checkout.
 *
 * This function computes no prices of its own. It reads the ruleset the app
 * published and hands it to `@mannon/pricing-engine` — the same module the
 * admin preview and the Buyer Agent call — so what the buyer was quoted and
 * what the buyer is charged come from one place and cannot disagree.
 *
 * It also never throws. A discount Function that fails applies no discounts at
 * all, which would silently charge every wholesale buyer in the store retail
 * until a human noticed. Anything unexpected costs one line, not the cart.
 */
export function cartLinesDiscountsGenerateRun(
  input: FunctionInput,
): CartLinesDiscountsGenerateRunResult {
  try {
    return generate(input);
  } catch (error) {
    // Nothing here can surface an error to the merchant, so the honest
    // fallback is to apply no discount and let checkout charge the shelf
    // price. Wrong-but-visible beats wrong-but-silent.
    console.error("[mannon] discount function failed", error);
    return NOTHING;
  }
}

function generate(input: FunctionInput): CartLinesDiscountsGenerateRunResult {
  if (!input.discount.discountClasses.includes(DISCOUNT_CLASS_PRODUCT)) return NOTHING;

  const { rules, errors } = deserializeRuleset(input.discount.ruleset?.jsonValue);
  for (const error of errors) {
    console.error(`[mannon] skipping rule ${error.ruleId ?? "?"}: ${error.message}`);
  }

  const usable = rules.filter(isSupportedAtCheckout);
  if (usable.length === 0) return NOTHING;

  const now = new Date();
  const customer = readCustomer(input);
  const subtotal = readSubtotal(input);
  const candidates: CartLinesDiscountsGenerateRunResult["operations"][0]["productDiscountsAdd"]["candidates"] =
    [];

  for (const line of input.cart.lines) {
    const candidate = discountFor(line, { customer, subtotal, now, rules: usable });
    if (candidate) candidates.push(candidate);
  }

  if (candidates.length === 0) return NOTHING;

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          // Each candidate targets a different line, so every one should apply.
          selectionStrategy: "ALL",
        },
      },
    ],
  };
}

/**
 * Market-scoped rules cannot be evaluated here yet.
 *
 * The Function knows the buyer's country but not which Shopify Market that
 * maps to — `Localization.market` is deprecated and the mapping is per-shop.
 * Dropping these rules is deliberate: an `exclude` rule with no market id would
 * otherwise match everywhere and hand out a discount the merchant scoped away.
 * Publishing the country-to-market map is tracked as a dependency of 1.3.
 */
function isSupportedAtCheckout(rule: PricingRule): boolean {
  if (rule.markets.mode !== "all") {
    console.warn(
      `[mannon] rule ${rule.id} is scoped to a market; market scoping is not applied at checkout yet`,
    );
    return false;
  }
  return true;
}

function readCustomer(input: FunctionInput): CustomerContext | null {
  const identity = input.cart.buyerIdentity;
  const shopifyCustomer = identity?.customer;
  if (!shopifyCustomer) return null;

  // Tags and groups come from a metafield the app maintains: the input query is
  // fixed at deploy time, so `hasAnyTag` cannot be given a merchant's list.
  const facts = (shopifyCustomer.buyer?.jsonValue ?? {}) as {
    tags?: unknown;
    groupIds?: unknown;
  };

  return {
    id: shopifyCustomer.id,
    tags: stringArray(facts.tags),
    groupIds: stringArray(facts.groupIds),
    companyId: identity?.purchasingCompany?.company.id ?? null,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readSubtotal(input: FunctionInput) {
  const { amount, currencyCode } = input.cart.cost.subtotalAmount;
  return parseMoney(amount, currencyCode);
}

function discountFor(
  line: CartLine,
  shared: {
    customer: CustomerContext | null;
    subtotal: ReturnType<typeof readSubtotal>;
    now: Date;
    rules: PricingRule[];
  },
) {
  if (line.merchandise.__typename !== "ProductVariant") return null;
  if (line.quantity < 1) return null;

  const unit = line.cost.amountPerQuantity;
  const currencyCode = unit.currencyCode;
  const basePrice = parseMoney(unit.amount, currencyCode);

  const context: PricingContext = {
    customer: shared.customer,
    product: {
      productId: line.merchandise.product.id,
      variantId: line.merchandise.id,
      collectionIds: stringArray(line.merchandise.product.collections?.jsonValue),
      price: basePrice,
      cost: null,
    },
    quantity: line.quantity,
    market: {
      // Market scoping is filtered out above, so this is unused by eligibility.
      marketId: "",
      countryCode: "",
      currencyCode,
    },
    cartSubtotal: shared.subtotal.currencyCode === currencyCode ? shared.subtotal : null,
    now: shared.now,
  };

  const result = resolvePrice({ rules: shared.rules, context });
  const perUnitDiscount = basePrice.amount - result.unitPrice.amount;

  // Nothing to do, or the rules would raise the price — which Shopify's
  // discount API cannot express and a buyer would never accept from a discount.
  if (perUnitDiscount <= 0) return null;

  const winningRule = shared.rules.find((rule) => rule.id === result.appliedRuleIds[0]);

  return {
    // Shown to the buyer at checkout, so it is the merchant's own rule name.
    message: winningRule?.name ?? "Wholesale price",
    targets: [{ cartLine: { id: line.id } }],
    value: {
      fixedAmount: {
        amount: formatMoney(money(perUnitDiscount, currencyCode)),
        // The engine returns a per-unit price, so the discount is per unit too.
        appliesToEachItem: true,
      },
    },
  };
}
