import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * What can honestly be checked about a theme block from here.
 *
 * The checklist asks for a ≤10-point Lighthouse impact budget, and Lighthouse
 * needs a real storefront this environment cannot reach. What it *can* prove is
 * the things that would spend that budget: an external script, a library, a
 * render-blocking fetch, a block that does nothing without JavaScript. Those
 * are asserted here; `qa/3.4/REPORT.md` says plainly that a real Lighthouse run
 * is still owed.
 */

const BLOCKS = resolve(process.cwd(), "extensions/mannon-storefront/blocks");

const files = readdirSync(BLOCKS).filter((name) => name.endsWith(".liquid"));
const source = (name: string) => readFileSync(join(BLOCKS, name), "utf8");

/**
 * Every byte in a block is a byte on a merchant's storefront, inline, on every
 * page it is added to. This is deliberately tight enough that adding a library
 * would fail it.
 */
const MAX_BYTES = 16 * 1024;

/**
 * What a buyer actually downloads.
 *
 * Liquid comments and the `{% schema %}` block are stripped by Shopify before
 * anything is rendered, so a buyer never pays for either. Measuring the file on
 * disk counted them, which made the budget push against the one thing it has no
 * business discouraging: writing down why storefront code is the way it is.
 * JavaScript comments are **not** stripped and are still counted, because those
 * really are shipped.
 */
const served = (liquid: string) =>
  Buffer.byteLength(
    liquid
      .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "")
      .replace(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/g, ""),
  );

describe("the blocks exist", () => {
  it("ships the four the app has", () => {
    expect(files.sort()).toEqual([
      "buyer-agent.liquid",
      "quick-order.liquid",
      "registration-form.liquid",
      "variants-table.liquid",
    ]);
  });
});

/**
 * A block a merchant adds to a section needs a preset to be addable at all.
 * A `body` block is an app embed, which the merchant switches on in the theme
 * editor's App embeds list and which a preset would be meaningless for.
 */
const isAppEmbed = (liquid: string) => /"target"\s*:\s*"body"/.test(liquid);

describe.each(files)("%s", (name) => {
  const liquid = source(name);

  it("fetches no script from anywhere", () => {
    // An external script is a DNS lookup, a connection and a parse on a page
    // the merchant is judged on. Anything this app needs is inline and small.
    expect(liquid).not.toMatch(/<script[^>]+src=/i);
  });

  it("loads no stylesheet and no font", () => {
    expect(liquid).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
    expect(liquid).not.toMatch(/fonts\.(googleapis|gstatic)\.com/i);
  });

  it("names no library", () => {
    for (const library of ["jquery", "react", "vue", "lodash", "axios", "alpine"]) {
      expect(liquid.toLowerCase()).not.toContain(library);
    }
  });

  it("stays inside the byte budget", () => {
    expect(served(liquid)).toBeLessThan(MAX_BYTES);
  });

  it("is measured on what a buyer downloads, not on what is in the file", () => {
    // Guards the guard: if the strip above ever stops matching, the budget
    // quietly goes back to counting documentation as payload.
    const withComment = `{% comment %}${"x".repeat(4096)}{% endcomment %}${liquid}`;
    expect(served(withComment)).toBe(served(liquid));
  });

  it("declares its schema, and a preset when a preset is what adds it", () => {
    expect(liquid).toContain("{% schema %}");
    if (!isAppEmbed(liquid)) expect(liquid).toContain('"presets"');
  });

  it("writes text with textContent, never innerHTML", () => {
    // A product title is the merchant's data. Building markup from it would
    // make it executable on their storefront.
    //
    // Comments are stripped first: the rule is about what the block does, and
    // a line explaining why it does not do this should not fail it.
    const code = liquid.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("innerHTML");
    expect(code).not.toContain("outerHTML");
    expect(code).not.toContain("document.write");
  });

  it("uses Shopify's own route root rather than assuming a path", () => {
    if (!liquid.includes("fetch(")) return;
    // A hard-coded "/cart" is wrong on every non-default-language storefront.
    expect(liquid).not.toMatch(/fetch\(\s*['"]\//);
    expect(liquid).toContain("window.Shopify");
  });
});

describe("working without JavaScript", () => {
  it("quick order says so and points at the catalogue", () => {
    const liquid = source("quick-order.liquid");

    // There is no SKU lookup to be had without a script, so the block says
    // that rather than showing a form that cannot submit.
    expect(liquid).toContain("<noscript>");
    expect(liquid).toContain("browse_catalog");
    // The form is hidden until the script shows it — including from assistive
    // technology, which `hidden` does and `display:none` in a class would not
    // guarantee.
    expect(liquid).toMatch(/data-mannon-form\s+hidden/);
  });

  it("the variants table renders and adds to cart on its own", () => {
    const liquid = source("variants-table.liquid");

    // The theme already has the variants, so the table is real HTML and each
    // row posts to Shopify's own endpoint.
    expect(liquid).toContain("{{ routes.cart_add_url }}");
    expect(liquid).toContain('method="post"');
    // One form per row: a single form would post the rows left at zero, and
    // /cart/add refuses a line of zero.
    expect(liquid).toContain("mannon-variants__row-form");
    // And the shortcut that needs a script is not on the page until it is.
    expect(liquid).toMatch(/data-mannon-add-all\s+hidden/);
  });

  it("the variants table asks for prices only when it comes into view", () => {
    const liquid = source("variants-table.liquid");
    expect(liquid).toContain("IntersectionObserver");
    // And still works in a browser without one, rather than showing nothing.
    expect(liquid).toContain("} else {");
  });
});

describe("attribution", () => {
  it("both order blocks stamp how the order was placed", () => {
    // Shopify reports every app extension's cart as the storefront, so this
    // attribute is the only thing that tells a quick order from a normal one
    // in the admin's order list (phase 3.1).
    for (const name of ["quick-order.liquid", "variants-table.liquid"]) {
      expect(source(name)).toContain("_mannon_source");
      expect(source(name)).toContain("quick_order");
    }
  });

  it("the variants table stamps it in the markup, so it survives without JS", () => {
    expect(source("variants-table.liquid")).toContain(
      'name="attributes[_mannon_source]"',
    );
  });
});

describe("translation", () => {
  const locale = JSON.parse(
    readFileSync(
      resolve(process.cwd(), "extensions/mannon-storefront/locales/en.default.json"),
      "utf8",
    ),
  ) as { mannon: Record<string, Record<string, unknown>> };

  it("every key a block asks for exists", () => {
    const missing: string[] = [];

    for (const name of files) {
      const liquid = source(name);
      for (const match of liquid.matchAll(/'mannon\.([a-z_]+)\.([a-z_]+)'\s*\|\s*t/g)) {
        const [, group, key] = match;
        if (locale.mannon[group!]?.[key!] === undefined) {
          missing.push(`${name}: mannon.${group}.${key}`);
        }
      }
    }

    // A missing key renders as "translation missing: en.mannon…" on a
    // merchant's live storefront.
    expect(missing).toEqual([]);
  });

  it("no block hard-codes a sentence where a key belongs", () => {
    for (const name of files) {
      const liquid = source(name);
      // The strings the script needs are pulled through `| t | json`, never
      // written into the JavaScript directly.
      const inScript = liquid.split("<script>")[1] ?? "";
      expect(inScript).not.toMatch(/=\s*['"][A-Z][a-z]+ [a-z]+ [a-z]+/);
    }
  });
});
