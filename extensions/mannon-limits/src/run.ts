import {
  deserializeLimits,
  evaluateLimits,
  renderMessage,
  type CartFacts,
  type MessageKey,
  type Violation,
} from "@mannon/order-limits";
import {
  formatMoneyWithCode,
  money,
  parseMoney,
  type Money,
} from "@mannon/pricing-engine";

import type { FunctionError, FunctionRunResult, MoneyV2, RunInput } from "./api";

/**
 * Order limits at the cart and at checkout.
 *
 * This Function computes nothing itself. It reads the limits the app published
 * and asks `@mannon/order-limits` — the same module the admin's preview asks —
 * so a limit cannot read one way in the admin and block differently here.
 *
 * **It never throws.** A validation Function that fails blocks every checkout
 * in the store, wholesale and retail alike. Every branch below either produces
 * an error message or returns none; a limit we cannot read is dropped, which
 * can only ever let an order through.
 */

/** The buyer facts the app publishes on each customer. */
interface BuyerFacts {
  tags?: unknown;
  groupIds?: unknown;
}

const stringsIn = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

/**
 * Shopify hands money as a decimal string; the limits are in integer minor
 * units. Parsing here rather than in the pure module keeps the wire format out
 * of it.
 *
 * Through the engine's own parser, which knows each currency's exponent. This
 * used to be `Math.round(amount * 100)` for every currency, so a ¥1,000
 * minimum read a ¥1,000 cart as ¥100,000 and let every yen order through.
 */
function toMoney(value: MoneyV2 | null | undefined): Money {
  const currencyCode = value?.currencyCode ?? "USD";
  try {
    return parseMoney(value?.amount ?? "0", currencyCode);
  } catch {
    // A total we cannot read becomes zero, which fails no maximum and only ever
    // trips a minimum the buyer would have tripped anyway.
    return money(0, currencyCode);
  }
}

/** A money violation formats as money; a quantity violation as a plain count. */
function describe(violation: Violation): {
  gap: string;
  required: string;
  actual: string;
} {
  const asText = (value: Money | number) =>
    typeof value === "number" ? String(value) : formatMoneyWithCode(value);

  return {
    gap: asText(violation.gap),
    required: asText(violation.required),
    actual: asText(violation.actual),
  };
}

export function run(input: RunInput): FunctionRunResult {
  try {
    const published = deserializeLimits(input.shop?.metafield?.jsonValue ?? null);
    if (published.limits.length === 0) return { errors: [] };

    const buyer = (input.cart?.buyerIdentity?.customer?.metafield?.jsonValue ??
      null) as BuyerFacts | null;

    const subtotal = toMoney(input.cart?.cost?.subtotalAmount);
    const totalQuantity = (input.cart?.lines ?? []).reduce(
      (sum, line) => sum + (Number(line?.quantity) || 0),
      0,
    );

    const facts: CartFacts = {
      subtotal,
      totalQuantity,
      groupIds: stringsIn(buyer?.groupIds),
      tags: stringsIn(buyer?.tags),
      countryCode: input.localization?.country?.isoCode ?? null,
      // POS carts do not reach this target, and the input carries no source, so
      // the bypass is honoured by the app when it publishes rather than here.
      isPos: false,
      isAuthenticated: input.cart?.buyerIdentity?.isAuthenticated === true,
    };

    const verdict = evaluateLimits(published.limits, facts);
    if (verdict.violations.length === 0) return { errors: [] };

    const errors: FunctionError[] = verdict.violations.map((violation) => ({
      localizedMessage: renderMessage(
        published.messages[violation.code as MessageKey],
        describe(violation),
      ),
      target: "$.cart",
    }));

    return { errors };
  } catch {
    // Nothing here is worth blocking a store's whole checkout for.
    return { errors: [] };
  }
}
