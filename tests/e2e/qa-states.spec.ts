import { expect, test, type Page } from "@playwright/test";

/**
 * Captures the states this task is responsible for into /qa/0.1/.
 *
 * Only states that are genuinely reachable here are captured. The embedded
 * admin surfaces need a real Shopify session and the App Bridge CDN, neither
 * of which exists in CI or in the build sandbox — QA-REPORT.md records those
 * as open, not as passed.
 *
 * Run with: npx playwright test tests/e2e/qa-states.spec.ts
 */

const OUT = "qa/0.1";

async function blockAppBridge(page: Page) {
  await page.route("https://cdn.shopify.com/**", (route) => route.abort());
}

test.describe("QA state captures — task 0.1", () => {
  test("install page, desktop", async ({ page }) => {
    await blockAppBridge(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Install Mannon" })).toBeVisible();
    await page.screenshot({ path: `${OUT}/install-page-desktop.png`, fullPage: true });
  });

  test("install page, mobile", async ({ page }) => {
    await blockAppBridge(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Install Mannon" })).toBeVisible();
    // Built for Shopify: no horizontal scroll on mobile.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
    await page.screenshot({ path: `${OUT}/install-page-mobile.png`, fullPage: true });
  });

  test("install page, validation error", async ({ page }) => {
    await blockAppBridge(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "Install Mannon" }).click();
    await page.screenshot({
      path: `${OUT}/install-page-required-field.png`,
      fullPage: true,
    });
  });

  test("404 error state", async ({ page }) => {
    await blockAppBridge(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/definitely-not-a-page");
    await expect(page.locator("body")).toContainText("Page not found");
    await page.screenshot({ path: `${OUT}/error-404.png`, fullPage: true });
  });
});
