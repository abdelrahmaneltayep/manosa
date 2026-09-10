import { money, type Money } from "@mannon/pricing-engine";

import type { OrderLimit } from "./types";

/**
 * The wire format for the published limits.
 *
 * The app writes it to a shop metafield; the cart validation Function reads it
 * back at checkout. Both sides use this module, so there is one definition of
 * the format rather than two that drift.
 *
 * The message templates travel with the limits, because the Function is what
 * renders them and it cannot call our API to ask.
 */

export const LIMITS_FORMAT_VERSION = 1;

export type MessageKey =
  | "below_minimum_subtotal"
  | "above_maximum_subtotal"
  | "below_minimum_quantity"
  | "above_maximum_quantity"
  | "not_a_multiple";

export type MessageTemplates = Record<MessageKey, string>;

/**
 * What a buyer is told when their cart does not qualify.
 *
 * `{{gap}}` is the number that makes the message actionable — the checklist's
 * "Add $38 to reach your $200 minimum" — and the reason the evaluator returns
 * numbers rather than sentences.
 */
export const DEFAULT_MESSAGES: MessageTemplates = {
  below_minimum_subtotal: "Add {{gap}} to reach your {{required}} minimum order.",
  above_maximum_subtotal: "This order is {{gap}} over your {{required}} maximum.",
  below_minimum_quantity: "Add {{gap}} more items to reach the {{required}} minimum.",
  above_maximum_quantity: "Remove {{gap}} items to stay within the {{required}} maximum.",
  not_a_multiple:
    "These are sold in cases of {{required}}. Add {{gap}} to complete a case.",
};

export interface SerializedLimits {
  v: number;
  limits: SerializedLimit[];
  messages: MessageTemplates;
  /** Orders taken in person ignore these. */
  posBypasses: boolean;
}

interface SerializedMoney {
  amount: number;
  currencyCode: string;
}

export interface SerializedLimit {
  id: string;
  enabled: boolean;
  groupId: string | null;
  minSubtotal: SerializedMoney | null;
  maxSubtotal: SerializedMoney | null;
  minQuantity: number | null;
  maxQuantity: number | null;
  quantityIncrement: number | null;
  countries: string[];
}

const wireMoney = (value: Money | null): SerializedMoney | null =>
  value ? { amount: value.amount, currencyCode: value.currencyCode } : null;

export function serializeLimits(
  limits: readonly OrderLimit[],
  messages: MessageTemplates,
  posBypasses: boolean,
): SerializedLimits {
  return {
    v: LIMITS_FORMAT_VERSION,
    posBypasses,
    messages,
    limits: limits.map((limit) => ({
      id: limit.id,
      enabled: limit.enabled,
      groupId: limit.groupId,
      minSubtotal: wireMoney(limit.minSubtotal),
      maxSubtotal: wireMoney(limit.maxSubtotal),
      minQuantity: limit.minQuantity,
      maxQuantity: limit.maxQuantity,
      quantityIncrement: limit.quantityIncrement,
      countries: limit.countries,
    })),
  };
}

export interface DeserializedLimits {
  limits: OrderLimit[];
  messages: MessageTemplates;
  posBypasses: boolean;
  /** Never thrown. A limit that cannot be read is dropped and named here. */
  errors: string[];
}

/**
 * Parsing is defensive and never throws.
 *
 * A validation Function that crashes blocks every checkout in the store. One
 * malformed limit must cost that limit, not the shop's whole day — so an
 * unreadable limit is dropped, which can only ever let an order through.
 */
export function deserializeLimits(value: unknown): DeserializedLimits {
  const empty: DeserializedLimits = {
    limits: [],
    messages: { ...DEFAULT_MESSAGES },
    posBypasses: true,
    errors: [],
  };

  if (value === null || value === undefined) return empty;

  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ...empty, errors: ["limits are not valid JSON"] };
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ...empty, errors: ["limits are not an object"] };
  }

  const envelope = parsed as Partial<SerializedLimits>;

  if (envelope.v !== LIMITS_FORMAT_VERSION) {
    // A newer format from a newer app version. Refusing means no limits apply,
    // which lets orders through — the safe direction for a blocker.
    return {
      ...empty,
      errors: [`limits format v${String(envelope.v)} is not v${LIMITS_FORMAT_VERSION}`],
    };
  }

  const errors: string[] = [];
  const limits: OrderLimit[] = [];

  for (const raw of Array.isArray(envelope.limits) ? envelope.limits : []) {
    const limit = readLimit(raw);
    if (limit) limits.push(limit);
    else errors.push("a limit could not be read");
  }

  return {
    limits,
    messages: readMessages(envelope.messages),
    posBypasses: envelope.posBypasses !== false,
    errors,
  };
}

function readMoney(value: unknown): Money | null {
  if (typeof value !== "object" || value === null) return null;
  const node = value as Partial<SerializedMoney>;
  if (!Number.isSafeInteger(node.amount) || typeof node.currencyCode !== "string") {
    return null;
  }
  return money(node.amount!, node.currencyCode);
}

function readCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

function readLimit(raw: unknown): OrderLimit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const node = raw as Partial<SerializedLimit>;
  if (typeof node.id !== "string") return null;

  return {
    id: node.id,
    enabled: node.enabled !== false,
    groupId: typeof node.groupId === "string" ? node.groupId : null,
    minSubtotal: readMoney(node.minSubtotal),
    maxSubtotal: readMoney(node.maxSubtotal),
    minQuantity: readCount(node.minQuantity),
    maxQuantity: readCount(node.maxQuantity),
    quantityIncrement: readCount(node.quantityIncrement),
    countries: Array.isArray(node.countries)
      ? node.countries.filter((code): code is string => typeof code === "string")
      : [],
  };
}

function readMessages(value: unknown): MessageTemplates {
  const node = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const out = { ...DEFAULT_MESSAGES };

  for (const key of Object.keys(DEFAULT_MESSAGES) as MessageKey[]) {
    // A blank template would leave the buyer blocked with nothing to read, so
    // it falls back to the default rather than to silence.
    if (typeof node[key] === "string" && (node[key] as string).trim()) {
      out[key] = node[key] as string;
    }
  }

  return out;
}

/** Fill a message template. Missing values render as nothing, not as braces. */
export function renderMessage(
  template: string,
  values: { gap: string; required: string; actual: string },
): string {
  return template.replace(
    /\{\{\s*(gap|required|actual)\s*\}\}/g,
    (_match, key: string) => (values as Record<string, string>)[key] ?? "",
  );
}
