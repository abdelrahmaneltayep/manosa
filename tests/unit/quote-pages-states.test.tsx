import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { PublicQuote, type PublicQuoteView } from "~/components/orders/PublicQuote";
import { QuoteDetailPage } from "~/components/orders/QuoteDetailPage";
import { QuoteListPage } from "~/components/orders/QuoteListPage";
import type {
  QuoteDetailView,
  QuoteLineView,
  QuoteListView,
  QuoteRowView,
} from "~/components/orders/types";
import type { Locale } from "~/i18n/config";
import {
  createCaptureHarness,
  REAL_NOTE,
  type CaptureHarness,
} from "../support/state-capture";

/**
 * Every state in the checklist's "Draft orders & quotes" block.
 *
 * The two admin screens are structure-only captures, like the rest of the
 * admin. The buyer's page is the exception — it is our own page on our own
 * domain, so its capture is the real thing and says so.
 */

const OUT = resolve(process.cwd(), "qa/3.3");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en", note?: string) =>
  harness.capture(name, html, locale, note);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Quotes",
    outFor: () => OUT,
    dirs: [OUT],
  });
});

/* -------------------------------------------------------------------------- */

const row = (overrides: Partial<QuoteRowView> = {}): QuoteRowView => ({
  id: "q1",
  number: "Q-1001",
  buyer: "Acme Ltd",
  buyerHref: "/app/customers/c1",
  status: "SENT",
  statusLabel: "Sent",
  statusTone: "info",
  total: "$650.00",
  lineCount: 1,
  expiryLabel: "Expires in 9 days",
  source: "MERCHANT",
  createdAt: "2026-09-10T12:00:00.000Z",
  ...overrides,
});

const listView = (overrides: Partial<QuoteListView> = {}): QuoteListView => ({
  rows: [row()],
  total: 1,
  totalUnfiltered: 1,
  page: 1,
  pageCount: 1,
  filters: { search: "", status: "" },
  entitled: true,
  requiredPlan: "growth",
  ...overrides,
});

describe("the quote list", () => {
  it("empty: explains what a quote is for and how the price behaves", () => {
    const html = render(
      <QuoteListPage view={listView({ rows: [], total: 0, totalUnfiltered: 0 })} />,
    );

    expect(html).toContain("No quotes yet");
    expect(html).toContain("Prices are fixed the moment you draft it");
    expect(html).not.toContain("<s-table");
    capture("quotes-empty", html);
  });

  it("rows: every state, with the agent chip on an agent's request", () => {
    const html = render(
      <QuoteListPage
        view={listView({
          rows: [
            row({
              id: "a",
              number: "Q-1001",
              status: "NEW",
              statusLabel: "New request",
              statusTone: "warning",
              total: "",
              lineCount: 0,
              expiryLabel: null,
              source: "BUYER_AGENT",
            }),
            row({
              id: "b",
              number: "Q-1002",
              status: "DRAFTED",
              statusLabel: "Drafted",
              statusTone: "neutral",
              expiryLabel: null,
            }),
            row({ id: "c", number: "Q-1003" }),
            row({
              id: "d",
              number: "Q-1004",
              status: "ACCEPTED",
              statusLabel: "Accepted",
              statusTone: "success",
              expiryLabel: null,
            }),
            row({
              id: "e",
              number: "Q-1005",
              status: "EXPIRED",
              statusLabel: "Expired",
              statusTone: "critical",
              expiryLabel: "Expired 2 days ago",
            }),
          ],
          total: 5,
          totalUnfiltered: 5,
        })}
      />,
    );

    expect(html).toContain("New request");
    expect(html).toContain("✦");
    expect(html).toContain("Expired 2 days ago");
    // A request nobody has priced has no total — "$0.00" would read as free.
    expect(html).toContain("Not priced yet");
    capture("quotes-rows", html);
  });

  it("gated: quotes already sent still stand", () => {
    const html = render(<QuoteListPage view={listView({ entitled: false })} />);

    expect(html).toContain("paid plan");
    expect(html).toContain("their links still work");
    expect(html).not.toContain('disabled="false"');
    capture("quotes-gated", html);
  });

  it("filtered to nothing tells that apart from having none", () => {
    const html = render(
      <QuoteListPage
        view={listView({
          rows: [],
          total: 0,
          totalUnfiltered: 12,
          filters: { search: "", status: "EXPIRED" },
        })}
      />,
    );

    expect(html).toContain("No quotes match these filters");
    expect(html).not.toContain("No quotes yet");
    capture("quotes-no-results", html);
  });

  it("renders in Arabic, right to left", () => {
    const html = render(<QuoteListPage view={listView()} />, "ar");
    expect(html).toContain("عروض الأسعار");
    expect(html).not.toContain("Quotes");
    capture("quotes-rows-ar", html, "ar");
  });
});

