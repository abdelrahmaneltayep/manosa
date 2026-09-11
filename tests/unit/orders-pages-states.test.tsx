import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { LedgerPage } from "~/components/orders/LedgerPage";
import { LimitsPage } from "~/components/orders/LimitsPage";
import { OrderListPage } from "~/components/orders/OrderListPage";
import type {
  LedgerRowView,
  LedgerView,
  LimitRowView,
  LimitsView,
  OrderListView,
  OrderRowView,
} from "~/components/orders/types";
import type { Locale } from "~/i18n/config";
import { createCaptureHarness, type CaptureHarness } from "../support/state-capture";

/**
 * Every state in checklist §5, rendered and asserted.
 *
 * QA_CAPTURE=1 writes the order and limit states to qa/3.1/ and the net-terms
 * states (3.2) to qa/3.2/. Structure only — see the note each capture carries.
 */

const ORDERS_OUT = resolve(process.cwd(), "qa/3.1");
const TERMS_OUT = resolve(process.cwd(), "qa/3.2");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Orders",
    // One test file spans two tasks; each state goes to the task that owns it.
    outFor: (name) => (name.startsWith("terms-") ? TERMS_OUT : ORDERS_OUT),
    dirs: [ORDERS_OUT, TERMS_OUT],
  });
});

/* -------------------------------------------------------------------------- */

const row = (overrides: Partial<OrderRowView> = {}): OrderRowView => ({
  id: "o1",
  name: "#1001",
  adminUrl: "https://alpha.myshopify.com/admin/orders/5001",
  buyer: "Acme Ltd",
  buyerHref: "/app/customers/c1",
  placedVia: "STOREFRONT",
  payment: { label: "Paid", tone: "success" },
  refund: null,
  total: "$1,200.50",
  quantity: 12,
  processedAt: "2026-09-08T10:00:00.000Z",
  processedLabel: "2 days ago",
  needsResync: false,
  cancelled: false,
  ...overrides,
});

const listView = (overrides: Partial<OrderListView> = {}): OrderListView => ({
  rows: [row()],
  total: 1,
  totalUnfiltered: 1,
  page: 1,
  pageSize: 25,
  pageCount: 1,
  filters: { search: "", source: "", payment: "" },
  syncing: false,
  resyncCount: 0,
  historyDays: 60,
  ...overrides,
});

