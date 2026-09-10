import type { AgentGuardrails } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { outstanding, storefrontUrl } from "~/lib/agent/buyer/publish.server";
import type { PublishReadiness } from "~/lib/agent/buyer/publish.server";
import { cartLines } from "~/lib/agent/buyer/rehearsal.server";
import { guardrailsView, toolFacts } from "~/lib/agent/buyer/view-model.server";
import type { PricedToolLine } from "~/lib/agent/buyer/tools.server";
import { money } from "@mannon/pricing-engine";

/**
 * The decisions the three Buyer Agent screens make.
 *
 * Pure, so they are testable in an environment where the embedded admin cannot
 * be driven at all — which is the whole reason they live in a module rather
 * than in a loader.
 */

const guardrails = (overrides: Partial<AgentGuardrails> = {}): AgentGuardrails =>
  ({
    shop: "alpha.myshopify.com",
    published: false,
    publishedAt: null,
    canBuildCart: true,
    canRequestQuote: true,
    canReadOrders: true,
    canReadTerms: true,
    guestMode: false,
    tone: "warm",
    customInstructions: null,
    offLimits: [],
    reviewedAt: null,
    updatedAt: new Date("2026-09-10T12:00:00Z"),
    updatedBy: null,
    ...overrides,
  }) as AgentGuardrails;

const readiness = (overrides: Partial<PublishReadiness> = {}): PublishReadiness => ({
  items: [
    { step: "rule", done: true, href: "/app/pricing/new" },
    { step: "buyer", done: true, href: "/app/customers/applications" },
    { step: "reviewed", done: true, href: "/app/storefront-agent" },
    { step: "test", done: true, href: "/app/storefront-agent/test" },
  ],
  ready: true,
  published: false,
  publishedAt: null,
  storefrontUrl: "https://acme.example/account",
  embed: { live: true, attested: false },
  ...overrides,
});

const view = (
  g: Partial<AgentGuardrails> = {},
  r: Partial<PublishReadiness> = {},
  options: Parameters<typeof guardrailsView>[2] = {
    entitled: true,
    requiredPlan: null,
  },
) => guardrailsView(guardrails(g), readiness(r), options);

/* -------------------------------------------------------------------------- */

describe("the publish checklist", () => {
  it("names what is outstanding, in the order the screen lists it", () => {
    expect(
      outstanding(
        readiness({
          items: [
            { step: "rule", done: false, href: "" },
            { step: "buyer", done: true, href: "" },
            { step: "reviewed", done: false, href: "" },
            { step: "test", done: true, href: "" },
          ],
        }),
      ),
    ).toEqual(["rule", "reviewed"]);
  });

  it("prefers the merchant's own domain over the myshopify one", () => {
    expect(storefrontUrl("acme.example", "acme.myshopify.com")).toBe(
      "https://acme.example/account",
    );
    expect(storefrontUrl(null, "acme.myshopify.com")).toBe(
      "https://acme.myshopify.com/account",
    );
  });
});

describe("the guardrails panel", () => {
  it("lists every ability with the state the merchant left it in", () => {
    const panel = view({ canRequestQuote: false, canReadTerms: false });

    expect(panel.abilities).toEqual([
      { key: "canBuildCart", on: true },
      { key: "canRequestQuote", on: false },
      { key: "canReadOrders", on: true },
      { key: "canReadTerms", on: false },
    ]);
  });

  it("counts the words, so the merchant sees the cap approaching", () => {
    const panel = view({ customInstructions: "Always mention our free delivery." });
    expect(panel.words).toBe(5);
    expect(panel.maxWords).toBe(200);
  });

  it("lints on every read, not only on save", () => {
    // A merchant who switches quoting off *after* writing their instructions
    // has just created the contradiction, and never touches the box again.
    const panel = view({
      canRequestQuote: false,
      customInstructions: "If they ask for a quote, offer discounts freely.",
    });

    expect(panel.warnings.map((warning) => warning.key)).toEqual([
      "agent.lint.discountAuthority",
      "agent.lint.quote",
    ]);
    expect(panel.warnings[0]?.phrase).toContain("discounts");
  });

  it("says the guardrails are unreviewed until somebody says otherwise", () => {
    expect(view().reviewed).toBe(false);
    expect(view({ reviewedAt: new Date() }).reviewed).toBe(true);
  });

  it("carries the refusal through, so a blocked publish says which item", () => {
    const panel = guardrailsView(guardrails(), readiness({ ready: false }), {
      entitled: true,
      requiredPlan: null,
      refused: ["test"],
    });

    expect(panel.publish.ready).toBe(false);
    expect(panel.publish.refused).toEqual(["test"]);
  });
});

describe("reading a stored turn back", () => {
  it("reads the tool and its facts", () => {
    expect(toolFacts({ tool: "price_for", facts: ["sku: MUG"] })).toEqual({
      tool: "price_for",
      facts: ["sku: MUG"],
    });
  });

  it("names a SKU the catalogue did not have", () => {
    // Listed, never quietly dropped — the same rule the buyer's own answer
    // follows, applied to the merchant reading it back.
    expect(toolFacts({ tool: "build_cart", unknownSkus: ["NOPE"] }).facts).toEqual([
      "unknown_sku: NOPE",
    ]);
  });

  it("renders what it can from a row it does not recognise", () => {
    // JSON we wrote, but still JSON read from a column: a row from an older
    // version must not throw on the one screen that exists to be readable.
    for (const value of [null, "a string", 7, [], { facts: "not a list" }]) {
      expect(toolFacts(value)).toEqual({ tool: null, facts: [] });
    }
    expect(toolFacts({ tool: 9, facts: ["kept", 3] })).toEqual({
      tool: null,
      facts: ["kept"],
    });
    // A tool name this version does not know renders as no tool, never as a
    // raw `agent.tool.<name>` catalogue key on the merchant's screen.
    expect(toolFacts({ tool: "teleport", facts: [] }).tool).toBeNull();
  });
});

describe("the rehearsal's cart card", () => {
  const line = (overrides: Partial<PricedToolLine> = {}): PricedToolLine => ({
    sku: "MUG-BL-L",
    title: "Blue Mug — Large",
    variantId: "gid://shopify/ProductVariant/1",
    productId: "gid://shopify/Product/1",
    quantity: 100,
    unitPrice: "$6.50",
    lineTotal: "$650.00",
    unitPriceAmount: 650,
    listPrice: money(1000, "USD"),
    ruleSummary: "Wholesale 35%",
    ...overrides,
  });

  it("is nothing at all when no cart was built", () => {
    expect(cartLines(null)).toBeNull();
  });

  it("carries the rule that set each price", () => {
    const cart = cartLines({ lines: [line()], subtotal: "$650.00" });

    expect(cart?.subtotal).toBe("$650.00");
    // Deciding shows its working — for the merchant checking their own rules
    // from the outside, which is what a rehearsal is for.
    expect(cart?.lines[0]?.rule).toBe("Wholesale 35%");
    expect(cart?.lines[0]?.unitPrice).toBe("$6.50");
  });

  it("reads a missing SKU as none rather than an empty string", () => {
    expect(
      cartLines({ lines: [line({ sku: "" })], subtotal: "$1.00" })?.lines[0]?.sku,
    ).toBeNull();
  });
});
