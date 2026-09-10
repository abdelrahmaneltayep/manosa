import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { ConversationLogPage } from "~/components/agent/ConversationLogPage";
import { GuardrailsPage } from "~/components/agent/GuardrailsPage";
import { TestPage } from "~/components/agent/TestPage";
import { TranscriptPage } from "~/components/agent/TranscriptPage";
import type {
  GuardrailsView,
  LogView,
  TestView,
  TranscriptView,
} from "~/components/agent/types";
import type { Locale } from "~/i18n/config";
import { createCaptureHarness, type CaptureHarness } from "../support/state-capture";

/**
 * The three screens 5.3 adds, in every state they have.
 *
 * Structure only — Polaris never upgrades in this environment, so these prove
 * which content renders in which state and that no raw i18n key reached the
 * page. They do not prove what a merchant sees; `qa/5.3/REPORT.md` says so
 * rather than implying otherwise.
 */

const OUT = resolve(process.cwd(), "qa/5.3");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Buyer Agent guardrails, test mode and conversations",
    outFor: () => OUT,
    dirs: [OUT],
  });
});

/* -------------------------------------------------------------------------- */

const guardrails = (overrides: Partial<GuardrailsView> = {}): GuardrailsView => ({
  entitled: true,
  requiredPlan: null,
  publish: {
    items: [
      { step: "rule", done: true, href: "/app/pricing/new" },
      { step: "buyer", done: true, href: "/app/customers/applications" },
      { step: "reviewed", done: false, href: "/app/storefront-agent" },
      { step: "test", done: false, href: "/app/storefront-agent/test" },
    ],
    ready: false,
    published: false,
    embedLive: true,
    embedAttested: false,
    storefrontUrl: "https://acme.example/account",
    justPublished: false,
    refused: [],
  },
  abilities: [
    { key: "canBuildCart", on: true },
    { key: "canRequestQuote", on: true },
    { key: "canReadOrders", on: true },
    { key: "canReadTerms", on: true },
  ],
  guestMode: false,
  tone: "warm",
  tones: ["warm", "plain", "brief"],
  customInstructions: "",
  words: 0,
  maxWords: 200,
  warnings: [],
  offLimits: [],
  reviewed: false,
  saved: false,
  error: null,
  ...overrides,
});

const ready = (overrides: Partial<GuardrailsView["publish"]> = {}) => ({
  items: [
    { step: "rule", done: true, href: "/app/pricing/new" },
    { step: "buyer", done: true, href: "/app/customers/applications" },
    { step: "reviewed", done: true, href: "/app/storefront-agent" },
    { step: "test", done: true, href: "/app/storefront-agent/test" },
  ],
  ready: true,
  published: false,
  embedLive: true,
  embedAttested: false,
  storefrontUrl: "https://acme.example/account",
  justPublished: false,
  refused: [],
  ...overrides,
});

