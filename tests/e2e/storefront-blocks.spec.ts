import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { renderBlock } from "../support/liquid-stand-in";

/**
 * The storefront blocks, driven in a real browser.
 *
 * The Liquid is rendered by a stand-in (`tests/support/liquid-stand-in.ts`), so
 * these do not prove Shopify renders the markup identically. What they do prove
 * is the part that can actually break: **the JavaScript that ships inside each
 * block**, against a stubbed App Proxy, in a real Chromium.
 *
 * Every state is screenshotted into qa/3.4/ on the way past.
 */

const OUT = resolve(process.cwd(), "qa/3.4");
mkdirSync(OUT, { recursive: true });

const NOTE = `<div style="background:#fff4e4;border:1px solid #e0b252;border-radius:8px;
  padding:.75rem 1rem;margin-bottom:1.25rem;font:12px/1.5 system-ui;color:#5e4200">
  <strong>QA capture — the block's own script, in a real browser.</strong> The Liquid around it is
  rendered by a stand-in rather than by Shopify, so the layout is approximate; the JavaScript,
  the states it renders and the requests it makes are the real ones.
</div>`;

/** A page carrying one block, with Shopify's route object and a stubbed proxy. */
function pageFor(html: string, stub: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Mannon storefront block</title>
<style>
 body{font:15px/1.5 system-ui,-apple-system,sans-serif;margin:0;padding:1.5rem;background:#f6f6f7;color:#1c1d2b}
 table{border-collapse:collapse;width:100%;margin:.75rem 0}
 th,td{padding:.45rem .5rem;border-bottom:1px solid #e3e3e3;text-align:start;vertical-align:top}
 textarea{padding:.5rem;border:1px solid #c9c9c9;border-radius:6px}
 button{font:inherit;padding:.45rem .9rem;border-radius:8px;border:1px solid #c9c9c9;background:#fff;cursor:pointer}
 .mannon-quick-order__add,.mannon-variants__add{background:#4f46e5;color:#fff;border-color:#4f46e5;font-weight:700}
 .mannon-quick-order__row--problem{color:#a11f1f}
 .visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
</style></head><body>
${NOTE}
<script>window.Shopify = { routes: { root: "/" } };</script>
<script>${stub}</script>
${html}
</body></html>`;
}

/**
 * Serve one canned proxy answer, and record what was asked for.
 *
 * Recorded through a Playwright binding rather than a page variable: adding to
 * the cart navigates to /cart on success, which would take a page variable with
 * it. The binding reaches Node before the navigation does.
 */
function proxyStub(response: unknown, status = 200): string {
  return `
    window.fetch = function (url, options) {
      var settings = options || {};
      window.__mannonRecord(
        String(url),
        settings.method || 'GET',
        typeof settings.body === 'string' ? settings.body : ''
      );
      return Promise.resolve({
        ok: ${status} >= 200 && ${status} < 300,
        status: ${status},
        json: function () { return Promise.resolve(${JSON.stringify(response)}); }
      });
    };`;
}

interface RecordedCall {
  url: string;
  method: string;
  body: string;
}

const quickOrderBlock = (settings: Record<string, unknown> = {}) =>
  renderBlock("quick-order.liquid", {
    block: {
      id: "qo1",
      shopify_attributes: "",
      settings: {
        heading: "Quick order",
        intro:
          "Paste your order below — one SKU per line, with the quantity after a comma.",
        rows: 8,
        default_quantity: 1,
        catalog_url: "/collections/all",
        ...settings,
      },
    },
    routes: { all_products_collection_url: "/collections/all" },
    request: { design_mode: false },
  });

const PRICED = {
  ok: true,
  lines: [
    {
      lineNumber: 1,
      sku: "MUG-BL-L",
      title: "Blue Mug — Large",
      quantity: 100,
      variantId: "gid://shopify/ProductVariant/1",
      unitPrice: "$6.50",
      wasPrice: "$10.00",
      lineTotal: "$650.00",
      ruleSummary: "Wholesale 35%",
      stock: "in_stock",
      stockCount: null,
    },
    {
      lineNumber: 2,
      sku: "MUG-BL-S",
      title: "Blue Mug — Small",
      quantity: 50,
      variantId: "gid://shopify/ProductVariant/2",
      unitPrice: "$5.20",
      wasPrice: "$8.00",
      lineTotal: "$260.00",
      ruleSummary: "Wholesale 35%",
      stock: "low",
      stockCount: 12,
    },
  ],
  unresolved: [],
  issues: [],
  subtotal: "$910.00",
  subtotalAmount: 91000,
  currencyCode: "USD",
  truncated: false,
};

async function shot(page: Page, name: string) {
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true });
}

async function load(
  page: Page,
  html: string,
  stub: string,
  name: string,
): Promise<RecordedCall[]> {
  const calls: RecordedCall[] = [];
  await page.exposeFunction(
    "__mannonRecord",
    (url: string, method: string, body: string) => {
      calls.push({ url, method, body });
    },
  );

  const file = resolve(OUT, `${name}.html`);
  writeFileSync(file, pageFor(html, stub));
  await page.goto(pathToFileURL(file).href);
  return calls;
}

test.describe("quick order by SKU", () => {
  test("empty: the form is there once the script has run", async ({ page }) => {
    await load(page, quickOrderBlock(), proxyStub({ ok: true }), "quick-order-empty");

    await expect(page.getByRole("heading", { name: "Quick order" })).toBeVisible();
    await expect(page.getByLabel("Your order")).toBeVisible();
    await expect(page.getByRole("button", { name: "Check prices" })).toBeVisible();
    await shot(page, "quick-order-empty");
  });

  test("priced: wholesale prices, the rule behind them, and a running total", async ({
    page,
  }) => {
    await load(page, quickOrderBlock(), proxyStub(PRICED), "quick-order-priced");

    await page.getByLabel("Your order").fill("MUG-BL-L, 100\nMUG-BL-S, 50");
    await page.getByRole("button", { name: "Check prices" }).click();

    // Real column headings, not six anonymous columns of numbers.
    await expect(page.getByRole("columnheader", { name: "SKU" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Unit price" })).toBeVisible();
    // And the SKU names its row, for anyone reading with a screen reader.
    await expect(page.getByRole("rowheader", { name: "MUG-BL-L" })).toBeVisible();

    await expect(page.getByText("Blue Mug — Large")).toBeVisible();
    // The buyer's price, with the list price struck through beside it.
    await expect(page.getByText("$6.50")).toBeVisible();
    await expect(page.locator("s", { hasText: "$10.00" })).toBeVisible();
    await expect(page.getByText("Total: $910.00")).toBeVisible();
    await expect(page.getByRole("button", { name: /Add everything/ })).toBeVisible();
    // Low stock says the number, which is what a wholesale buyer needs.
    await expect(page.getByText("Only 12 left")).toBeVisible();
    await shot(page, "quick-order-priced");
  });

  test("posts the list to the app proxy, not to a guessed path", async ({ page }) => {
    const calls = await load(
      page,
      quickOrderBlock(),
      proxyStub(PRICED),
      "quick-order-request",
    );

    await page.getByLabel("Your order").fill("MUG-BL-L, 100");
    await page.getByRole("button", { name: "Check prices" }).click();
    await expect(page.getByText("Blue Mug — Large")).toBeVisible();

    expect(calls[0]?.url).toBe("/apps/mannon/quick-order");
    expect(calls[0]?.method).toBe("POST");
  });

  test("unknown SKUs and duplicate lines are shown, never dropped", async ({ page }) => {
    await load(
      page,
      quickOrderBlock(),
      proxyStub({
        ...PRICED,
        unresolved: [
          { lineNumber: 3, sku: "NOPE-999", quantity: 5, reason: "not_found" },
          { lineNumber: 4, sku: "DRAFT-01", quantity: 2, reason: "unavailable" },
        ],
        issues: [
          { lineNumber: 5, raw: "MUG-BL-L,20", code: "duplicate", sku: "MUG-BL-L" },
          {
            lineNumber: 6,
            raw: "MUG-BL-S,x",
            code: "quantity_not_a_number",
            sku: "MUG-BL-S",
          },
        ],
      }),
      "quick-order-problems",
    );

    await page.getByLabel("Your order").fill("anything");
    await page.getByRole("button", { name: "Check prices" }).click();

    await expect(page.getByText("No product with this SKU")).toBeVisible();
    await expect(page.getByText("Not available to order")).toBeVisible();
    await expect(page.getByText(/Line 5: MUG-BL-L appears more than once/)).toBeVisible();
    await expect(page.getByText(/Line 6: could not read the quantity/)).toBeVisible();
    await shot(page, "quick-order-problems");
  });

  test("gated: says the store does not have it, rather than failing", async ({
    page,
  }) => {
    await load(
      page,
      quickOrderBlock(),
      proxyStub({ ok: false, reason: "not_available" }, 402),
      "quick-order-gated",
    );

    await page.getByLabel("Your order").fill("MUG-BL-L, 100");
    await page.getByRole("button", { name: "Check prices" }).click();

    await expect(page.getByText(/not switched on for this store/)).toBeVisible();
    await shot(page, "quick-order-gated");
  });

  test("a failed lookup says so and keeps the buyer's typing", async ({ page }) => {
    await load(page, quickOrderBlock(), proxyStub({}, 500), "quick-order-error");

    await page.getByLabel("Your order").fill("MUG-BL-L, 100");
    await page.getByRole("button", { name: "Check prices" }).click();

    await expect(page.getByText(/did not go through/)).toBeVisible();
    // Their paste is still there — losing forty lines to a bad minute would be
    // the worst thing this form could do.
    await expect(page.getByLabel("Your order")).toHaveValue("MUG-BL-L, 100");
    await shot(page, "quick-order-error");
  });

  test("adding to the cart stamps how the order was placed", async ({ page }) => {
    const calls = await load(
      page,
      quickOrderBlock(),
      proxyStub(PRICED),
      "quick-order-add",
    );

    await page.getByLabel("Your order").fill("MUG-BL-L, 100");
    await page.getByRole("button", { name: "Check prices" }).click();
    await page.getByRole("button", { name: /Add everything/ }).click();

    await expect.poll(() => calls.length).toBeGreaterThan(1);

    const add = calls.find((call) => call.url.includes("cart/add"));
    expect(add).toBeTruthy();
    // Read back by the orders list, which is the only way to tell a quick
    // order from a normal one.
    expect(add?.body).toContain("_mannon_source");
    expect(add?.body).toContain("quick_order");
  });

  test("no horizontal scroll on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await load(page, quickOrderBlock(), proxyStub(PRICED), "quick-order-mobile");

    await page.getByLabel("Your order").fill("MUG-BL-L, 100");
    await page.getByRole("button", { name: "Check prices" }).click();
    await expect(page.getByText("Blue Mug — Large")).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
    await shot(page, "quick-order-mobile");
  });
});

test.describe("quick order without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("says so and links to the catalogue", async ({ page }) => {
    await load(page, quickOrderBlock(), "", "quick-order-nojs");

    await expect(page.getByText(/needs JavaScript/)).toBeVisible();
    await expect(page.getByRole("link", { name: /Browse the catalogue/ })).toBeVisible();
    // And the form that cannot work is not on the page at all.
    await expect(page.getByLabel("Your order")).toBeHidden();
    await shot(page, "quick-order-nojs");
  });
});

/* -------------------------------------------------------------------------- */

const VARIANTS = [
  {
    id: 101,
    title: "Large",
    sku: "MUG-BL-L",
    price: 1000,
    available: true,
    inventory_quantity: 400,
    inventory_management: "shopify",
    inventory_policy: "deny",
  },
  {
    id: 102,
    title: "Small",
    sku: "MUG-BL-S",
    price: 800,
    available: true,
    inventory_quantity: 12,
    inventory_management: "shopify",
    inventory_policy: "deny",
  },
  {
    id: 103,
    title: "Travel",
    sku: "MUG-BL-T",
    price: 1200,
    available: false,
    inventory_quantity: 0,
    inventory_management: "shopify",
    inventory_policy: "deny",
  },
];

const variantsBlock = () =>
  renderBlock("variants-table.liquid", {
    block: {
      id: "vt1",
      shopify_attributes: "",
      settings: { heading: "Order by the case", quantity_step: 12, low_stock_at: 20 },
    },
    product: { id: 55, variants: VARIANTS },
    routes: { cart_add_url: "/cart/add" },
    request: { design_mode: false },
  });

const PRICED_VARIANTS = {
  ok: true,
  quantity: 1,
  variants: [
    {
      variantId: "gid://shopify/ProductVariant/101",
      unitPrice: "$6.50",
      wasPrice: "$10.00",
      ruleSummary: "Wholesale 35%",
    },
    {
      variantId: "gid://shopify/ProductVariant/102",
      unitPrice: "$5.20",
      wasPrice: "$8.00",
      ruleSummary: "Wholesale 35%",
    },
    {
      variantId: "gid://shopify/ProductVariant/103",
      unitPrice: "$7.80",
      wasPrice: "$12.00",
      ruleSummary: "Wholesale 35%",
    },
  ],
};

test.describe("the variants table", () => {
  test("wholesale prices replace the theme's once the app answers", async ({ page }) => {
    await load(page, variantsBlock(), proxyStub(PRICED_VARIANTS), "variants-priced");

    await expect(page.getByText("$6.50")).toBeVisible();
    await expect(page.locator("s", { hasText: "$10.00" })).toBeVisible();
    // Which rule did it — deciding shows its working, on the storefront too.
    await expect(page.getByText("Wholesale 35%").first()).toBeVisible();
    await expect(page.getByText(/your wholesale prices/)).toBeVisible();
    await shot(page, "variants-priced");
  });

  test("sends the list price as minor units, so a three-decimal currency survives", async ({
    page,
  }) => {
    const calls = await load(
      page,
      variantsBlock(),
      proxyStub(PRICED_VARIANTS),
      "variants-request",
    );
    await expect(page.getByText("$6.50")).toBeVisible();

    const asked = decodeURIComponent(calls[0]?.url ?? "");
    expect(asked).toContain("/apps/mannon/variants");
    // Liquid's own price is already in the subunit; no decimal round-trip.
    expect(asked).toContain('"priceMinor":1000');
  });

  test("keeps the theme's own prices when the app says no", async ({ page }) => {
    await load(page, variantsBlock(), proxyStub({}, 402), "variants-gated");

    // A buyer has no stake in their supplier's billing, so nothing is said —
    // the prices the theme rendered simply stay.
    await expect(page.getByText("$10.00")).toBeVisible();
    await expect(page.getByText(/your wholesale prices/)).toBeHidden();
    await shot(page, "variants-gated");
  });

  test("add-all collects only the rows with a quantity in them", async ({ page }) => {
    const calls = await load(
      page,
      variantsBlock(),
      proxyStub(PRICED_VARIANTS),
      "variants-add-all",
    );

    await page.locator("#mannon-vt-vt1-101").fill("24");
    await page.getByRole("button", { name: "Add everything to my cart" }).click();

    await expect.poll(() => calls.length).toBeGreaterThan(1);

    const add = calls.find((call) => call.url.includes("cart/add"));
    const body = JSON.parse(add?.body ?? "{}") as {
      items: { id: number; quantity: number }[];
      attributes: Record<string, string>;
    };

    expect(body.items).toEqual([{ id: 101, quantity: 24 }]);
    expect(body.attributes._mannon_source).toBe("quick_order");
    await shot(page, "variants-add-all");
  });
});

test.describe("the variants table on a phone", () => {
  test("the table scrolls, the page does not", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await load(page, variantsBlock(), proxyStub(PRICED_VARIANTS), "variants-mobile");
    await expect(page.getByText("$6.50")).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
    await shot(page, "variants-mobile");
  });
});

test.describe("the variants table without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("renders, prices and adds to cart on its own", async ({ page }) => {
    await load(page, variantsBlock(), "", "variants-nojs");

    // The theme already had the variants, so the table is real HTML.
    await expect(page.getByText("MUG-BL-L")).toBeVisible();
    await expect(page.getByText("$10.00")).toBeVisible();
    await expect(page.getByText("Only 12 left")).toBeVisible();
    await expect(page.getByText("Out of stock")).toBeVisible();

    // One form per row, each posting to Shopify's own endpoint — a single form
    // would post the rows left at zero, which /cart/add refuses.
    const forms = page.locator("form.mannon-variants__row-form");
    await expect(forms).toHaveCount(3);
    await expect(forms.first()).toHaveAttribute("action", "/cart/add");

    // The shortcut that needs a script is not on the page.
    await expect(
      page.getByRole("button", { name: "Add everything to my cart" }),
    ).toBeHidden();

    // The out-of-stock row cannot be ordered.
    await expect(page.locator("#mannon-vt-vt1-103")).toBeDisabled();
    await shot(page, "variants-nojs");
  });

  test("the quantity step follows the merchant's case size", async ({ page }) => {
    await load(page, variantsBlock(), "", "variants-nojs-step");
    const field = page.locator("#mannon-vt-vt1-101");
    await expect(field).toHaveAttribute("step", "12");
    // And a minimum of one case, not one unit — the field cannot post a zero.
    await expect(field).toHaveAttribute("min", "12");
  });
});
