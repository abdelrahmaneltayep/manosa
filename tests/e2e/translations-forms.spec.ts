import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

/**
 * What the Translations page actually posts, in a browser.
 *
 * This page has more forms than any other in the app — one per row, plus the
 * filters, the ✦ fill and the import — and 6.4 shipped a page whose Save
 * button posted another form's intent because a `<form>` sat inside a `<form>`
 * and the parser folded it. A string assertion cannot see that. So this drives
 * the real parser over the capture and reads back what each form would send.
 */

const CAPTURE = resolve(process.cwd(), "qa/6.6/01-translations.html");

test.describe("the Translations forms, as a browser builds them", () => {
  test.skip(!existsSync(CAPTURE), "run `npm run qa:capture` first");

  test("every row saves itself, and nothing else", async ({ page }) => {
    await page.goto(pathToFileURL(CAPTURE).href);

    const bodies = await page.evaluate(() =>
      [...document.forms].map((form) =>
        Object.fromEntries(
          [...new FormData(form).entries()].map(([key, value]) => [
            key,
            value instanceof File ? `file:${value.name}` : value,
          ]),
        ),
      ),
    );

    const saves = bodies.filter((body) => body.intent === "save");
    // Three rows in the capture, three save forms: one folded into another
    // would show up here as two.
    expect(saves).toHaveLength(3);
    expect(saves.map((body) => body.key)).toEqual([
      "forms.submit",
      "quotes.expiresIn",
      "approval.welcome",
    ]);
    for (const body of saves) {
      expect(body.locale).toBe("ar");
      // Exactly the hidden fields this row owns. A row that also carried a
      // second row's key would overwrite the wrong string.
      //
      // `value` is absent here and that is the environment, not the page: the
      // wording is an `s-text-area`, and an `s-*` element only joins a form
      // once Polaris upgrades it — which needs the CDN this sandbox cannot
      // reach. So it is checked as markup, below, and what a merchant's typing
      // actually posts is one of the things a capture cannot prove.
      expect(Object.keys(body).sort()).toEqual(["intent", "key", "locale"]);
    }

    // One wording field per row, named the same thing the action reads.
    const areas = await page.locator("form s-text-area[name=value]").count();
    expect(areas).toBe(saves.length);
  });

  test("the fill and the import are their own forms, each with its own intent", async ({
    page,
  }) => {
    await page.goto(pathToFileURL(CAPTURE).href);

    const intents = await page.evaluate(() =>
      [...document.forms].map(
        (form) => (new FormData(form).get("intent") as string | null) ?? "(none)",
      ),
    );

    // The filters form is a GET and carries no intent; everything else names
    // exactly what it does.
    expect(intents.filter((intent) => intent === "fill")).toHaveLength(1);
    expect(intents.filter((intent) => intent === "import")).toHaveLength(1);
    expect(intents.filter((intent) => intent === "(none)")).toHaveLength(1);
  });

  test("the import form can carry a file at all", async ({ page }) => {
    await page.goto(pathToFileURL(CAPTURE).href);

    // `enctype` is the whole of it: a multipart form posted as urlencoded
    // sends the file's *name* and nothing else, and the route reads an empty
    // body while the page says a file was uploaded.
    const form = page.locator("form").filter({ has: page.locator("input[type=file]") });
    await expect(form).toHaveAttribute("enctype", "multipart/form-data");
    await expect(form.locator("input[name=file]")).toHaveAttribute("accept", /json/);
  });
});
