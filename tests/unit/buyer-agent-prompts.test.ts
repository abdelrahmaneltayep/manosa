import { describe, expect, it } from "vitest";

import {
  normalizeFigure,
  readRoutedTurn,
  statedFigures,
  unbackedFigures,
  type AgentTurnGrounding,
} from "~/lib/ai/prompts/buyer-agent.server";
import { MAX_LINES } from "~/lib/agent/buyer/tools.server";

/**
 * The two guards the Buyer Agent rests on.
 *
 * `readRoutedTurn` decides whether a model answer may reach a tool at all.
 * `unbackedFigures` decides whether a reply may reach a buyer. The second is
 * the one that matters most: checklist §6 says "the agent can never invent a
 * price — it only reads your published rules", and a prompt cannot enforce
 * that. This can.
 */

const grounding = (overrides: Partial<AgentTurnGrounding> = {}): AgentTurnGrounding => ({
  company: "Acme Ltd",
  locale: "en",
  currencyCode: "USD",
  tone: "warm",
  customInstructions: null,
  offLimits: [],
  allowed: [
    "price_for",
    "next_tier",
    "build_cart",
    "request_quote",
    "order_status",
    "my_terms",
    "escalate",
    "decline",
  ],
  signedIn: true,
  ...overrides,
});

const answer = (overrides: Record<string, unknown> = {}) => ({
  tool: "price_for",
  lines: [{ sku: "MUG-BL-L", quantity: 100 }],
  note: null,
  acknowledgement: "Let me look that up for you.",
  ...overrides,
});

const route = (value: unknown, g = grounding()) => readRoutedTurn(value, g);

/* -------------------------------------------------------------------------- */

describe("routing a turn", () => {
  it("reads a tool, its lines and its acknowledgement", () => {
    const result = route(answer());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.call.tool).toBe("price_for");
    expect(result.value.call.lines).toEqual([{ sku: "MUG-BL-L", quantity: 100 }]);
    expect(result.value.acknowledgement).toContain("look that up");
  });

  it("refuses a tool that does not exist", () => {
    expect(route(answer({ tool: "place_order" })).ok).toBe(false);
    expect(route(answer({ tool: "run_sql" })).ok).toBe(false);
    expect(route(answer({ tool: "" })).ok).toBe(false);
  });

  it("refuses a tool this shop has switched off", () => {
    const off = grounding({ allowed: ["price_for", "escalate", "decline"] });

    expect(route(answer({ tool: "build_cart" }), off).ok).toBe(false);
    expect(route(answer({ tool: "my_terms" }), off).ok).toBe(false);
    // Escalating and declining are always available: they are how the agent
    // says no, not things the merchant grants.
    expect(route(answer({ tool: "escalate" }), off).ok).toBe(true);
    expect(route(answer({ tool: "decline" }), off).ok).toBe(true);
  });

  it("refuses a quantity that is not a whole number of units", () => {
    for (const quantity of [0, -5, 2.5, "many", null]) {
      const result = route(answer({ lines: [{ sku: "MUG", quantity }] }));
      expect(result.ok).toBe(false);
    }
  });

  it("takes the first lines and no more", () => {
    const lines = Array.from({ length: MAX_LINES + 10 }, (_, index) => ({
      sku: `SKU-${index}`,
      quantity: 1,
    }));
    const result = route(answer({ lines }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.call.lines).toHaveLength(MAX_LINES);
  });

  it("refuses an acknowledgement that states a price", () => {
    // It has not looked anything up yet, so any figure is a guess — and the
    // buyer reads it before the real answer arrives.
    for (const acknowledgement of [
      "Your price is $4.10 — checking the rest.",
      "That'll be about 12% off, one moment.",
      "Looking that up — around 1,200.50 for the lot.",
    ]) {
      expect(route(answer({ acknowledgement })).ok).toBe(false);
    }
  });

  it("allows an acknowledgement with a quantity in it", () => {
    // "100 units" is not a price, and refusing it would make the agent unable
    // to repeat what the buyer just asked for.
    const result = route(
      answer({ acknowledgement: "Checking 100 units of MUG-BL-L for you." }),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses an empty acknowledgement, and anything that is not an object", () => {
    expect(route(answer({ acknowledgement: "  " })).ok).toBe(false);
    expect(route("not an object").ok).toBe(false);
    expect(route(null).ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("finding the money in a reply", () => {
  it("finds it in the shapes a model writes it", () => {
    expect(statedFigures("Your price is $4.10 each.")).toContain("$4.10");
    expect(statedFigures("That comes to 1,200.50 USD.")).toContain("1,200.50USD");
    expect(statedFigures("Total: EUR 90.00")).toContain("EUR90.00");
    expect(statedFigures("You'd save 12% on that.")).toContain("12%");
  });

  it("does not mistake a quantity for a price", () => {
    // The distinction the whole check depends on: a wholesale agent talks
    // about hundreds of units all day.
    expect(statedFigures("That's 100 units, 12 cases, order 500 if you like.")).toEqual(
      [],
    );
    expect(statedFigures("SKU-450 comes in boxes of 24.")).toEqual([]);
  });
});

describe("the rule the feature rests on", () => {
  const allowed = ["$4.10", "$410.00"];

  it("passes a reply that only repeats what the engine computed", () => {
    expect(
      unbackedFigures("Your price is $4.10 each, so $410.00 for 100.", allowed),
    ).toEqual([]);
  });

  it("passes a reply with no money in it at all", () => {
    expect(unbackedFigures("I'll get that priced for you.", [])).toEqual([]);
  });

  it("catches a price the tools never computed", () => {
    expect(unbackedFigures("Your price is $3.95 each.", allowed)).toEqual(["$3.95"]);
  });

  it("catches arithmetic the agent did itself", () => {
    // $4.10 × 200 is a number the engine was never asked for. It is also the
    // most plausible-looking way for this to go wrong.
    expect(unbackedFigures("For 200 that's $820.00.", allowed)).toEqual(["$820.00"]);
  });

  it("catches a discount stated as a percentage", () => {
    expect(unbackedFigures("That's 15% off list.", allowed)).toEqual(["15%"]);
  });

  it("catches a figure when nothing at all was computed", () => {
    expect(unbackedFigures("Roughly $5 a unit, I'd say.", [])).toEqual(["$5"]);
  });

  it("is not fooled by spacing or case", () => {
    expect(unbackedFigures("Your price is $4.10 each.", ["$4.10 "])).toEqual([]);
    expect(unbackedFigures("Total 90.00 usd.", ["90.00 USD"])).toEqual([]);
  });

  it("accepts a percentage the tools did compute", () => {
    expect(unbackedFigures("That unlocks the 12% tier.", ["12%"])).toEqual([]);
  });

  it("normalises the way the checker compares", () => {
    expect(normalizeFigure(" $1,200.00 ")).toBe("$1,200.00");
    expect(normalizeFigure("90.00 usd")).toBe("90.00USD");
  });
});
