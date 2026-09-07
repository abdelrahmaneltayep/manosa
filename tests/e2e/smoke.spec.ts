import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/** Read rather than import: Playwright's ESM loader wants an import attribute. */
const en = JSON.parse(
  readFileSync(resolve(process.cwd(), "app/i18n/locales/en.json"), "utf8"),
) as { app: { name: string }; install: Record<string, string> };

/**
 * App Bridge is served from Shopify's CDN and is only meaningful inside the
 * admin iframe. Blocking it keeps the smoke test hermetic — it must pass on a
 * machine with no network — and proves the unembedded pages do not depend on it.
 */
async function blockAppBridge(page: Page) {
  await page.route("https://cdn.shopify.com/**", (route) => route.abort());
}

/** Fails the test on any uncaught exception or rejected promise in the page. */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

test("healthz reports the service is up", async ({ request }) => {
  const response = await request.get("/healthz");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  await expect.poll(async () => (await response.json()).status).toBe("ok");
});

test("the install page renders and asks for a store domain", async ({ page }) => {
  await blockAppBridge(page);
  const errors = trackPageErrors(page);

  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "B2B wholesale pricing",
  );
  const shopInput = page.getByLabel("Your store domain");
  await expect(shopInput).toBeVisible();
  await expect(shopInput).toHaveAttribute("placeholder", "my-store.myshopify.com");
  await expect(page.getByRole("button", { name: "Install Mannon" })).toBeVisible();

  expect(errors).toEqual([]);
});

test("the install form posts to the Shopify login flow", async ({ page }) => {
  await blockAppBridge(page);
  await page.goto("/");

  const form = page.locator("form");
  await expect(form).toHaveAttribute("action", "/auth/login");
  await expect(form).toHaveAttribute("method", "post");
});

test("the embedded app refuses an unauthenticated request", async ({ request }) => {
  // No session and no shop parameter: shopify-app-remix must reject this rather
  // than render the admin surface to a stranger.
  const response = await request.get("/app", { maxRedirects: 0 });
  expect(response.status()).not.toBe(200);
});

test("an unknown route renders the error state, not a stack trace", async ({ page }) => {
  await blockAppBridge(page);
  const response = await page.goto("/definitely-not-a-page");

  expect(response?.status()).toBe(404);
  await expect(page.locator("body")).toContainText("Page not found");
  await expect(page.locator("body")).not.toContainText("at Object.");
});

test("renders Arabic right-to-left when the admin asks for it", async ({ page }) => {
  await blockAppBridge(page);
  const errors = trackPageErrors(page);

  // Shopify puts the staff member's admin language on every embedded request.
  await page.goto("/?locale=ar");

  const html = page.locator("html");
  await expect(html).toHaveAttribute("lang", "ar");
  await expect(html).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("button", { name: "تثبيت مانون" })).toBeVisible();

  // Regression: a hardcoded string that never made it into the catalog renders
  // in English on an otherwise Arabic page, and nothing in the type system or
  // the unit tests notices. Assert the English copy is simply absent.
  const body = await page.locator("body").innerText();
  for (const englishOnly of Object.values(en.install)) {
    if (englishOnly === en.install.shopPlaceholder) continue; // a domain, not prose
    expect(
      body,
      `untranslated string on the Arabic page: "${englishOnly}"`,
    ).not.toContain(englishOnly);
  }
  expect(body).not.toContain(en.app.name);

  // Mirroring must not push content off the side.
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
  expect(errors).toEqual([]);
});

test("falls back to English for a language Mannon does not ship", async ({ page }) => {
  await blockAppBridge(page);
  await page.goto("/?locale=de");

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
});

test("the webhook endpoint rejects an unsigned POST", async ({ request }) => {
  const response = await request.post("/webhooks/app/uninstalled", {
    headers: { "X-Shopify-Topic": "app/uninstalled" },
    data: { shop_domain: "attacker.myshopify.com" },
  });
  // 400 for missing signature headers, 401 for a signature that does not match.
  // The wrong-secret and forged-body cases are asserted precisely in
  // tests/integration/webhooks.test.ts; what matters here is that an unsigned
  // request never reaches a handler.
  expect([400, 401]).toContain(response.status());
});

test("the job runner endpoint is not open to the world", async ({ request }) => {
  const response = await request.post("/internal/jobs/run");
  // 401 when a token is configured, 503 when it is not. Never 200.
  expect([401, 503]).toContain(response.status());
});

/**
 * Regression: the server-side i18n provider was once missing, so the document
 * arrived in English and only became Arabic after hydration. Every JS-enabled
 * test passed. Rendering with JavaScript off is what catches it — and it is
 * also the state a slow connection sees for the first few hundred milliseconds,
 * which for an RTL layout is a visible flip and a CLS failure.
 */
test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the server renders Arabic, not English waiting to be replaced", async ({
    page,
  }) => {
    await blockAppBridge(page);
    await page.goto("/?locale=ar");

    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("h1")).toContainText("تسعير الجملة للشركات");

    const body = await page.locator("body").innerText();
    expect(body).not.toContain(en.install.headingLead);
    expect(body).not.toContain(en.app.name);
  });

  test("the install form still works without JS", async ({ page }) => {
    await blockAppBridge(page);
    await page.goto("/");

    await expect(page.getByLabel("Your store domain")).toBeVisible();
    await expect(page.locator("form")).toHaveAttribute("action", "/auth/login");
  });
});