describe("the guardrails panel", () => {
  it("lists what is still outstanding before publishing", () => {
    const html = render(<GuardrailsPage view={guardrails()} />);

    expect(html).toContain("Guardrails reviewed");
    expect(html).toContain("A test conversation completed");
    expect(html).toContain("Finish the list above");
    // The gate is real: the button is off until the list is done.
    expect(html).toContain("disabled");
    capture("01-guardrails-not-ready", html);
  });

  it("turns the publish button on when all four are done", () => {
    const html = render(<GuardrailsPage view={guardrails({ publish: ready() })} />);

    expect(html).toContain("Publish to the storefront");
    expect(html).not.toContain("Finish the list above");
    capture("02-guardrails-ready", html);
  });

  it("confirms after publishing, with a link to the storefront", () => {
    const html = render(
      <GuardrailsPage
        view={guardrails({
          publish: ready({ published: true, justPublished: true }),
          reviewed: true,
        })}
      />,
    );

    expect(html).toContain("Published — the agent is live");
    expect(html).toContain("https://acme.example/account");
    // One click, no dialog.
    expect(html).toContain("Unpublish");
    capture("03-guardrails-published", html);
  });

  it("does not claim the agent is live when the app embed may be off", () => {
    // Our switch is on; the theme app embed is the merchant's, and this app
    // has no scope to read a theme. Saying "live" anyway is a claim about
    // somebody else's theme.
    const html = render(
      <GuardrailsPage
        view={guardrails({
          publish: ready({ published: true, embedLive: false, embedAttested: false }),
          reviewed: true,
        })}
      />,
    );

    expect(html).toContain("we haven&#x27;t seen your storefront call us yet");
    expect(html).toContain("App embeds");
    expect(html).not.toContain("Approved buyers who are signed in can chat");
    capture("09-guardrails-embed-unknown", html);
  });

  it("says what is outstanding when a publish was refused", () => {
    const html = render(
      <GuardrailsPage
        view={guardrails({ publish: { ...ready(), ready: false, refused: ["test"] } })}
      />,
    );

    expect(html).toContain("Not published");
    expect(html).toContain("Nothing has changed on your storefront");
    capture("04-guardrails-refused", html);
  });

  it("warns about instructions that ask for something the agent will not do", () => {
    const html = render(
      <GuardrailsPage
        view={guardrails({
          customInstructions: "Offer discounts freely and negotiate on big orders.",
          words: 8,
          abilities: [
            { key: "canBuildCart", on: true },
            { key: "canRequestQuote", on: false },
            { key: "canReadOrders", on: true },
            { key: "canReadTerms", on: false },
          ],
          warnings: [
            { key: "agent.lint.discountAuthority", phrase: "Offer discounts" },
            { key: "agent.lint.quote", phrase: "quote" },
          ],
        })}
      />,
    );

    expect(html).toContain("asks for something the agent won&#x27;t do");
    expect(html).toContain("It never can");
    expect(html).toContain("8 words of 200");
    capture("05-guardrails-lint", html);
  });

  it("puts the error beside the field it belongs to", () => {
    const html = render(
      <GuardrailsPage
        view={guardrails({
          words: 240,
          error: { field: "customInstructions", code: "too_long" },
        })}
      />,
    );

    expect(html).toContain("over 200 words");
    capture("06-guardrails-too-long", html);
  });

  it("says which plan the agent needs, and keeps the guardrails visible", () => {
    const html = render(
      <GuardrailsPage view={guardrails({ entitled: false, requiredPlan: "agentic" })} />,
    );

    expect(html).toContain("needs a different plan");
    expect(html).toContain("kept exactly as they are");
    capture("07-guardrails-plan-locked", html);
  });

  it("reads right to left in Arabic", () => {
    const html = render(<GuardrailsPage view={guardrails()} />, "ar");
    expect(html).toContain("الضوابط");
    capture("08-guardrails-arabic", html, "ar");
  });
});

/* -------------------------------------------------------------------------- */

const test = (overrides: Partial<TestView> = {}): TestView => ({
  entitled: true,
  requiredPlan: null,
  buyers: [
    { customerId: "gid://shopify/Customer/1", name: "Café Aroma" },
    { customerId: "gid://shopify/Customer/2", name: "Bean There Ltd" },
  ],
  buyerId: "gid://shopify/Customer/1",
  buyerNotFound: false,
  search: "",
  turns: [],
  cart: null,
  failure: null,
  noKey: false,
  completed: false,
  ...overrides,
});

describe("test mode", () => {
  it("is watermarked before anything is typed", () => {
    const html = render(<TestPage view={test()} />);

    expect(html).toContain("TEST — no orders created");
    expect(html).toContain("Nothing here writes");
    capture("10-test-empty", html);
  });

  it("shows the cart it would have built, and that it built nothing", () => {
    const html = render(
      <TestPage
        view={test({
          turns: [
            {
              role: "BUYER",
              text: "100 of MUG-BL-L please",
              refusal: null,
              refusalLabel: "",
              tool: null,
            },
            {
              role: "AGENT",
              text: "MUG-BL-L at 100 units is $6.50 each — $650.00 the lot.",
              refusal: null,
              refusalLabel: "",
              tool: "build_cart",
            },
          ],
          cart: {
            lines: [
              {
                title: "Blue Mug — Large",
                sku: "MUG-BL-L",
                quantity: 100,
                unitPrice: "$6.50",
                lineTotal: "$650.00",
                rule: "Wholesale 35%",
              },
            ],
            subtotal: "$650.00",
          },
          completed: true,
        })}
      />,
    );

    expect(html).toContain("$650.00");
    expect(html).toContain("Wholesale 35%");
    expect(html).toContain("Nothing was added to anyone&#x27;s basket");
    capture("11-test-cart", html);
  });

  it("says a rehearsal filed nothing when the agent would have quoted", () => {
    const html = render(
      <TestPage
        view={test({
          turns: [
            {
              role: "BUYER",
              text: "can you do better on 500?",
              refusal: null,
              refusalLabel: "",
              tool: null,
            },
            {
              role: "AGENT",
              text: "I'd normally pass that to the team to price.",
              refusal: "test_mode",
              refusalLabel: "A rehearsal, so nothing was filed.",
              tool: "request_quote",
            },
          ],
        })}
      />,
    );

    // The merchant reads a sentence, not the code we store.
    expect(html).toContain("A rehearsal, so nothing was filed.");
    capture("12-test-no-write", html);
  });

  it("says why it could not answer", () => {
    const html = render(<TestPage view={test({ failure: "timeout" })} />);

    expect(html).toContain("took too long");
    capture("13-test-failure", html);
  });

  it("says Claude is not connected rather than blaming the merchant", () => {
    const html = render(<TestPage view={test({ noKey: true })} />);

    expect(html).toContain("Claude isn&#x27;t connected");
    expect(html).toContain("Everything else on this page works");
    capture("14-test-no-key", html);
  });

  it("never answers as a different buyer than the one asked for", () => {
    const html = render(
      <TestPage view={test({ buyerId: null, buyerNotFound: true, search: "aroma" })} />,
    );

    expect(html).toContain("isn&#x27;t one you can rehearse as");
    capture("16-test-buyer-not-found", html);
  });

  it("asks for an approved buyer first when there are none", () => {
    const html = render(<TestPage view={test({ buyers: [], buyerId: null })} />);

    expect(html).toContain("No approved buyers yet");
    expect(html).toContain("/app/customers/applications");
    capture("15-test-no-buyers", html);
  });
});

