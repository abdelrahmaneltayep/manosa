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

  test("one Save carries every row on the page, not just one", async ({ page }) => {
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

    const save = bodies.find((body) => body.intent === "save");
    expect(save).toBeDefined();
    expect(save!.locale).toBe("ar");

    // Every row in the capture is in the one body. Per-row forms meant a
    // merchant who edited five rows and pressed Save on one lost the other
    // four with nothing said about it.
    const was = Object.keys(save!).filter((field) => field.startsWith("was:"));
    expect(was.sort()).toEqual([
      "was:checkout.below_minimum_subtotal",
      "was:forms.public.submit",
      "was:quotes.public.expiresOn",
    ]);

    // The wording fields are `s-text-area`s, and an `s-*` element only joins a
    // form once Polaris upgrades it — which needs the CDN this sandbox cannot
    // reach. So they are checked as markup, and what a merchant's typing
    // actually posts stays one of the things a capture cannot prove.
    const areas = await page.locator("form s-text-area[name^='value:']").count();
    expect(areas).toBe(was.length);
    // And the accept control rides in the same form rather than a nested one.
    expect(await page.locator("form s-checkbox[name^='accept:']").count()).toBe(1);
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
    // Four in total: filters, fill, import, and the one Save for the table. A
    // fifth would mean a form nested inside another and folded by the parser.
    expect(intents).toHaveLength(4);
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
