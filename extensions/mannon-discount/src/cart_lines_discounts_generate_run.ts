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

  const now = readNow(input);
  const customer = readCustomer(input);
  const subtotal = readSubtotal(input);
  const candidates: CartLinesDiscountsGenerateRunResult["operations"][0]["productDiscountsAdd"]["candidates"] =
    [];

  for (const line of input.cart.lines) {
    // Per line, because the header above promises it: anything unexpected must
    // cost one line, not the cart. One unreadable amount used to fall out to
    // the catch in `cartLinesDiscountsGenerateRun` and charge every other line
    // in the cart at retail too.
    let candidate: ReturnType<typeof discountFor> = null;
    try {
      candidate = discountFor(line, { customer, subtotal, now, rules: usable });
    } catch (error) {
      console.error(`[mannon] skipping cart line ${line.id}`, error);
    }
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

/**
 * What "now" is, for a schedule.
 *
 * The store's own clock first. This was `new Date()`, and the Function sandbox's
 * wall clock is not a dependable source of the store's time — `shop.localTime`
 * exists in the input schema precisely because it is not. A fixed or
 * epoch-zero clock would leave every rule with a `startsAt` permanently
 * `not_started` and every rule with an `endsAt` never ending, while the admin
 * showed them scheduled correctly.
 *
 * `localTime.date` is a `YYYY-MM-DD` in the shop's zone, and the schedules it
 * is compared against are day boundaries in that same zone (see
 * `rule-form.server.ts`), so midday is the instant furthest from either edge —
 * the one that cannot land on the wrong side of a boundary because of the
 * offset this field does not carry.
 *
 * Falls back to the sandbox clock, which is what there was before and is
 * better than nothing.
 */
function readNow(input: FunctionInput): Date {
  const date = input.shop?.localTime?.date;
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const midday = new Date(`${date}T12:00:00Z`);
    if (!Number.isNaN(midday.getTime())) return midday;
  }
  return new Date();
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

/**
 * The cart's subtotal, or null when it cannot be read.
 *
 * Null is honest and cheap: `cartSubtotal: null` makes the engine skip
 * cart-value tiers and apply everything else, so an amount we cannot represent
 * costs the buyer one kind of rule rather than every wholesale price in the
 * cart.
 */
function readSubtotal(input: FunctionInput) {
  const { amount, currencyCode } = input.cart.cost.subtotalAmount;
  try {
    return parseMoney(amount, currencyCode);
  } catch (error) {
    console.error("[mannon] cart subtotal could not be read", error);
    return null;
  }
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
    cartSubtotal:
      shared.subtotal && shared.subtotal.currencyCode === currencyCode
        ? shared.subtotal
        : null,
    now: shared.now,
  };

  const result = resolvePrice({ rules: shared.rules, context });
  const perUnitDiscount = basePrice.amount - result.unitPrice.amount;

  // Nothing to do, or the rules would raise the price — which Shopify's
  // discount API cannot express and a buyer would never accept from a discount.
  if (perUnitDiscount <= 0) return null;

  // Every rule that moved this price, not only the first. A stacked price used
  // to arrive at checkout under one rule's name, with nothing to say a second
  // had applied — invariant 5 ("deciding shows its working") on the side of the
  // person paying.
  const names = result.appliedRuleIds
    .map((id) => shared.rules.find((rule) => rule.id === id)?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);

  return {
    // Shown to the buyer at checkout, so it is the merchant's own rule names.
    message: discountMessage(names),
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

/**
 * Shopify's own cap on a discount message. Past it the platform truncates,
 * which would cut a merchant's rule name in half mid-word.
 */
const MESSAGE_LIMIT = 255;

/**
 * The rules that made this price, as one line the buyer can read.
 *
 * Names are joined rather than summarised: "Trade 20% + Autumn clearance" tells
 * a buyer why their price moved twice. When the names will not fit, the count
 * of what is left over is kept instead of a name sliced mid-word — a merchant
 * can look the rest up, a buyer cannot unsee "Autumn clea".
 */
export function discountMessage(names: readonly string[]): string {
  const first = names[0];
  if (first === undefined) return "Wholesale price";

  // The longest run of names that fits *together with* the count of whatever
  // is left over. Tested before each name is added rather than after, so the
  // "+ 2 more" that tells the buyer there is more can never be the part that
  // gets squeezed out. One name too long for the cap on its own is cut to it —
  // Shopify would cut it anyway, and at a length we do not control.
  let message = first.slice(0, MESSAGE_LIMIT);

  for (let taken = 1; taken <= names.length; taken += 1) {
    const joined = names.slice(0, taken).join(" + ");
    const left = names.length - taken;
    const candidate = left > 0 ? `${joined} + ${left} more` : joined;
    if (candidate.length > MESSAGE_LIMIT) break;
    message = candidate;
  }

  return message;
}