describe("wholesale orders list", () => {
  it("empty: says when orders will appear, and links to a test order", () => {
    const html = render(
      <OrderListPage view={listView({ rows: [], total: 0, totalUnfiltered: 0 })} />,
    );

    expect(html).toContain("No wholesale orders yet");
    expect(html).toContain("approved buyer checks out");
    expect(html).toContain("test order");
    // No table, and no filter bar, on an empty list.
    expect(html).not.toContain("<s-table");
    capture("orders-empty", html);
  });

  it("first sync: skeleton rows, hidden from assistive tech", () => {
    const html = render(
      <OrderListPage
        view={listView({ rows: [], total: 0, totalUnfiltered: 0, syncing: true })}
      />,
    );

    expect(html).toContain("Importing your orders");
    expect(html).toContain('accessibilityVisibility="hidden"');
    capture("orders-syncing", html);
  });

  it("rows: order number, buyer, placed-via chip, payment and total", () => {
    const html = render(
      <OrderListPage
        view={listView({
          rows: [
            row(),
            row({
              id: "o2",
              name: "#1002",
              placedVia: "QUICK_ORDER",
              payment: { label: "Net 30 · due in 12 days", tone: "warning" },
              total: "$480.00",
            }),
            row({
              id: "o3",
              name: "#1003",
              placedVia: "BUYER_AGENT",
              payment: { label: "Net 30 · 9 days overdue", tone: "critical" },
              total: "$2,150.00",
            }),
            row({
              id: "o4",
              name: "#1004",
              placedVia: "DRAFT",
              payment: { label: "Partly refunded", tone: "info" },
              refund: "Refunded $40.00",
              total: "$1,160.50",
            }),
          ],
          total: 4,
          totalUnfiltered: 4,
        })}
      />,
    );

    expect(html).toContain("#1001");
    expect(html).toContain("Storefront");
    expect(html).toContain("Quick order");
    expect(html).toContain("Draft");
    // ✦ marks anything an agent did, everywhere in the app.
    expect(html).toContain("✦");
    expect(html).toContain("Buyer Agent");
    expect(html).toContain("9 days overdue");
    expect(html).toContain("Refunded $40.00");
    capture("orders-rows", html);
  });

  it("edited in Shopify: a resync badge and a banner that says what is stale", () => {
    const html = render(
      <OrderListPage
        view={listView({
          rows: [row({ needsResync: true })],
          resyncCount: 1,
        })}
      />,
    );

    expect(html).toContain("Changed in Shopify");
    expect(html).toContain("may be out of date");
    capture("orders-resync", html);
  });

  it("cancelled: the row stays and says so", () => {
    const html = render(
      <OrderListPage
        view={listView({
          rows: [
            row({ cancelled: true, payment: { label: "Cancelled", tone: "neutral" } }),
          ],
        })}
      />,
    );

    expect(html).toContain("Cancelled");
    capture("orders-cancelled", html);
  });

  it("filtered to nothing: tells 'no orders' from 'nothing matched'", () => {
    const html = render(
      <OrderListPage
        view={listView({
          rows: [],
          total: 0,
          totalUnfiltered: 12,
          filters: { search: "", source: "", payment: "overdue" },
        })}
      />,
    );

    expect(html).toContain("No orders match these filters");
    expect(html).not.toContain("No wholesale orders yet");
    expect(html).toContain("Clear filters");
    capture("orders-no-results", html);
  });

  it("paginates, and carries the filters into the next page's link", () => {
    const html = render(
      <OrderListPage
        view={listView({
          total: 60,
          totalUnfiltered: 60,
          pageCount: 3,
          page: 2,
          filters: { search: "acme", source: "pos", payment: "" },
        })}
      />,
    );

    expect(html).toContain("Page 2 of 3");
    expect(html).toContain("search=acme");
    expect(html).toContain("source=pos");
    capture("orders-paginated", html);
  });

  it("states the 60-day reach rather than implying the list is everything", () => {
    const html = render(<OrderListPage view={listView()} />);
    expect(html).toContain("last 60 days");
  });

  it("renders in Arabic, right to left", () => {
    const html = render(<OrderListPage view={listView()} />, "ar");
    expect(html).toContain("طلبات الجملة");
    expect(html).not.toContain("Wholesale orders");
    capture("orders-rows-ar", html, "ar");
  });
});

/* -------------------------------------------------------------------------- */

const limitRow = (overrides: Partial<LimitRowView> = {}): LimitRowView => ({
  id: "l1",
  groupName: "Silver",
  groupId: "g1",
  enabled: true,
  minSubtotal: "$200.00",
  maxSubtotal: null,
  minQuantity: null,
  maxQuantity: null,
  quantityIncrement: 12,
  countries: [],
  summary: "$200.00 minimum · cases of 12",
  ...overrides,
});

const limitsView = (overrides: Partial<LimitsView> = {}): LimitsView => ({
  rows: [limitRow()],
  groups: [{ id: "g1", name: "Silver" }],
  form: null,
  issues: [],
  currencyCode: "USD",
  exampleMinimum: "$200.00",
  posBypassesLimits: true,
  entitled: true,
  requiredPlan: "pro",
  publishedAt: "2026-09-10T09:00:00.000Z",
  preview: {
    heading: "A cart of $100.00",
    message: "Add $100.00 to reach your $200.00 minimum order.",
  },
  ...overrides,
});

