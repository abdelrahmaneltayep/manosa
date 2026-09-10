import { describe, expect, it } from "vitest";

import {
  allowedActions,
  canTransition,
  daysUntil,
  DEFAULT_EXPIRY_DAYS,
  expiryFrom,
  hasExpired,
  isDueForReminder,
  QuoteTransitionError,
  transition,
  type QuoteState,
} from "~/lib/quotes/state";

/**
 * The lifecycle the checklist names: New → Drafted → Sent → Accepted/Expired.
 *
 * Three callers depend on this agreeing with itself — the merchant's page, the
 * buyer's accept page and the expiry job — so every edge is asserted here
 * rather than in each of them.
 */

const NOW = new Date("2026-09-10T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const daysAhead = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

describe("the lifecycle", () => {
  it("walks the happy path", () => {
    expect(transition("NEW", "draft")).toBe("DRAFTED");
    expect(transition("DRAFTED", "send")).toBe("SENT");
    expect(transition("SENT", "accept")).toBe("ACCEPTED");
  });

  it("lets a merchant re-price before sending, but not after", () => {
    expect(canTransition("DRAFTED", "draft")).toBe(true);
    // Re-pricing a sent quote behind the buyer's back would let them accept one
    // price and be charged another.
    expect(canTransition("SENT", "draft")).toBe(false);
  });

  it("makes an accepted quote terminal", () => {
    expect(allowedActions("ACCEPTED")).toEqual([]);
    expect(() => transition("ACCEPTED", "decline")).toThrow(QuoteTransitionError);
  });

  it("lets a declined or expired quote be reopened, but not accepted", () => {
    expect(transition("EXPIRED", "reopen")).toBe("DRAFTED");
    expect(transition("DECLINED", "reopen")).toBe("DRAFTED");
    expect(canTransition("EXPIRED", "accept")).toBe(false);
    expect(canTransition("DECLINED", "accept")).toBe(false);
  });

  it("only expires a quote that was actually sent", () => {
    expect(canTransition("NEW", "expire")).toBe(false);
    expect(canTransition("DRAFTED", "expire")).toBe(false);
    expect(canTransition("SENT", "expire")).toBe(true);
  });

  it("names the state and the action when it refuses", () => {
    try {
      transition("NEW", "accept");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(QuoteTransitionError);
      expect((error as QuoteTransitionError).from).toBe("NEW");
    }
  });

  it("every state's allowed actions actually transition", () => {
    const states: QuoteState[] = [
      "NEW",
      "DRAFTED",
      "SENT",
      "ACCEPTED",
      "DECLINED",
      "EXPIRED",
    ];
    for (const state of states) {
      for (const action of allowedActions(state)) {
        expect(() => transition(state, action)).not.toThrow();
      }
    }
  });
});

describe("expiry", () => {
  it("counts from when it was sent, not when it was drafted", () => {
    expect(expiryFrom(new Date("2026-09-10T12:00:00Z"), 14).toISOString()).toBe(
      "2026-09-24T12:00:00.000Z",
    );
  });

  it("crosses a month boundary", () => {
    expect(expiryFrom(new Date("2026-12-28T00:00:00Z"), 14).toISOString()).toBe(
      "2027-01-11T00:00:00.000Z",
    );
  });

  it("never produces an expiry before it was sent", () => {
    const sent = new Date("2026-09-10T12:00:00Z");
    expect(expiryFrom(sent, 0).getTime()).toBeGreaterThan(sent.getTime());
    expect(expiryFrom(sent, -5).getTime()).toBeGreaterThan(sent.getTime());
  });

  it("does not mutate the date it was given", () => {
    const sent = new Date("2026-09-10T12:00:00Z");
    expiryFrom(sent, DEFAULT_EXPIRY_DAYS);
    expect(sent.toISOString()).toBe("2026-09-10T12:00:00.000Z");
  });

  it("counts whole days regardless of the time of day", () => {
    expect(daysUntil(new Date("2026-09-11T01:00:00Z"), NOW)).toBe(1);
    expect(daysUntil(new Date("2026-09-10T23:59:00Z"), NOW)).toBe(0);
    expect(daysUntil(new Date("2026-09-09T23:00:00Z"), NOW)).toBe(-1);
  });

  it("expires a sent quote past its date, and nothing else", () => {
    expect(hasExpired({ status: "SENT", expiresAt: daysAgo(1) }, NOW)).toBe(true);
    expect(hasExpired({ status: "SENT", expiresAt: daysAhead(1) }, NOW)).toBe(false);
    // A quote with no date stands until somebody acts on it.
    expect(hasExpired({ status: "SENT", expiresAt: null }, NOW)).toBe(false);
    expect(hasExpired({ status: "DRAFTED", expiresAt: daysAgo(1) }, NOW)).toBe(false);
    expect(hasExpired({ status: "ACCEPTED", expiresAt: daysAgo(1) }, NOW)).toBe(false);
  });
});

describe("the reminder", () => {
  const quote = (overrides: Partial<Parameters<typeof isDueForReminder>[0]> = {}) => ({
    status: "SENT" as QuoteState,
    expiresAt: daysAhead(3),
    remindedAt: null,
    ...overrides,
  });

  it("fires three days out, per the checklist", () => {
    expect(isDueForReminder(quote(), NOW, 3)).toBe(true);
    expect(isDueForReminder(quote({ expiresAt: daysAhead(4) }), NOW, 3)).toBe(false);
  });

  it("fires once, not every time the job runs", () => {
    expect(isDueForReminder(quote({ remindedAt: daysAgo(1) }), NOW, 3)).toBe(false);
  });

  it("does not warn about a quote that has already run out", () => {
    // "Three days left" on something that expired yesterday is worse than
    // silence.
    expect(isDueForReminder(quote({ expiresAt: daysAgo(1) }), NOW, 3)).toBe(false);
  });

  it("does not chase a quote nobody has been sent", () => {
    expect(isDueForReminder(quote({ status: "DRAFTED" }), NOW, 3)).toBe(false);
    expect(isDueForReminder(quote({ expiresAt: null }), NOW, 3)).toBe(false);
  });
});
