import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { PurchaseOrderPage } from "~/components/orders/PurchaseOrderPage";
import type { PoLineView, PurchaseOrderView } from "~/components/orders/types";
import type { Locale } from "~/i18n/config";
import { createCaptureHarness, type CaptureHarness } from "../support/state-capture";

/**
 * ✦ PO-to-order — every state in checklist §5.
 *
 * Two of them are the feature: an ambiguous line the merchant picks between,
 * and a document whose prices disagree with the contract. Both must be on
 * screen rather than resolved quietly.
 */

const OUT = resolve(process.cwd(), "qa/4.4");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "PO to order",
    outFor: () => OUT,
    dirs: [OUT],
  });
});

const line = (overrides: Partial<PoLineView> = {}): PoLineView => ({
  index: 0,
  requested: "MUG-BLUE",
  quantity: 200,
  confidence: "exact",
  matched: "Blue Mug — Large",
  sku: "MUG-BLUE",
  unitPrice: "$4.10",
  lineTotal: "$820.00",
  statedPrice: null,
  priceDelta: null,
  ruleSummary: "Gold tier, 100+ units",
  candidates: [],
  ...overrides,
});

const view = (overrides: Partial<PurchaseOrderView> = {}): PurchaseOrderView => ({
  available: true,
  locked: null,
  text: "",
  fileError: null,
  fileLimit: "10 MB",
  failure: null,
  buyer: { id: "c1", label: "Acme Ltd" },
  buyers: [{ id: "c1", label: "Acme Ltd" }],
  buyersTruncated: false,
  lines: [],
  subtotal: null,
  reference: null,
  notes: null,
  needsAttention: 0,
  payload: "{}",
  created: null,
  ...overrides,
});

/* -------------------------------------------------------------------------- */

describe("the composer", () => {
  it("takes a paste or a file", () => {
    const html = render(<PurchaseOrderPage view={view()} />);

    expect(html).toContain("Paste the order");
    expect(html).toContain('name="text"');
    expect(html).toContain('type="file"');
    capture("20-po-composer", html);
  });

  it("says the feature is on a bigger plan, and offers the plans page", () => {
    const html = render(
      <PurchaseOrderPage view={view({ available: false, locked: "plan" })} />,
    );

    expect(html).toContain("bigger plan");
    expect(html).toContain("/app/plans");
    expect(html).toMatch(/<s-text-area[^>]*disabled="true"/);
    capture("21-po-plan-locked", html);
  });

  it("offers the textarea when a file could not be read", () => {
    const html = render(<PurchaseOrderPage view={view({ fileError: "unreadable" })} />);

    expect(html).toContain("Couldn&#x27;t read this file");
    // The checklist's exact fallback.
    expect(html).toContain("Paste the lines as text instead");
    expect(html).toContain("Mannon reads text files");
    capture("22-po-unreadable-file", html);
  });

  it("says how big is too big", () => {
    const html = render(<PurchaseOrderPage view={view({ fileError: "too_large" })} />);

    expect(html).toContain("That file is too big");
    // "Too big" without a number is not something a merchant can act on.
    expect(html).toContain("Files up to 10 MB can be uploaded");
    capture("29-po-file-too-large", html);
  });

  it("says the picker is not everybody, when it is not", () => {
    const html = render(<PurchaseOrderPage view={view({ buyersTruncated: true })} />);

    expect(html).toContain("Showing your 100 largest buyers");
    capture("30-po-buyers-truncated", html);
  });

  it("says what happened when the model did not answer", () => {
    const html = render(<PurchaseOrderPage view={view({ failure: "timeout" })} />);
    expect(html).toContain("did not answer in time");
    expect(html).toContain("Nothing was ordered");
  });
});