describe("order limits", () => {
  it("empty: explains with examples in the store's own currency", () => {
    const html = render(
      <LimitsPage view={limitsView({ rows: [], preview: null, publishedAt: null })} />,
    );

    expect(html).toContain("No order limits yet");
    expect(html).toContain("$200.00 minimum per order");
    expect(html).toContain("Cases of 12");
    capture("limits-empty", html);
  });

  it("current limits: a sentence per limit, not four columns of numbers", () => {
    const html = render(
      <LimitsPage
        view={limitsView({
          rows: [
            limitRow(),
            limitRow({
              id: "l2",
              groupName: null,
              groupId: null,
              summary: "$50.00 minimum",
              enabled: false,
            }),
          ],
        })}
      />,
    );

    expect(html).toContain("$200.00 minimum · cases of 12");
    expect(html).toContain("Every wholesale buyer");
    expect(html).toContain("Off");
    capture("limits-list", html);
  });

  it("shows what the buyer would be told, with the gap in it", () => {
    const html = render(<LimitsPage view={limitsView()} />);

    expect(html).toContain("What a buyer sees");
    expect(html).toContain("Add $100.00 to reach your $200.00 minimum order.");
    capture("limits-preview", html);
  });

  it("not published: warns that nobody is held to these limits", () => {
    const html = render(<LimitsPage view={limitsView({ publishedAt: null })} />);
    expect(html).toContain("reached Shopify yet");
    capture("limits-unpublished", html);
  });

  it("conflicting bounds are blocked inline, beside the field", () => {
    const html = render(
      <LimitsPage
        view={limitsView({
          issues: [{ code: "min_above_max_subtotal" }],
          form: {
            id: null,
            groupId: "",
            enabled: true,
            minSubtotal: "500.00",
            maxSubtotal: "200.00",
            minQuantity: "",
            maxQuantity: "",
            quantityIncrement: "",
            countries: "",
          },
        })}
      />,
    );

    expect(html).toContain("above the maximum");
    // And what was typed is still there.
    expect(html).toContain("500.00");
    capture("limits-conflict", html);
  });

  it("a case size that does not divide the minimum says the next one up", () => {
    const html = render(
      <LimitsPage
        view={limitsView({
          issues: [{ code: "increment_conflicts_with_minimum", detail: "12" }],
          form: {
            id: null,
            groupId: "",
            enabled: true,
            minSubtotal: "",
            maxSubtotal: "",
            minQuantity: "10",
            maxQuantity: "",
            quantityIncrement: "4",
            countries: "",
          },
        })}
      />,
    );

    expect(html).toContain("next one up is 12");
    capture("limits-increment-conflict", html);
  });

  it("gated: existing limits still shown, the editor disabled", () => {
    const html = render(<LimitsPage view={limitsView({ entitled: false })} />);

    expect(html).toContain("paid plan");
    expect(html).toContain("nothing is deleted");
    // Features pause, data is never deleted — the limit is still on the page.
    expect(html).toContain("$200.00 minimum · cases of 12");
    // Rendered as the attribute's presence, never as disabled="false".
    expect(html).not.toContain('disabled="false"');
    capture("limits-gated", html);
  });

  it("entitled: nothing on the form is disabled", () => {
    const html = render(<LimitsPage view={limitsView()} />);
    expect(html).not.toContain("disabled");
  });

  it("editing: the form is filled in and offers a way out", () => {
    const html = render(
      <LimitsPage
        view={limitsView({
          form: {
            id: "l1",
            groupId: "g1",
            enabled: true,
            minSubtotal: "200.00",
            maxSubtotal: "",
            minQuantity: "",
            maxQuantity: "",
            quantityIncrement: "12",
            countries: "SA, AE",
          },
        })}
      />,
    );

    expect(html).toContain("Edit this limit");
    expect(html).toContain("SA, AE");
    expect(html).toContain("Cancel");
    capture("limits-editing", html);
  });

  it("the POS bypass reads as checked when it is on", () => {
    const on = render(<LimitsPage view={limitsView()} />);
    const off = render(<LimitsPage view={limitsView({ posBypassesLimits: false })} />);

    expect(on).toContain('checked="true"');
    // React stringifies props on a custom element, so `checked={false}` would
    // render checked="false" — which is checked.
    expect(off).not.toContain('checked="false"');
  });

  it("renders in Arabic, right to left", () => {
    const html = render(<LimitsPage view={limitsView()} />, "ar");
    expect(html).toContain("حدود الطلب");
    expect(html).not.toContain("Order limits");
    capture("limits-list-ar", html, "ar");
  });
});

/* -------------------------------------------------------------------------- */