/* -------------------------------------------------------------------------- */

const detailLine = (overrides: Partial<QuoteLineView> = {}): QuoteLineView => ({
  id: "l1",
  variantId: "gid://shopify/ProductVariant/1",
  title: "Blue Mug — Large",
  sku: "MUG-BL-L",
  quantity: 100,
  unitPrice: "$6.50",
  unitPriceRaw: "6.50",
  listPrice: "$10.00",
  lineTotal: "$650.00",
  ruleSummary: "Wholesale 35%",
  currentPrice: null,
  ...overrides,
});

const detailView = (overrides: Partial<QuoteDetailView> = {}): QuoteDetailView => ({
  id: "q1",
  number: "Q-1001",
  status: "DRAFTED",
  statusLabel: "Drafted",
  statusTone: "neutral",
  source: "MERCHANT",
  buyer: {
    name: "Acme Ltd",
    email: "buyer@acme.test",
    href: "/app/customers/c1",
    context: "Gold · 4 orders, $1,200.50 lifetime",
  },
  requestNote: null,
  message: "",
  internalNote: "",
  lines: [detailLine()],
  subtotal: "$650.00",
  currencyCode: "USD",
  expiryLabel: null,
  lockedLabel:
    "Prices fixed on 2026-09-10. They do not change unless you re-price this quote.",
  publicUrl: null,
  draftOrder: null,
  actions: { draft: true, send: true, withdraw: true, reopen: false },
  hasDrift: false,
  aiAvailable: false,
  entitled: true,
  requiredPlan: "growth",
  error: null,
  search: { query: "", results: [], searched: false },
  ...overrides,
});

describe("one quote", () => {
  it("new request: the buyer's words, their tier, and nothing priced", () => {
    const html = render(
      <QuoteDetailPage
        view={detailView({
          status: "NEW",
          statusLabel: "New request",
          statusTone: "warning",
          source: "BUYER_AGENT",
          requestNote: "Can you do 100 of the blue ones?",
          lines: [],
          subtotal: "$0.00",
          lockedLabel: null,
        })}
      />,
    );

    expect(html).toContain("Can you do 100 of the blue ones?");
    // Buyer context, so a merchant is not guessing who they are pricing for.
    expect(html).toContain("Gold · 4 orders, $1,200.50 lifetime");
    expect(html).toContain("Nothing on this quote yet");
    expect(html).toContain("✦");
    capture("quote-new", html);
  });

  it("drafted: the rule behind each price, and when it was fixed", () => {
    const html = render(<QuoteDetailPage view={detailView()} />);

    expect(html).toContain("Wholesale 35%");
    expect(html).toContain("Prices fixed on 2026-09-10");
    expect(html).toContain("$650.00");
    capture("quote-drafted", html);
  });

  it("a hand-typed price says so rather than claiming a rule", () => {
    const html = render(
      <QuoteDetailPage
        view={detailView({
          lines: [detailLine({ ruleSummary: null, unitPrice: "$6.00" })],
        })}
      />,
    );

    expect(html).toContain("Priced by hand");
    capture("quote-manual-price", html);
  });

  it("the locked-price chip appears when the store would now charge differently", () => {
    const html = render(
      <QuoteDetailPage
        view={detailView({
          status: "SENT",
          statusLabel: "Sent",
          statusTone: "info",
          expiryLabel: "Expires in 9 days",
          hasDrift: true,
          publicUrl: "https://mannon.test/q/abc123",
          actions: { draft: false, send: false, withdraw: true, reopen: false },
          lines: [detailLine({ currentPrice: "$9.00" })],
        })}
      />,
    );

    expect(html).toContain("Now $9.00 in the store");
    expect(html).toContain("rules have changed since this was priced");
    // And it says the price will not move, which is the point.
    expect(html).toContain("they will be charged");
    // A sent quote cannot be re-priced behind the buyer's back, and says why.
    expect(html).toContain("cannot be changed");
    capture("quote-locked-price", html);
  });

  it("sent: the buyer's link, with a warning about who can use it", () => {
    const html = render(
      <QuoteDetailPage
        view={detailView({
          status: "SENT",
          statusLabel: "Sent",
          statusTone: "info",
          expiryLabel: "Expires in 9 days",
          publicUrl: "https://mannon.test/q/abc123",
          actions: { draft: false, send: false, withdraw: true, reopen: false },
        })}
      />,
    );

    expect(html).toContain("https://mannon.test/q/abc123");
    expect(html).toContain("Anyone with it can accept");
    capture("quote-sent", html);
  });

  it("accepted: links to the draft order it became", () => {
    const html = render(
      <QuoteDetailPage
        view={detailView({
          status: "ACCEPTED",
          statusLabel: "Accepted",
          statusTone: "success",
          draftOrder: {
            name: "#D12",
            href: "https://alpha.myshopify.com/admin/draft_orders/900",
          },
          actions: { draft: false, send: false, withdraw: false, reopen: false },
        })}
      />,
    );

    expect(html).toContain("#D12");
    expect(html).toContain("at the prices quoted");
    capture("quote-accepted", html);
  });

  it("expired: reopening is offered, sending is not", () => {
    const html = render(
      <QuoteDetailPage
        view={detailView({
          status: "EXPIRED",
          statusLabel: "Expired",
          statusTone: "critical",
          expiryLabel: "Expired 2 days ago",
          actions: { draft: false, send: false, withdraw: false, reopen: true },
        })}
      />,
    );

    expect(html).toContain("Expired 2 days ago");
    expect(html).toContain("Reopen");
    expect(html).not.toContain('disabled="false"');
    capture("quote-expired", html);
  });

  it("the catalogue search, with results and with none", () => {
    const withResults = render(
      <QuoteDetailPage
        view={detailView({
          search: {
            query: "mug",
            results: [
              {
                variantId: "v1",
                title: "Blue Mug — Large",
                sku: "MUG-BL-L",
                price: "10.00",
              },
              {
                variantId: "v2",
                title: "Blue Mug — Small",
                sku: "MUG-BL-S",
                price: "8.00",
              },
            ],
            searched: true,
          },
        })}
      />,
    );
    expect(withResults).toContain("Blue Mug — Small");
    capture("quote-search", withResults);

    const none = render(
      <QuoteDetailPage
        view={detailView({ search: { query: "zzz", results: [], searched: true } })}
      />,
    );
    expect(none).toContain("Nothing in your catalogue matches");
    capture("quote-search-empty", none);
  });

  it("a refused action is said, not swallowed", () => {
    const html = render(
      <QuoteDetailPage
        view={detailView({ error: "This quote has no email address to send to." })}
      />,
    );
    expect(html).toContain("no email address to send to");
    capture("quote-error", html);
  });

  it("✦ the margin check is present and honest about not being ready", () => {
    const html = render(<QuoteDetailPage view={detailView()} />);
    expect(html).toContain("margin floor");
    expect(html).toContain("arrives with the rest of the AI features");
    expect(html).not.toContain('disabled="false"');
  });
});

