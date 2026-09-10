/**
 * The quote lifecycle, as a pure function of where it is and what happened.
 *
 * New → Drafted → Sent → Accepted, with Declined and Expired as the two ways it
 * ends without an order. Kept out of the server module because the merchant's
 * page, the buyer's page and the expiry job all have to agree about what is
 * allowed, and a state machine spread across three callers is three chances to
 * disagree.
 *
 * No clock is read here: `now` is always an argument, so a quote renders the
 * same twice and the expiry job can be tested without waiting a fortnight.
 */

export type QuoteState = "NEW" | "DRAFTED" | "SENT" | "ACCEPTED" | "DECLINED" | "EXPIRED";

export type QuoteAction =
  /** Merchant prices the request. This is when prices are locked. */
  | "draft"
  /** Merchant sends it to the buyer. */
  | "send"
  /** Buyer accepts. Becomes a draft order. */
  | "accept"
  /** Buyer declines. */
  | "decline"
  /** Merchant withdraws it before the buyer acts. */
  | "withdraw"
  /** The expiry job, or the buyer arriving after the date. */
  | "expire"
  /** Merchant re-prices an expired or declined quote. */
  | "reopen";

const ALLOWED: Readonly<Record<QuoteState, readonly QuoteAction[]>> = {
  // A merchant can price a request, or throw it away.
  NEW: ["draft", "withdraw"],
  // Priced but not sent: still theirs to change.
  DRAFTED: ["draft", "send", "withdraw"],
  // With the buyer. Only the buyer, or time, moves it now — a merchant who
  // wants to change a sent quote re-drafts it, which re-prices and re-sends,
  // so the buyer never sees one price and accepts another.
  SENT: ["accept", "decline", "expire", "withdraw"],
  // Terminal. An accepted quote is a draft order; changing it is Shopify's job.
  ACCEPTED: [],
  DECLINED: ["reopen"],
  EXPIRED: ["reopen"],
};

export function canTransition(from: QuoteState, action: QuoteAction): boolean {
  return ALLOWED[from].includes(action);
}

export function allowedActions(from: QuoteState): readonly QuoteAction[] {
  return ALLOWED[from];
}

const RESULT: Readonly<Record<QuoteAction, QuoteState>> = {
  draft: "DRAFTED",
  send: "SENT",
  accept: "ACCEPTED",
  decline: "DECLINED",
  withdraw: "DECLINED",
  expire: "EXPIRED",
  reopen: "DRAFTED",
};

export class QuoteTransitionError extends Error {
  constructor(
    readonly from: QuoteState,
    readonly action: QuoteAction,
  ) {
    super(`A ${from.toLowerCase()} quote cannot be ${action}ed.`);
    this.name = "QuoteTransitionError";
  }
}

export function transition(from: QuoteState, action: QuoteAction): QuoteState {
  if (!canTransition(from, action)) throw new QuoteTransitionError(from, action);
  return RESULT[action];
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

/** The checklist's defaults: expire after a fortnight, warn three days out. */
export const DEFAULT_EXPIRY_DAYS = 14;
export const DEFAULT_REMINDER_DAYS = 3;

const DAY_MS = 86_400_000;

export function expiryFrom(sentAt: Date, days: number): Date {
  const expires = new Date(sentAt.getTime());
  expires.setUTCDate(expires.getUTCDate() + Math.max(1, Math.trunc(days)));
  return expires;
}

/** Whole days left, in UTC. Negative once it has passed. */
export function daysUntil(expiresAt: Date, now: Date): number {
  const a = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const b = Date.UTC(
    expiresAt.getUTCFullYear(),
    expiresAt.getUTCMonth(),
    expiresAt.getUTCDate(),
  );
  return Math.floor((b - a) / DAY_MS);
}

/**
 * Has this quote run out?
 *
 * A quote with no expiry date never does — a merchant who cleared the field
 * meant "this one stands". Only a sent quote can expire: one still being
 * drafted has not been promised to anybody.
 */
export function hasExpired(
  quote: { status: QuoteState; expiresAt: Date | null },
  now: Date,
): boolean {
  if (quote.status !== "SENT" || !quote.expiresAt) return false;
  return quote.expiresAt.getTime() <= now.getTime();
}

/** Time to warn the buyer — once, and only while it can still be accepted. */
export function isDueForReminder(
  quote: { status: QuoteState; expiresAt: Date | null; remindedAt: Date | null },
  now: Date,
  reminderDays: number,
): boolean {
  if (quote.status !== "SENT" || !quote.expiresAt) return false;
  if (quote.remindedAt) return false;
  if (hasExpired(quote, now)) return false;
  return daysUntil(quote.expiresAt, now) <= Math.max(0, Math.trunc(reminderDays));
}