const ledgerRow = (overrides: Partial<LedgerRowView> = {}): LedgerRowView => ({
  id: "o1",
  name: "#1001",
  adminUrl: "https://alpha.myshopify.com/admin/orders/5001",
  buyer: "Acme Ltd",
  buyerHref: "/app/customers/c1",
  terms: "Net 30 days",
  dueLabel: "Due in 12 days",
  overdue: false,
  balance: "$1,000.00",
  balanceRaw: "1000.00",
  paid: null,
  currencyCode: "USD",
  risk: null,
  remindedLabel: null,
  canRemind: true,
  error: null,
  ...overrides,
});

const ledgerView = (overrides: Partial<LedgerView> = {}): LedgerView => ({
  rows: [ledgerRow()],
  buckets: [
    { bucket: "current", outstanding: "$1,000.00", invoiceCount: 1 },
    { bucket: "days_1_15", outstanding: "$0.00", invoiceCount: 0 },
    { bucket: "days_16_30", outstanding: "$0.00", invoiceCount: 0 },
    { bucket: "days_30_plus", outstanding: "$0.00", invoiceCount: 0 },
  ],
  outstanding: "$1,000.00",
  page: 1,
  pageCount: 1,
  anyBuyerHasTerms: true,
  entitled: true,
  requiredPlan: "growth",
  publishedAt: "2026-09-10T09:00:00.000Z",
  settings: {
    methodName: "Net terms",
    showDaysInName: true,
    overdueBlocks: true,
    preview: "Pay later (Net 30)",
  },
  settingsError: false,
  ...overrides,
});

