import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";

/**
 * The buyer-facing registration form, driven for real.
 *
 * Unlike the embedded admin, this is our own page on our own domain, so it can
 * actually be exercised in a browser — including with JavaScript switched off,
 * which is the state the checklist cares most about and the one a merchant's
 * applicants will meet.
 *
 * The form is seeded straight into the test database that the e2e server is
 * pointed at, because there is no Shopify session available to create one
 * through the admin.
 */

// These share one seeded form and clear its applications between cases, so
// they cannot run against each other. Parallelism across files still applies.
test.describe.configure({ mode: "serial" });

const db = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.TEST_DATABASE_URL ??
        "postgresql://mannon:mannon@localhost:5432/mannon_test?schema=public",
    },
  },
});

const SHOP = "e2e-forms.myshopify.com";
const PUBLIC_ID = "e2e-public-form";

/** Spam protection refuses a form filled in faster than a person could. */
const MIN_FILL_MS = 3000;

const FIELDS = {
  v: 1,
  fields: [
    {
      key: "first_name",
      kind: "text",
      label: "First name",
      required: true,
      showWhen: null,
    },
    { key: "email", kind: "email", label: "Email", required: true, showWhen: null },
    { key: "company", kind: "company", label: "Company", required: true, showWhen: null },
    {
      key: "business_type",
      kind: "select",
      label: "Type of business",
      required: true,
      options: ["Retailer", "Distributor"],
      showWhen: null,
    },
    {
      key: "licence_number",
      kind: "text",
      label: "Licence number",
      required: true,
      showWhen: { field: "business_type", equals: "Distributor" },
    },
    {
      key: "privacy",
      kind: "privacy",
      label: "I agree to the privacy policy",
      required: true,
      showWhen: null,
    },
  ],
};

const EMAILS = {
  confirmation: { subject: "Got it", body: "Hi {{first_name}}" },
  approved: { subject: "Welcome", body: "You are in" },
  rejected: { subject: "Sorry", body: "Not this time" },
  needs_info: { subject: "One more", body: "We need {{reason}}" },
};

test.beforeAll(async () => {
  await db.formSubmission.deleteMany({ where: { shop: SHOP } });
  await db.formEvent.deleteMany({ where: { shop: SHOP } });
  await db.registrationForm.deleteMany({ where: { shop: SHOP } });
  await db.shop.deleteMany({ where: { shop: SHOP } });

  await db.shop.create({
    data: { shop: SHOP, planKey: "pro", billingStatus: "ACTIVE", countryCode: "SA" },
  });
  await db.registrationForm.create({
    data: {
      shop: SHOP,
      name: "Wholesale application",
      slug: "wholesale",
      status: "LIVE",
      publicId: PUBLIC_ID,
      fields: FIELDS,
      appearance: { layout: "boxed", width: 640, font: "system" },
      emails: EMAILS,
      publish: { spamProtection: true, autoTags: [], autoGroupId: null, redirectUrl: "" },
    },
  });
});

test.afterAll(async () => {
  await db.$disconnect();
});

test.beforeEach(async () => {
  await db.formSubmission.deleteMany({ where: { shop: SHOP } });
});

/** Fails the test on any uncaught exception or rejected promise in the page. */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

async function fillIn(page: Page, email: string, type = "Retailer") {
  await page.getByLabel("First name").fill("Sam");
  await page.getByLabel("Email", { exact: false }).first().fill(email);
  await page.getByLabel("Company").fill("Acme Ltd");
  await page.getByLabel("Type of business").selectOption(type);
  await page.getByLabel("I agree to the privacy policy").check();
}

