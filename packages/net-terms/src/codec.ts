import { money, type Money } from "@mannon/pricing-engine";

import type { Terms, TermsSource } from "./types";

/**
 * The wire format for a buyer's terms.
 *
 * Two things travel, and they go to different places.
 *
 * The **shop** metafield carries the settings that are the same for everyone:
 * the name of the pay-later payment method to show or hide, and whether an
 * overdue invoice blocks further credit.
 *
 * The **customer** metafield carries what is true of that buyer — their days,
 * their limit, what they already owe. It rides along with the buyer facts the
 * pricing Function already reads, because a second metafield would be a second
 * thing to keep in step.
 */

export const TERMS_FORMAT_VERSION = 1;

/** The default name of the manual payment method a merchant sets up. */
export const DEFAULT_METHOD_NAME = "Net terms";

export interface SerializedTermsSettings {
  v: number;
  /** The payment method to show only to eligible buyers. */
  methodName: string;
  /** Rename it to say the terms, e.g. "Pay later (Net 30)". */
  showDaysInName: boolean;
  /** An unpaid invoice past its due date stops further credit. */
  overdueBlocks: boolean;
}

export const DEFAULT_SETTINGS: Omit<SerializedTermsSettings, "v"> = {
  methodName: DEFAULT_METHOD_NAME,
  showDaysInName: true,
  overdueBlocks: true,
};

/** A buyer's terms, as published on their customer metafield. */
export interface SerializedBuyerTerms {
  days: number;
  /** Minor units, or null for no ceiling. */
  creditLimit: number | null;
  /** Minor units they already owe. */
  outstanding: number;
  overdueCount: number;
  currencyCode: string;
}

export function serializeSettings(
  settings: Partial<Omit<SerializedTermsSettings, "v">> = {},
): SerializedTermsSettings {
  return { v: TERMS_FORMAT_VERSION, ...DEFAULT_SETTINGS, ...settings };
}

/**
 * Parsing is defensive and never throws.
 *
 * A payment Function that crashes takes the store's checkout with it. Anything
 * unreadable falls back to the defaults, and the worst that produces is a
 * payment method shown to somebody who should not see it — which a merchant can
 * see and fix, unlike a checkout that will not load.
 */
export function deserializeSettings(value: unknown): SerializedTermsSettings {
  const parsed = asObject(value);
  if (!parsed) return serializeSettings();

  const envelope = parsed as Partial<SerializedTermsSettings>;
  if (envelope.v !== TERMS_FORMAT_VERSION) return serializeSettings();

  return {
    v: TERMS_FORMAT_VERSION,
    methodName:
      typeof envelope.methodName === "string" && envelope.methodName.trim()
        ? envelope.methodName.trim()
        : DEFAULT_METHOD_NAME,
    showDaysInName: envelope.showDaysInName !== false,
    overdueBlocks: envelope.overdueBlocks !== false,
  };
}

/**
 * A buyer's terms from their metafield.
 *
 * Returns null for anything it cannot read, and null means "no terms" — the
 * pay-later method is hidden. Failing towards *not* offering credit is the
 * right direction: the cost is a buyer who has to pay now and emails about it,
 * not a merchant extending credit they never agreed to.
 */
export function deserializeBuyerTerms(value: unknown): SerializedBuyerTerms | null {
  const parsed = asObject(value);
  if (!parsed) return null;

  const raw = parsed as Partial<SerializedBuyerTerms>;
  const days = Number(raw.days);
  if (!Number.isInteger(days) || days <= 0) return null;

  const currencyCode =
    typeof raw.currencyCode === "string" && raw.currencyCode.length === 3
      ? raw.currencyCode.toUpperCase()
      : null;
  if (!currencyCode) return null;

  const creditLimit = Number(raw.creditLimit);
  const outstanding = Number(raw.outstanding);
  const overdueCount = Number(raw.overdueCount);

  return {
    days,
    creditLimit:
      raw.creditLimit === null || !Number.isFinite(creditLimit) || creditLimit < 0
        ? null
        : Math.trunc(creditLimit),
    // An unreadable balance counts as zero owed rather than blocking a buyer
    // over a number we could not read.
    outstanding:
      Number.isFinite(outstanding) && outstanding > 0 ? Math.trunc(outstanding) : 0,
    overdueCount:
      Number.isFinite(overdueCount) && overdueCount > 0 ? Math.trunc(overdueCount) : 0,
    currencyCode,
  };
}

/** The published shape, back as the terms the pure module works in. */
export function termsFromPublished(published: SerializedBuyerTerms): Terms {
  return {
    days: published.days,
    creditLimit:
      published.creditLimit === null
        ? null
        : money(published.creditLimit, published.currencyCode),
    // The published copy has already resolved customer-over-group; which level
    // it came from is the admin's business, not the checkout's.
    source: "customer",
  };
}

export function publishedFrom(
  terms: Terms,
  outstanding: Money,
  overdueCount: number,
): SerializedBuyerTerms {
  return {
    days: terms.days,
    creditLimit: terms.creditLimit?.amount ?? null,
    outstanding: outstanding.amount,
    overdueCount,
    currencyCode: outstanding.currencyCode,
  };
}

/** What a stored level looks like before the customer-over-group rule. */
export function sourceFrom(
  days: number | null,
  creditLimit: number | null,
): TermsSource | null {
  if (days === null && creditLimit === null) return null;
  return { days, creditLimit };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;

  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : null;
}