describe("the terms ledger", () => {
  it("empty: nobody on terms yet, with the way to start", () => {
    const html = render(
      <LedgerPage
        view={ledgerView({ rows: [], anyBuyerHasTerms: false, outstanding: "$0.00" })}
      />,
    );

    expect(html).toContain("Nobody is on payment terms yet");
    expect(html).toContain("Set terms on a group");
    capture("terms-empty", html);
  });

  it("all paid is not the same state as nobody on terms", () => {
    const html = render(<LedgerPage view={ledgerView({ rows: [] })} />);

    expect(html).toContain("Nothing outstanding");
    expect(html).not.toContain("Nobody is on payment terms yet");
    capture("terms-all-paid", html);
  });

  it("aging: every bucket shown, overdue money in red", () => {
    const html = render(
      <LedgerPage
        view={ledgerView({
          buckets: [
            { bucket: "current", outstanding: "$1,000.00", invoiceCount: 1 },
            { bucket: "days_1_15", outstanding: "$480.00", invoiceCount: 1 },
            { bucket: "days_16_30", outstanding: "$0.00", invoiceCount: 0 },
            { bucket: "days_30_plus", outstanding: "$2,150.00", invoiceCount: 2 },
          ],
          outstanding: "$3,630.00",
        })}
      />,
    );

    // Every band, including the empty one — otherwise a merchant cannot tell
    // "nobody is that late" from "that column was dropped".
    expect(html).toContain("1–15 days late");
    expect(html).toContain("16–30 days late");
    expect(html).toContain("Over 30 days late");
    expect(html).toContain('tone="critical"');
    expect(html).toContain("$3,630.00 outstanding in total");
    capture("terms-aging", html);
  });

  it("rows: overdue red, part payments, and a recent reminder", () => {
    const html = render(
      <LedgerPage
        view={ledgerView({
          rows: [
            ledgerRow({
              id: "o2",
              name: "#1002",
              dueLabel: "9 days overdue",
              overdue: true,
              paid: "$400.00 paid so far",
              balance: "$600.00",
            }),
            ledgerRow({
              id: "o3",
              name: "#1003",
              dueLabel: "41 days overdue",
              overdue: true,
              remindedLabel: "Reminded 2 days ago",
              canRemind: false,
            }),
            ledgerRow(),
          ],
        })}
      />,
    );

    expect(html).toContain("9 days overdue");
    expect(html).toContain("$400.00 paid so far");
    expect(html).toContain("Reminded 2 days ago");
    // The reminder button is disabled while one is too recent, by the
    // attribute's presence — never disabled="false".
    expect(html).toContain("disabled");
    expect(html).not.toContain('disabled="false"');
    capture("terms-rows", html);
  });

  it("a refused payment says why, beside the field that caused it", () => {
    const html = render(
      <LedgerPage
        view={ledgerView({
          rows: [
            ledgerRow({
              error:
                "That is more than the #1001 balance. Record at most the outstanding amount.",
            }),
          ],
        })}
      />,
    );

    expect(html).toContain("more than the #1001 balance");
    capture("terms-payment-error", html);
  });

  it("says how each buyer has paid before, and on what", () => {
    const html = render(
      <LedgerPage
        view={ledgerView({
          rows: [
            ledgerRow({
              risk: { level: "good", label: "Paid the last 6 on time" },
            }),
            ledgerRow({
              id: "o2",
              name: "#1002",
              buyer: "Slow Ltd",
              risk: { level: "watch", label: "1 of the last 5 was late" },
            }),
            ledgerRow({
              id: "o3",
              name: "#1003",
              buyer: "Late Ltd",
              // Overdue *and* labelled overdue: the producer never writes one
              // without the other, and a fixture that does is a fixture of a
              // row this app cannot make.
              overdue: true,
              dueLabel: "9 days overdue",
              risk: { level: "late", label: "2 invoices overdue now" },
            }),
          ],
        })}
      />,
    );

    // `terms_risk` carried a prompt version from 4.1 with no prompt, no caller
    // and nothing on any screen. It is counted off this ledger now — and it
    // says what it counted, because a buyer graded in one word is a merchant's
    // judgement replaced by ours.
    expect(html).toContain("Paid the last 6 on time");
    expect(html).toContain("1 of the last 5 was late");
    expect(html).toContain("2 invoices overdue now");
    // Three tones, so the three states are told apart at a glance.
    expect(html).toContain('tone="success"');
    expect(html).toContain('tone="warning"');
    expect(html).toContain('tone="critical"');
    capture("terms-risk", html);
  });

  it("unpublished: warns that checkout has not been told", () => {
    const html = render(<LedgerPage view={ledgerView({ publishedAt: null })} />);

    expect(html).toContain("Checkout has not been told");
    expect(html).toContain("shown to everybody");
    capture("terms-unpublished", html);
  });

  it("gated: invoices still shown and still chased, the editor disabled", () => {
    const html = render(<LedgerPage view={ledgerView({ entitled: false })} />);

    expect(html).toContain("paid plan");
    expect(html).toContain("nothing is deleted");
    // Features pause, data is never deleted.
    expect(html).toContain("#1001");
    expect(html).not.toContain('disabled="false"');
    capture("terms-gated", html);
  });

  it("settings: shows what the eligible buyer's button will say", () => {
    const html = render(<LedgerPage view={ledgerView()} />);

    expect(html).toContain("Pay later (Net 30)");
    expect(html).toContain("not a disabled button");
    capture("terms-settings", html);
  });

  it("a settings error names the consequence, not just the rule", () => {
    const html = render(<LedgerPage view={ledgerView({ settingsError: true })} />);
    expect(html).toContain("hide the whole payment step");
    capture("terms-settings-error", html);
  });

  it("the overdue-blocks toggle reads as checked when it is on", () => {
    const on = render(<LedgerPage view={ledgerView()} />);
    const off = render(
      <LedgerPage
        view={ledgerView({
          settings: { ...ledgerView().settings, overdueBlocks: false },
        })}
      />,
    );

    expect(on).toContain('checked="true"');
    expect(off).not.toContain('checked="false"');
  });

  it("renders in Arabic, right to left", () => {
    const html = render(<LedgerPage view={ledgerView()} />, "ar");
    expect(html).toContain("شروط الدفع");
    expect(html).not.toContain("Payment terms");
    capture("terms-ledger-ar", html, "ar");
  });
});

describe("the orders tab bar", () => {
  it("reaches every page in the section", () => {
    const html = render(<OrderListPage view={listView()} />);

    // Quotes shipped in 3.3 with no way to reach it from here, and ✦ PO-to-order
    // would have shipped the same way. Both are asserted now.
    expect(html).toContain('href="/app/orders/limits"');
    expect(html).toContain('href="/app/orders/terms"');
    expect(html).toContain('href="/app/orders/quotes"');
    expect(html).toContain('href="/app/orders/po"');
  });
});
