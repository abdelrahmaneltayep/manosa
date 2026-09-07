import { expect, test, type Page } from "@playwright/test";

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
