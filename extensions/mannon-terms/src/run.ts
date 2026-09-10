import {
  checkEligibility,
  deserializeBuyerTerms,
  deserializeSettings,
  termsFromPublished,
} from "@mannon/net-terms";
import { money, type Money } from "@mannon/pricing-engine";

import type { FunctionRunResult, MoneyV2, Operation, RunInput } from "./api";

/**
 * Who may pay later.
 *
 * Shopify has no concept of net terms, so a merchant sets up a manual payment
 * method — "Net terms", or whatever they call it — and this Function hides it
 * from everyone whose published terms do not allow it. An ineligible buyer sees
 * nothing, not a disabled button: a retail customer should never learn that
 * trade credit exists, let alone that they were refused it.
 *
 * **It never throws, and it fails closed.** A payment customization that throws
 * takes the store's checkout with it, so every branch returns a result. But
 * "return nothing and leave the methods alone" is the wrong safe default here:
 * it would show pay-later to every retail customer, and a buyer who selects it
 * takes the goods without paying. So an error hides the method instead —
 * checkout still works, and the worst outcome is a buyer with genuine terms
 * being asked to pay now, which they can email about.
 *
 * This is the opposite of the order-limits Function, which fails *open*, and
 * for the same reason: there, the harm is blocking a legitimate order; here,
 * the harm is extending credit nobody agreed to.
 */

const NO_CHANGES: FunctionRunResult = { operations: [] };

/**
 * Shopify hands money as a decimal string; terms are in integer minor units.
 *
 * A total we cannot read becomes zero, which fails no credit limit — the buyer
 * keeps the method they were entitled to rather than losing it to a parse.
 */
function toMoney(value: MoneyV2 | null | undefined): Money {
  const currencyCode = value?.currencyCode ?? "USD";
  const amount = Number(value?.amount ?? "0");
  if (!Number.isFinite(amount)) return money(0, currencyCode);
  return money(Math.round(amount * 100), currencyCode);
}

/** The buyer facts carry pricing tags and, since 3.2, terms alongside them. */
function termsFrom(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  return (parsed as { terms?: unknown }).terms ?? null;
}

export function run(input: RunInput): FunctionRunResult {
  // Found before the work below, so the catch can still hide it.
  let method: { id: string; name: string } | undefined;

  try {
    const settings = deserializeSettings(input.shop?.metafield?.jsonValue ?? null);
    const wanted = settings.methodName.trim().toLowerCase();
    if (!wanted) return NO_CHANGES;

    method = (input.paymentMethods ?? []).find(
      (candidate) => candidate?.name?.trim().toLowerCase() === wanted,
    );

    // The merchant has not set the method up, or has renamed it and not told
    // us. Nothing to hide, and nothing to be clever about.
    if (!method) return NO_CHANGES;

    const published = deserializeBuyerTerms(
      termsFrom(input.cart?.buyerIdentity?.customer?.metafield?.jsonValue ?? null),
    );

    const verdict = checkEligibility({
      isAuthenticated: input.cart?.buyerIdentity?.isAuthenticated === true,
      terms: published ? termsFromPublished(published) : null,
      outstanding: published
        ? money(published.outstanding, published.currencyCode)
        : money(0, "USD"),
      overdueCount: published?.overdueCount ?? 0,
      cartTotal: toMoney(input.cart?.cost?.totalAmount),
    });

    if (!verdict.eligible) {
      return { operations: [{ hide: { paymentMethodId: method.id } }] };
    }

    // Eligible. Say the terms on the button, so a buyer with Net 30 is not left
    // guessing what "Net terms" means for them.
    if (settings.showDaysInName && verdict.terms) {
      const name = `Pay later (Net ${verdict.terms.days})`;
      if (name !== method.name) {
        const operations: Operation[] = [
          { rename: { paymentMethodId: method.id, name } },
        ];
        return { operations };
      }
    }

    return NO_CHANGES;
  } catch {
    // Hide it if we got far enough to know which one it is. Extending credit
    // because of a bug is the one outcome worth being cautious about, and a
    // checkout that still completes is worth more than a correct button.
    return method
      ? { operations: [{ hide: { paymentMethodId: method.id } }] }
      : NO_CHANGES;
  }
}
