import { describe, expect, it } from "vitest";

import {
  checkReply,
  fillSlots,
  inventedNumbers,
  readRoutedTurn,
  slotsUsed,
  withoutSlots,
  type AgentTurnGrounding,
} from "~/lib/ai/prompts/buyer-agent.server";
import { MAX_LINES } from "~/lib/agent/buyer/tools.server";
import { formatCurrency } from "~/lib/money";
import { money } from "@mannon/pricing-engine";

/**
 * The two guards the Buyer Agent rests on.
 *
 * `readRoutedTurn` decides whether a model answer may reach a tool at all.
 * `checkReply` decides whether a sentence may reach a buyer. The second is the
 * one that matters most, because §6 says the agent can never invent a price and
 * a prompt cannot enforce that.
 *
 * **The first version of this file tested the wrong thing.** It scanned the
 * reply for money and compared it with a list of formatted figures. An
 * independent review got five different invented prices past it — Arabic-Indic
 * digits, "900 dollars", a swapped currency symbol, a comma-decimal collision,
 * a percentage colliding with a yen amount — and found it refused the two
 * examples the spec leads with, because "NET 30" and "SKU 450" look like money
 * to a regex. So the model no longer writes numbers at all. It writes slots,
 * and these are the tests of that.
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
  buyerSaid: "",
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
      expect(route(answer({ lines: [{ sku: "MUG", quantity }] })).ok).toBe(false);
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

  it("refuses an acknowledgement that states a figure out of nowhere", () => {
    // Nothing has been looked up at this point, so any figure it writes is a
    // guess the buyer reads before the real answer arrives.
    for (const acknowledgement of [
      "Your price is $4.10 — checking the rest.",
      "That'll be about 12% off, one moment.",
      "Looking that up — around 1,200.50 for the lot.",
    ]) {
      expect(route(answer({ acknowledgement })).ok).toBe(false);
    }
  });

  it("lets the acknowledgement repeat what the buyer typed", () => {
    // The two flows §6 leads with are "SKU-450 at 100 units" and a budget.
    // Repeating what somebody said invents nothing, and the first version of
    // this check refused both.
    const said = grounding({
      buyerSaid: "what's my price for SKU-450 at 100 units?",
    });

    expect(
      route(answer({ acknowledgement: "Checking SKU-450 at 100 units for you." }), said)
        .ok,
    ).toBe(true);

    // But not a figure they did not say.
    expect(
      route(answer({ acknowledgement: "Checking SKU-450 at 250 units." }), said).ok,
    ).toBe(false);
  });

  it("finds the numbers a sentence added to what was said", () => {
    expect(inventedNumbers("SKU-450 at 100 units", "price for SKU-450 at 100")).toEqual(
      [],
    );
    expect(inventedNumbers("that's $3.95", "price for SKU-450")).toEqual(["3.95"]);
    expect(inventedNumbers("nothing numeric here", "")).toEqual([]);
  });

  it("refuses an empty acknowledgement, and anything that is not an object", () => {
    expect(route(answer({ acknowledgement: "  " })).ok).toBe(false);
    expect(route("not an object").ok).toBe(false);
    expect(route(null).ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("slots", () => {
  const slots = { f1: "$6.50", t1: "$650.00", q1: "100", s1: "MUG-BL-L" };

  it("finds the ones a reply used, and reads the rest as prose", () => {
    const reply = "Your price is {{f1}} each, so {{t1}} for {{q1}} of {{s1}}.";
    expect(slotsUsed(reply)).toEqual(["f1", "t1", "q1", "s1"]);
    expect(withoutSlots(reply)).not.toMatch(/\{\{/u);
  });

  it("fills them with what the engine computed", () => {
    expect(fillSlots("That's {{f1}} each — {{t1}} the lot.", slots)).toBe(
      "That's $6.50 each — $650.00 the lot.",
    );
  });

  it("tolerates the spacing a model might use", () => {
    expect(fillSlots("It's {{ f1 }} each.", slots)).toBe("It's $6.50 each.");
  });
});

describe("the rule the feature rests on", () => {
  const slots = { f1: "$6.50", t1: "$650.00", q1: "100" };

  it("passes a reply whose every number is a slot", () => {
    expect(checkReply("Your price is {{f1}} each — {{t1}} for {{q1}}.", slots).ok).toBe(
      true,
    );
  });

  it("passes a reply with no numbers in it at all", () => {
    expect(checkReply("I'll get that priced for you.", {}).ok).toBe(true);
  });

  it("refuses a price the model typed out", () => {
    expect(checkReply("Your price is $3.95 each.", slots).ok).toBe(false);
  });

  it("refuses arithmetic the model did itself", () => {
    // The most plausible way for this to go wrong: the figures are right and
    // the sum is the model's.
    expect(checkReply("{{f1}} each, so $820.00 for 200.", slots).ok).toBe(false);
  });

  it("refuses a slot it was never given", () => {
    const checked = checkReply("That's {{f9}} each.", slots);
    expect(checked.ok).toBe(false);
    expect(checked.error).toContain("f9");
  });

  it("refuses a number in any script, not just this one", () => {
    // `\\d` is ASCII-only in JavaScript even under /u, which is how an entire
    // language got past the first version of this check.
    for (const reply of [
      "سعرك ٦٫٥٠ للوحدة.", // Arabic-Indic
      "Your price is ６.５０ each.", // fullwidth
      "قيمتها ۹۰٫۰۰.", // Eastern Arabic-Indic
    ]) {
      expect(checkReply(reply, slots).ok).toBe(false);
    }
  });

  it("refuses a price written in words", () => {
    // No digit at all, and still a quote the merchant would have to honour.
    for (const reply of [
      "That's nine hundred dollars.",
      "About nine hundred USD.",
      "Fifteen percent off for you.",
      "سعرها تسعمئة ريال.",
    ]) {
      expect(checkReply(reply, slots).ok).toBe(false);
    }
  });

  it("refuses a currency word even beside a correct slot", () => {
    // "{{f1}} dollars" invites the model to convert, and a swapped currency
    // with the right number was one of the ways past the old check.
    expect(checkReply("That's {{f1}} dollars.", slots).ok).toBe(false);
    expect(checkReply("That's {{f1}} euros.", slots).ok).toBe(false);
    expect(checkReply("{{f1}}، أي ما يعادل بالريال.", slots).ok).toBe(false);
  });

  it("keeps the two sentences §6 leads with sayable", () => {
    // "NET 30" and "SKU 450" both looked like money to the old regex, which
    // made the terms answer and the flagship price question unusable.
    const terms = { days: "30", owed: "$1,000.00" };
    expect(
      checkReply("You're on net {{days}} days, with {{owed}} outstanding.", terms).ok,
    ).toBe(true);

    const priced = { s1: "SKU-450", q1: "100", f1: "$4.10" };
    expect(checkReply("{{s1}} at {{q1}} units is {{f1}} each.", priced).ok).toBe(true);
  });
});

/**
 * The locales this app actually formats money in.
 *
 * Every one of these is a shape the old scanner was blind to or tripped over.
 * The check now reads "is there a digit outside a slot", which is true in every
 * script — so the assertion is the same in all of them, in both directions.
 */
describe("across the locales this app formats in", () => {
  const CASES: { locale: string; currency: string; minor: number }[] = [
    { locale: "en", currency: "USD", minor: 650 },
    { locale: "ar", currency: "SAR", minor: 650 },
    { locale: "ar-EG", currency: "EGP", minor: 9000 },
    { locale: "ja", currency: "JPY", minor: 900 },
    { locale: "fr", currency: "EUR", minor: 120050 },
    { locale: "de", currency: "EUR", minor: 120050 },
    { locale: "ar-KW", currency: "KWD", minor: 9000 },
    { locale: "ar-BH", currency: "BHD", minor: 9000 },
  ];

  for (const { locale, currency, minor } of CASES) {
    it(`substitutes and guards in ${locale}/${currency}`, () => {
      const formatted = formatCurrency(money(minor, currency), locale);
      const slots = { f1: formatted };

      // The right answer goes through untouched, whatever the digits look like.
      const filled = fillSlots("{{f1}}", slots);
      expect(checkReply("{{f1}}", slots).ok).toBe(true);
      expect(filled).toBe(formatted);

      // And the model writing that same figure out by hand does not, because
      // it is a digit outside a slot.
      expect(checkReply(formatted, slots).ok).toBe(false);
    });
  }
});