test.describe("with JavaScript", () => {
  test("renders the form and takes an application", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto(`/f/${PUBLIC_ID}`);

    await expect(
      page.getByRole("heading", { name: "Wholesale application" }),
    ).toBeVisible();
    await fillIn(page, "with-js@acme.test");

    // Spam protection refuses a form filled in faster than a person could, so
    // this waits it out rather than turning it off — the real path is the one
    // worth testing.
    await page.waitForTimeout(MIN_FILL_MS + 500);
    await page.getByRole("button", { name: "Send application" }).click();

    await expect(page.getByRole("heading")).toContainText("Thank you");

    const row = await db.formSubmission.findFirst({ where: { shop: SHOP } });
    expect(row?.email).toBe("with-js@acme.test");
    expect(row?.status).toBe("PENDING");
    expect(errors).toEqual([]);
  });

  test("a second application from the same address is told so", async ({ page }) => {
    await db.formSubmission.create({
      data: {
        shop: SHOP,
        formId: (await db.registrationForm.findFirstOrThrow({ where: { shop: SHOP } }))
          .id,
        email: "already@acme.test",
        answers: {},
        status: "PENDING",
      },
    });

    await page.goto(`/f/${PUBLIC_ID}`);
    await fillIn(page, "already@acme.test");
    await page.waitForTimeout(MIN_FILL_MS + 500);
    await page.getByRole("button", { name: "Send application" }).click();

    await expect(page.locator("body")).toContainText("already applied");
    // And not a second row.
    expect(await db.formSubmission.count({ where: { shop: SHOP } })).toBe(1);
  });

  test("a form submitted in milliseconds is dropped, and the buyer is not told why", async ({
    page,
  }) => {
    await page.goto(`/f/${PUBLIC_ID}`);
    await fillIn(page, "bot@spam.test");
    // No wait: this is what a script does.
    await page.getByRole("button", { name: "Send application" }).click();

    // Told it worked. Naming the signal that caught it is free tuning for the
    // next run.
    await expect(page.getByRole("heading")).toContainText("Thank you");

    const row = await db.formSubmission.findFirst({ where: { shop: SHOP } });
    // Kept, not discarded: a real buyer wrongly caught is a lost customer.
    expect(row?.status).toBe("SPAM");
    expect(row?.spamReason).toBe("too_fast");
  });
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the form renders and submits", async ({ page }) => {
    await page.goto(`/f/${PUBLIC_ID}`);
    await expect(
      page.getByRole("heading", { name: "Wholesale application" }),
    ).toBeVisible();

    await fillIn(page, "no-js@acme.test");
    await page.waitForTimeout(MIN_FILL_MS + 500);
    await page.getByRole("button", { name: "Send application" }).click();

    await expect(page.getByRole("heading")).toContainText("Thank you");
    expect((await db.formSubmission.findFirst({ where: { shop: SHOP } }))?.email).toBe(
      "no-js@acme.test",
    );
  });

  test("errors come back with a summary, and keep what was typed", async ({ page }) => {
    await page.goto(`/f/${PUBLIC_ID}`);

    await page.getByLabel("First name").fill("Sam");
    await page.getByLabel("Email", { exact: false }).first().fill("not-an-email");
    await page.getByLabel("Type of business").selectOption("Retailer");
    await page.waitForTimeout(MIN_FILL_MS + 500);
    await page.getByRole("button", { name: "Send application" }).click();

    const summary = page.getByRole("alert");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("does not look like an email address");
    await expect(summary).toContainText("Company is needed");

    // Losing what a buyer typed because one field was wrong is how an
    // application becomes an abandoned one.
    await expect(page.getByLabel("First name")).toHaveValue("Sam");
    await expect(page.getByLabel("Email", { exact: false }).first()).toHaveValue(
      "not-an-email",
    );
    // The summary links to the field.
    await expect(page.locator('a[href="#field-email"]')).toBeVisible();

    expect(await db.formSubmission.count({ where: { shop: SHOP } })).toBe(0);
  });

  test("a field its condition excludes is not required", async ({ page }) => {
    // Without JavaScript every field is on the page, including the one a
    // condition would have hidden. The server must not ask for it.
    await page.goto(`/f/${PUBLIC_ID}`);
    await expect(page.getByLabel("Licence number")).toBeVisible();

    await fillIn(page, "retailer@acme.test", "Retailer");
    await page.waitForTimeout(MIN_FILL_MS + 500);
    await page.getByRole("button", { name: "Send application" }).click();

    await expect(page.getByRole("heading")).toContainText("Thank you");
  });

  test("and is required once its condition holds", async ({ page }) => {
    await page.goto(`/f/${PUBLIC_ID}`);
    await fillIn(page, "distributor@acme.test", "Distributor");
    await page.waitForTimeout(MIN_FILL_MS + 500);
    await page.getByRole("button", { name: "Send application" }).click();

    await expect(page.getByRole("alert")).toContainText("Licence number is needed");
  });

  test("a page view is counted, and the thank-you page is not", async ({ page }) => {
    const form = await db.registrationForm.findFirstOrThrow({ where: { shop: SHOP } });
    await db.formEvent.deleteMany({ where: { shop: SHOP } });

    await page.goto(`/f/${PUBLIC_ID}`);
    await page.goto(`/f/${PUBLIC_ID}?s=thanks`);

    const views = await db.formEvent.count({
      where: { shop: SHOP, formId: form.id, kind: "VIEW" },
    });
    // Counting the thank-you page as a view would make the conversion rate
    // fall every time somebody converted.
    expect(views).toBe(1);
  });
});

test("an unknown form id is a 404, not a blank page", async ({ page }) => {
  const response = await page.goto("/f/definitely-not-a-form");
  expect(response?.status()).toBe(404);
  await expect(page.locator("body")).toContainText("Page not found");
});

test("only the merchant's own storefront may frame the form", async ({ request }) => {
  const response = await request.get(`/f/${PUBLIC_ID}`);
  const csp = response.headers()["content-security-policy"] ?? "";

  expect(csp).toContain("frame-ancestors");
  expect(csp).toContain(`https://${SHOP}`);
  // The admin's own CSP would forbid the merchant's theme from framing it.
  expect(csp).not.toContain("admin.shopify.com");
});

test.describe("layout", () => {
  const overflows = (page: Page) =>
    page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );

  for (const [name, path] of [
    ["English", `/f/${PUBLIC_ID}`],
    ["Arabic", `/f/${PUBLIC_ID}?locale=ar`],
  ] as const) {
    test(`${name} does not scroll sideways on desktop`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);
      expect(await overflows(page)).toBe(false);
    });

    test(`${name} does not scroll sideways on mobile`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(path);
      expect(await overflows(page)).toBe(false);
    });
  }

  test("Arabic mirrors the document", async ({ page }) => {
    await page.goto(`/f/${PUBLIC_ID}?locale=ar`);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("button", { name: "إرسال الطلب" })).toBeVisible();
  });
});

test("the public form does not load App Bridge", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));

  await page.goto(`/f/${PUBLIC_ID}`);

  // It cannot work outside the admin iframe, and it is a third-party script on
  // a page a member of the public is looking at.
  expect(requested.filter((url) => url.includes("app-bridge"))).toEqual([]);
});