/* -------------------------------------------------------------------------- */

const log = (overrides: Partial<LogView> = {}): LogView => ({
  rows: [
    {
      id: "c1",
      buyer: "Café Aroma",
      when: "2 hours ago",
      at: "2026-09-10T10:00:00.000Z",
      outcome: "CART",
      turns: 6,
      testMode: false,
      takenOver: false,
    },
    {
      id: "c2",
      buyer: "Bean There Ltd",
      when: "yesterday",
      at: "2026-09-09T10:00:00.000Z",
      outcome: "ESCALATED",
      turns: 3,
      testMode: false,
      takenOver: true,
    },
    {
      id: "c3",
      buyer: "Café Aroma",
      when: "3 days ago",
      at: "2026-09-07T10:00:00.000Z",
      outcome: "ANSWERED",
      turns: 2,
      testMode: true,
      takenOver: false,
    },
  ],
  page: 1,
  pageCount: 3,
  total: 47,
  neverAny: false,
  published: true,
  filters: { outcome: "", search: "" },
  outcomes: ["CART", "QUOTE", "ANSWERED", "ESCALATED", "DECLINED", "FAILED"],
  entitled: true,
  requiredPlan: null,
  retentionDays: 90,
  ...overrides,
});

describe("the conversation log", () => {
  it("chips each outcome, marks rehearsals, and says how long it keeps them", () => {
    const html = render(<ConversationLogPage view={log()} />);

    expect(html).toContain("Cart built");
    expect(html).toContain("Escalated");
    expect(html).toContain("You joined");
    expect(html).toContain("kept for 90 days");
    expect(html).toContain("Export CSV");
    expect(html).toContain("Page 1 of 3");
    capture("20-log-list", html);
  });

  it("says to publish the agent when there has never been a conversation", () => {
    const html = render(
      <ConversationLogPage view={log({ rows: [], neverAny: true, published: false })} />,
    );

    expect(html).toContain("No conversations yet — publish the agent to start");
    capture("21-log-empty", html);
  });

  it("says it is live and waiting when it is published but quiet", () => {
    const html = render(
      <ConversationLogPage view={log({ rows: [], neverAny: true, published: true })} />,
    );

    expect(html).toContain("The agent is live");
    expect(html).not.toContain("publish the agent to start");
    capture("22-log-empty-published", html);
  });

  it("separates nothing here from nothing matched", () => {
    const html = render(
      <ConversationLogPage
        view={log({ rows: [], filters: { outcome: "CART", search: "nobody" } })}
      />,
    );

    expect(html).toContain("No conversations match");
    expect(html).toContain("Clear filters");
    capture("23-log-no-results", html);
  });

  it("says which plan it needs and still shows what is there", () => {
    const html = render(
      <ConversationLogPage view={log({ entitled: false, requiredPlan: "agentic" })} />,
    );

    expect(html).toContain("needs a different plan");
    expect(html).toContain("Café Aroma");
    capture("24-log-plan-locked", html);
  });
});

/* -------------------------------------------------------------------------- */

const transcript = (overrides: Partial<TranscriptView> = {}): TranscriptView => ({
  id: "c1",
  buyer: "Café Aroma",
  startedAt: "2 hours ago",
  outcome: "CART",
  testMode: false,
  takenOver: false,
  takenOverWhen: null,
  turns: [
    {
      id: "m1",
      role: "BUYER",
      text: "what's my price for SKU-450 at 100 units?",
      when: "2 hours ago",
      at: "2026-09-10T10:00:00.000Z",
      refusal: null,
      refusalLabel: "",
      joined: false,
      tool: null,
      facts: [],
    },
    {
      id: "m2",
      role: "AGENT",
      text: "SKU-450 at 100 units is $4.10 each — $410.00 the lot.",
      when: "2 hours ago",
      at: "2026-09-10T10:00:05.000Z",
      refusal: null,
      refusalLabel: "",
      joined: false,
      tool: "price_for",
      facts: ["rule: Wholesale 35%"],
    },
  ],
  sent: false,
  tooLong: false,
  maxReplyChars: 2000,
  entitled: true,
  ...overrides,
});

