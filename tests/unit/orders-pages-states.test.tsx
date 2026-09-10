import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { LimitsPage } from "~/components/orders/LimitsPage";
import { OrderListPage } from "~/components/orders/OrderListPage";
import type {
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
 * QA_CAPTURE=1 also writes each one to qa/3.1/. Structure only — see the note
 * each capture carries.
 */

const OUT = resolve(process.cwd(), "qa/3.1");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Orders",
    outFor: () => OUT,
    dirs: [OUT],
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