describe("the review", () => {
  const reviewed = (lines: PoLineView[], overrides: Partial<PurchaseOrderView> = {}) =>
    view({
      lines,
      subtotal: "$820.00",
      needsAttention: lines.filter((one) => one.confidence !== "exact").length,
      ...overrides,
    });

  it("shows each line matched, priced from our rules, with the rule that did it", () => {
    const html = render(<PurchaseOrderPage view={reviewed([line()])} />);

    expect(html).toContain("200 × MUG-BLUE");
    expect(html).toContain("Blue Mug — Large");
    expect(html).toContain("$4.10 each");
    expect(html).toContain("Gold tier, 100+ units");
    expect(html).toContain("Every price here comes from your own rules");
    capture("23-po-review", html);
  });

  it("prints the difference when the document disagrees on price", () => {
    const html = render(
      <PurchaseOrderPage
        view={reviewed([line({ statedPrice: "$4.00", priceDelta: "$0.10" })])}
      />,
    );

    // "PO says $4.00, contract price is $4.10" — shown, not reconciled.
    expect(html).toContain("The document says $4.00");
    expect(html).toContain("contract price is $4.10");
    capture("24-po-price-delta", html);
  });

  it("asks which product an ambiguous line meant", () => {
    const html = render(
      <PurchaseOrderPage
        view={reviewed([
          line({
            requested: "blue mugs",
            confidence: "ambiguous",
            matched: null,
            sku: null,
            unitPrice: null,
            lineTotal: null,
            ruleSummary: null,
            candidates: [
              { id: "gid://v/1", label: "Blue Mug — Large", sku: "MUG-BLUE-L" },
              { id: "gid://v/2", label: "Blue Mug — Small", sku: "MUG-BLUE-S" },
            ],
          }),
        ])}
      />,
    );

    expect(html).toContain("Several matches");
    expect(html).toContain("Which one did they mean?");
    expect(html).toContain("MUG-BLUE-L");
    expect(html).toContain("1 line needs you");
    capture("25-po-ambiguous", html);
  });

  it("lists an unmatched line rather than dropping it", () => {
    const html = render(
      <PurchaseOrderPage
        view={reviewed([
          line({
            requested: "left-handed widget",
            confidence: "none",
            matched: null,
            sku: null,
            unitPrice: null,
            lineTotal: null,
            ruleSummary: null,
          }),
        ])}
      />,
    );

    expect(html).toContain("No match");
    expect(html).toContain("Nothing in your catalogue matched this line");
    expect(html).toContain("Nothing has been left out");
    capture("26-po-unmatched", html);
  });

  it("shows the subtotal at our prices, and one button that creates anything", () => {
    const html = render(<PurchaseOrderPage view={reviewed([line()])} />);

    expect(html).toContain("Subtotal at your prices: $820.00");
    expect(html.match(/value="create"/g)).toHaveLength(1);
  });

  it("confirms the draft order, and links to it in Shopify", () => {
    const html = render(
      <PurchaseOrderPage
        view={reviewed([line()], {
          created: { name: "#D12", invoiceUrl: "https://example.test/invoice" },
        })}
      />,
    );

    expect(html).toContain("Draft order #D12 created");
    expect(html).toContain("https://example.test/invoice");
    capture("27-po-created", html);
  });

  it("renders in Arabic", () => {
    const html = render(<PurchaseOrderPage view={reviewed([line()])} />, "ar");
    expect(html).toContain("ما طُلب");
    expect(html).not.toContain("What was ordered");
    capture("28-po-arabic", html, "ar");
  });
});

describe("navigation", () => {
  it("is reachable from every other orders page, and is not a dead end", () => {
    const html = render(<PurchaseOrderPage view={view()} />);

    // A page nobody can navigate to is a page that does not exist. Quotes had
    // the same gap since 3.3 and is fixed alongside this.
    expect(html).toContain('href="/app/orders"');
    expect(html).toContain('href="/app/orders/quotes"');
    expect(html).toMatch(/href="\/app\/orders\/po"[^>]*aria-current="page"/);
  });
});