/* -------------------------------------------------------------------------- */

const publicView = (overrides: Partial<PublicQuoteView> = {}): PublicQuoteView => ({
  action: "/q/abc123",
  shopName: "Alpha Wholesale",
  number: "Q-1001",
  company: "Acme Ltd",
  message: "Happy to do these at the tier price. Let me know.",
  lines: [
    {
      title: "Blue Mug — Large",
      sku: "MUG-BL-L",
      quantity: 100,
      unitPrice: "$6.50",
      lineTotal: "$650.00",
    },
  ],
  subtotal: "$650.00",
  expiryLabel: "This quote stands until 2026-09-24.",
  canRespond: true,
  closedReason: null,
  dir: "ltr",
  ...overrides,
});

describe("the buyer's page", () => {
  it("shows the prices, the total and both buttons", () => {
    const html = render(<PublicQuote view={publicView()} />);

    expect(html).toContain("Quote Q-1001");
    expect(html).toContain("$650.00");
    expect(html).toContain("Accept this quote");
    expect(html).toContain("No thanks");
    // A real form, so it works with JavaScript off.
    expect(html).toContain('method="post"');
    capture("quote-public", html, "en", REAL_NOTE);
  });

  it("expired: no buttons, and a way forward", () => {
    const html = render(
      <PublicQuote
        view={publicView({
          canRespond: false,
          closedReason:
            "This quote has run out. Get in touch with the seller if you would still like it.",
          expiryLabel: null,
        })}
      />,
    );

    expect(html).toContain("has run out");
    expect(html).not.toContain("Accept this quote");
    capture("quote-public-expired", html, "en", REAL_NOTE);
  });

  it("already accepted: says so rather than offering to accept again", () => {
    const html = render(
      <PublicQuote
        view={publicView({
          canRespond: false,
          closedReason:
            "You have already accepted this quote. The seller will be in touch to complete your order.",
        })}
      />,
    );

    expect(html).toContain("already accepted");
    expect(html).not.toContain('name="intent"');
    capture("quote-public-accepted", html, "en", REAL_NOTE);
  });

  it("renders in Arabic, right to left", () => {
    const html = render(<PublicQuote view={publicView({ dir: "rtl" })} />, "ar");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("قبول هذا العرض");
    capture("quote-public-ar", html, "ar", REAL_NOTE);
  });
});
