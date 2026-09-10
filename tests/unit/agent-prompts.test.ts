import { describe, expect, it } from "vitest";

import {
  MAX_ITEMS,
  MAX_REASON,
  briefingUser,
  readBriefing,
} from "~/lib/ai/prompts/briefing.server";
import { readAsk } from "~/lib/ai/prompts/ask.server";
import { readPo } from "~/lib/ai/prompts/purchase-order.server";
import type { AgentFact } from "~/lib/agent/facts.server";

/**
 * The three ✦ agent surfaces, and the one thing each must never do.
 *
 * The briefing must never supply a number. The Ask bar must never route to a
 * write. PO-to-order must never invent a line. All three are enforced by the
 * reader, not by the prompt — a prompt is a request, and a reader is a rule.
 */

const facts: AgentFact[] = [
  {
    kind: "applications_waiting",
    count: 6,
    amount: null,
    href: "/app/customers/applications",
    subject: null,
  },
  {
    kind: "invoices_overdue",
    count: 2,
    amount: { amount: 120_000, currencyCode: "USD" },
    href: "/app/orders/terms",
    subject: null,
  },
];

describe("the briefing prompt", () => {
  it("gives the model the facts, and the mute list", () => {
    const prompt = briefingUser(facts, { locale: "en", muted: ["rules_unused"] });

    expect(prompt).toContain("applications_waiting");
    expect(prompt).toContain("count: 6");
    expect(prompt).toContain("rules_unused");
  });

  it("says there is nothing rather than sending an empty list", () => {
    const prompt = briefingUser([], { locale: "en", muted: [] });
    expect(prompt).toContain("(nothing at all)");
  });
});

describe("readBriefing", () => {
  const answer = (items: unknown) => ({ items });
  const read = (value: unknown) => readBriefing(value, facts);

  it("reads a good briefing", () => {
    const result = read(
      answer([{ kind: "invoices_overdue", reason: "Money that is already late." }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items[0]?.kind).toBe("invoices_overdue");
  });

  it("refuses a reason containing a number", () => {
    // The rule the whole feature rests on: the app renders its own figures, so
    // a number written by the model is the one that can be wrong.
    const result = read(
      answer([{ kind: "invoices_overdue", reason: "2 invoices are overdue." }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("number");
  });

  it("refuses a kind that is not true of this shop today", () => {
    const result = read(
      answer([{ kind: "credit_exceeded", reason: "Someone is over their limit." }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("credit_exceeded");
  });

  it("refuses a kind that does not exist at all", () => {
    expect(read(answer([{ kind: "profits_down", reason: "Hmm." }])).ok).toBe(false);
  });

  it("accepts an empty list, because a quiet morning is an answer", () => {
    const result = read(answer([]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toEqual([]);
  });

  it("caps the list at three", () => {
    const result = readBriefing(
      answer(
        [
          "applications_waiting",
          "invoices_overdue",
          "quotes_expiring",
          "rules_unused",
        ].map((kind) => ({ kind, reason: "Worth a look." })),
      ),
      [
        ...facts,
        { kind: "quotes_expiring", count: 1, amount: null, href: "/", subject: null },
        { kind: "rules_unused", count: 1, amount: null, href: "/", subject: null },
      ],
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.value.items).toHaveLength(MAX_ITEMS);
  });

  it("refuses a reason longer than a line", () => {
    const result = read(
      answer([{ kind: "invoices_overdue", reason: "x".repeat(MAX_REASON + 1) }]),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses an item with no reason", () => {
    expect(read(answer([{ kind: "invoices_overdue", reason: "  " }])).ok).toBe(false);
  });

  it("drops a repeated kind rather than showing it twice", () => {
    const result = read(
      answer([
        { kind: "invoices_overdue", reason: "Late money." },
        { kind: "invoices_overdue", reason: "Still late." },
      ]),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.items).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */

describe("readAsk", () => {
  it("reads a lookup", () => {
    const result = readAsk({ intent: "list_overdue", days: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.intent).toBe("list_overdue");
    expect(result.value.days).toBe(30);
  });

  it("refuses an intent it does not know", () => {
    // There is no "delete_rules" intent, so there is nothing for a jailbreak
    // to route to. This is the whole security model of the bar.
    expect(readAsk({ intent: "delete_rules" }).ok).toBe(false);
    expect(readAsk({ intent: "run_sql", search: "DROP TABLE" }).ok).toBe(false);
  });

  it("insists a change names the page it opens", () => {
    const result = readAsk({ intent: "open_builder", target: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("target");
  });

  it("refuses a target that is not one of our pages", () => {
    expect(readAsk({ intent: "open_builder", target: "shopify_admin" }).ok).toBe(false);
  });

  it("bounds the numbers a routing can carry", () => {
    const result = readAsk({
      intent: "wholesale_sales",
      days: 99_999,
      quantity: -4,
    });
    if (!result.ok) throw new Error(result.error);
    // Out of range becomes "not given", which every branch has a default for.
    expect(result.value.days).toBeNull();
    expect(result.value.quantity).toBeNull();
  });

  it("bounds free text so a routing cannot carry a payload", () => {
    const result = readAsk({ intent: "find_rule", search: "x".repeat(500) });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.search?.length).toBeLessThanOrEqual(120);
  });

  it("refuses an answer that is not an object", () => {
    expect(readAsk("list_overdue").ok).toBe(false);
    expect(readAsk(null).ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("readPo", () => {
  const po = (lines: unknown, extra: Record<string, unknown> = {}) => ({
    lines,
    reference: "PO-4471",
    notes: null,
    ...extra,
  });

  it("reads lines with a SKU", () => {
    const result = readPo(
      po([{ sku: "MUG-BLUE", description: null, quantity: 200, statedPrice: "4.00" }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines[0]).toEqual({
      sku: "MUG-BLUE",
      description: null,
      quantity: 200,
      statedPrice: "4.00",
    });
    expect(result.value.reference).toBe("PO-4471");
  });

  it("reads a line that only has words", () => {
    const result = readPo(
      po([{ sku: null, description: "the blue mugs", quantity: 50, statedPrice: null }]),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a line with neither a code nor a description", () => {
    const result = readPo(po([{ sku: null, description: null, quantity: 5 }]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("nothing can be matched");
  });

  it("refuses a quantity that is not a whole number of units", () => {
    expect(readPo(po([{ sku: "A", quantity: 0 }])).ok).toBe(false);
    expect(readPo(po([{ sku: "A", quantity: 2.5 }])).ok).toBe(false);
    expect(readPo(po([{ sku: "A", quantity: "many" }])).ok).toBe(false);
  });

  it("refuses a price with a currency symbol", () => {
    const result = readPo(po([{ sku: "A", quantity: 1, statedPrice: "$4.00" }]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("plain decimal");
  });

  it("refuses an empty order rather than creating nothing", () => {
    const result = readPo(po([]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("No order lines");
  });

  it("refuses an answer that is not an object", () => {
    expect(readPo("200 mugs").ok).toBe(false);
  });
});
