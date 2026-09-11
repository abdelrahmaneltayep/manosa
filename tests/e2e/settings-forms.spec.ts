import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

/**
 * What each Settings section actually posts, in a browser.
 *
 * Every other test on this page asserts against the HTML *string*. A string
 * can contain a `<form>` that no browser will ever build: a form nested inside
 * another form is not legal HTML, so the parser drops the inner start tag and
 * its inputs join the outer form. That is exactly what shipped — the
 * Notifications section's "Check the records" form collapsed into the section
 * form, so pressing **Save** posted `intent=verify` and the route answered
 * with an unhandled 501. The section could not be saved at all, and fifteen
 * passing assertions said nothing about it.
 *
 * So this drives the real parser: it counts the forms the browser builds and
 * reads back the body each one would submit.
 */

const CAPTURE = resolve(process.cwd(), "qa/6.4/01-settings.html");

/** The six saveable sections, in page order. */
const SECTIONS = ["wholesale", "display", "discounts", "tax", "orders", "notifications"];

test.describe("the Settings forms, as a browser builds them", () => {
  test.skip(!existsSync(CAPTURE), "run `npm run qa:capture` first");

  test("every section is its own form, and posts only its own section", async ({
    page,
  }) => {
    await page.goto(pathToFileURL(CAPTURE).href);

    const bodies = await page.evaluate(() =>
      [...document.forms].map((form) =>
        [...new FormData(form).entries()].map(([key, value]) => `${key}=${value}`),
      ),
    );

    // Six sections plus the danger zone's own form. A missing one means a
    // nested form was folded into its parent.
    const sectionForms = bodies.filter((body) =>
      body.some((field) => field.startsWith("section=")),
    );
    expect(sectionForms.length).toBeGreaterThanOrEqual(SECTIONS.length);

    for (const section of SECTIONS) {
      const own = sectionForms.filter((body) => body.includes(`section=${section}`));
      expect(own, `${section}: no form posts it`).toHaveLength(1);

      // Exactly one `section`, and no stray intent riding along — an intent in
      // a save body is how Save became Verify.
      const names = own[0]!.map((field) => field.split("=")[0]);
      expect(names.filter((name) => name === "section")).toHaveLength(1);
      expect(names, `${section}: carries an intent`).not.toContain("intent");
    }
  });

  test("pausing carries its confirmation, and nothing else does", async ({ page }) => {
    const confirm = resolve(process.cwd(), "qa/6.4/10-danger-confirm.html");
    test.skip(!existsSync(confirm), "run `npm run qa:capture` first");

    await page.goto(pathToFileURL(confirm).href);

    const danger = await page.evaluate(() =>
      [...document.forms]
        .map((form) => [...new FormData(form).entries()].map(([k, v]) => `${k}=${v}`))
        .find((body) => body.includes("section=danger")),
    );

    expect(danger).toBeDefined();
    expect(danger).toContain("intent=pause");
    // The route refuses a pause without it, so a plain POST cannot pause a
    // shop with nothing asked.
    expect(danger).toContain("confirm=pause");
  });

  test("no checkbox relies on an undocumented default value", async ({ page }) => {
    await page.goto(pathToFileURL(CAPTURE).href);

    const missing = await page.evaluate(() =>
      [...document.querySelectorAll("s-checkbox[name]")]
        .filter((box) => !box.getAttribute("value"))
        .map((box) => box.getAttribute("name")),
    );

    // Polaris documents no default for `s-checkbox`'s submitted value, and the
    // reader tests presence rather than the string "on" — but an explicit
    // value keeps the two from ever disagreeing.
    expect(missing).toEqual([]);
  });
});