describe("one transcript", () => {
  it("shows what the buyer read and what the agent was doing", () => {
    const html = render(<TranscriptPage view={transcript()} />);

    expect(html).toContain("Conversation with Café Aroma");
    expect(html).toContain("Looked up a price");
    expect(html).toContain("rule: Wholesale 35%");
    expect(html).toContain("Take over this conversation");
    capture("30-transcript", html);
  });

  it("shows a turn nobody could answer as exactly that", () => {
    const html = render(
      <TranscriptPage
        view={transcript({
          outcome: "FAILED",
          turns: [
            {
              id: "m1",
              role: "AGENT",
              text: "",
              when: "5 minutes ago",
              at: "2026-09-10T11:55:00.000Z",
              refusal: "timeout",
              refusalLabel: "Claude took too long to answer.",
              joined: false,
              tool: "price_for",
              facts: [],
            },
          ],
        })}
      />,
    );

    // Invariant 4, on the screen a merchant uses to decide whether to trust
    // this thing at all.
    expect(html).toContain("Nothing was sent to the buyer");
    // The reason is a sentence, not the enum we store it as.
    expect(html).toContain("Why: Claude took too long to answer.");
    capture("31-transcript-failed", html);
  });

  /**
   * Built from the rows `takeOver` and `replyAsMerchant` actually write.
   *
   * The first version of this capture flipped `takenOver: true` on the
   * happy-path fixture, so the announcement row and the merchant's own turn
   * had never been rendered at all — and the announcement, stored with empty
   * text, read as "the agent couldn't answer this one" on the one screen
   * invariant 4 was written for. A fixture that does not match what the
   * writer writes is a test that cannot fail.
   */
  it("says a person joined, and shows the merchant's own reply", () => {
    const html = render(
      <TranscriptPage
        view={transcript({
          outcome: "ESCALATED",
          takenOver: true,
          takenOverWhen: "an hour ago",
          sent: true,
          turns: [
            {
              id: "m1",
              role: "BUYER",
              text: "can you do better on 500?",
              when: "2 hours ago",
              at: "2026-09-10T10:00:00.000Z",
              refusal: null,
              refusalLabel: "",
              joined: false,
              tool: null,
              facts: [],
            },
            // Exactly what `takeOver` writes.
            {
              id: "m2",
              role: "AGENT",
              text: "A person joined this conversation.",
              when: "an hour ago",
              at: "2026-09-10T11:00:00.000Z",
              refusal: "taken_over",
              refusalLabel: "You joined this conversation.",
              joined: true,
              tool: null,
              facts: [],
            },
            // Exactly what `replyAsMerchant` writes.
            {
              id: "m3",
              role: "MERCHANT",
              text: "Yes — 12% on 500 units.",
              when: "55 minutes ago",
              at: "2026-09-10T11:05:00.000Z",
              refusal: null,
              refusalLabel: "",
              joined: false,
              tool: null,
              facts: [],
            },
          ],
        })}
      />,
    );

    expect(html).toContain("A person joined this conversation. The agent stopped");
    // Never as a failure.
    expect(html).not.toContain("Nothing was sent to the buyer");
    expect(html).toContain("Yes — 12% on 500 units.");
    expect(html).toContain("You took this conversation over an hour ago");
    expect(html).not.toContain("Take over this conversation");
    expect(html).toContain("Sent");
    capture("32-transcript-taken-over", html);
  });

  it("puts the too-long error beside the reply box, and sends nothing", () => {
    const html = render(<TranscriptPage view={transcript({ tooLong: true })} />);

    expect(html).toContain("over 2000 characters, so nothing was sent");
    capture("35-transcript-reply-too-long", html);
  });

  it("marks a rehearsal, and offers nobody to take over from", () => {
    const html = render(<TranscriptPage view={transcript({ testMode: true })} />);

    expect(html).toContain("TEST — no orders created");
    expect(html).toContain("There&#x27;s nobody to take over from");
    capture("33-transcript-test", html);
  });

  it("reads right to left in Arabic", () => {
    const html = render(<TranscriptPage view={transcript()} />, "ar");
    expect(html).toContain("محادثة مع");
    capture("34-transcript-arabic", html, "ar");
  });
});
