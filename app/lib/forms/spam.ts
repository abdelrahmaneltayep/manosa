/**
 * Spam protection for the public form.
 *
 * Three cheap signals, no captcha. A captcha taxes every real applicant to
 * stop the bots that a honeypot already stops, and the ones it does not stop
 * are solving captchas anyway.
 *
 * Pure, so the thresholds are testable and so the same verdict can be
 * explained to a merchant reviewing a false positive. Nothing here deletes
 * anything: a caught submission is stored with its reason, because a real
 * buyer wrongly marked spam is a lost customer that someone has to be able to
 * find.
 */

/** The hidden decoy field. Named to look worth filling in. */
export const HONEYPOT_FIELD = "website";
/** The hidden render timestamp. */
export const RENDERED_AT_FIELD = "_t";

/** A form filled in faster than this was not filled in by a person. */
export const MIN_FILL_MS = 3000;
/** Applications from one address in the window before we stop believing it. */
export const RATE_LIMIT = 5;
export const RATE_WINDOW_MS = 60 * 60 * 1000;

export type SpamReason = "honeypot" | "too_fast" | "rate_limit";

export interface SpamSignals {
  /** The decoy field. A browser leaves it empty; a bot fills everything in. */
  honeypot: string | null;
  /** When the form was rendered, from its hidden timestamp. */
  renderedAt: Date | null;
  now: Date;
  /** Submissions already seen from this address inside the window. */
  recentFromIp: number;
}

export interface SpamVerdict {
  spam: boolean;
  reason: SpamReason | null;
}

export function spamVerdict(signals: SpamSignals): SpamVerdict {
  if ((signals.honeypot ?? "").trim()) return { spam: true, reason: "honeypot" };

  if (signals.renderedAt) {
    const elapsed = signals.now.getTime() - signals.renderedAt.getTime();
    // A negative elapsed time means a forged or stale timestamp, not a fast
    // typist. Treated as too fast rather than trusted.
    if (elapsed < MIN_FILL_MS) return { spam: true, reason: "too_fast" };
  }

  if (signals.recentFromIp >= RATE_LIMIT) return { spam: true, reason: "rate_limit" };

  return { spam: false, reason: null };
}

/** Read the hidden render timestamp. A missing or junk value means unknown. */
export function readRenderedAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = Number(value);
  if (!Number.isFinite(at) || at <= 0) return null;

  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The client address, from the proxy headers Shopify and our host set.
 *
 * `x-forwarded-for` is a list; the first entry is the client. It is
 * spoofable — which is why it only ever costs an applicant a rate limit, and
 * never grants anything.
 */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("cf-connecting-ip") ?? headers.get("x-real-ip") ?? null;
}
