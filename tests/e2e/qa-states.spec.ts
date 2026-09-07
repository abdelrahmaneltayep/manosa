import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

const OUT = process.env.QA_TASK_DIR ?? "qa/0.2";

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

  test("install page, Arabic RTL", async ({ page }) => {
    await blockAppBridge(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/?locale=ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.screenshot({ path: `${OUT}/install-page-arabic-rtl.png`, fullPage: true });
  });

  test("install page, Arabic RTL on mobile", async ({ page }) => {
    await blockAppBridge(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?locale=ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
    await page.screenshot({
      path: `${OUT}/install-page-arabic-rtl-mobile.png`,
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

/**
 * Screenshot the Plans page states rendered by
 * tests/unit/plans-page-states.test.tsx. Generate the HTML first:
 *
 *   QA_CAPTURE=1 npx vitest run tests/unit/plans-page-states.test.tsx
 *
 * These are structure-only: Polaris web components cannot be loaded in this
 * environment, so the styling is a stand-in and each capture says so.
 */
test.describe("Plans page states", () => {
  const dir = resolve(process.cwd(), "qa/0.3");
  const states = existsSync(dir)
    ? readdirSync(dir).filter((file) => file.endsWith(".html"))
    : [];

  for (const file of states) {
    test(`plans: ${file.replace(/\.html$/, "")}`, async ({ page }) => {
      await page.setViewportSize({ width: 1100, height: 900 });
      await page.goto(pathToFileURL(resolve(dir, file)).href);
      await page.screenshot({
        path: resolve(dir, file.replace(/\.html$/, ".png")),
        fullPage: true,
      });
    });
  }

  test("the captures exist at all", () => {
    expect(states.length, "run the vitest capture step first").toBeGreaterThan(0);
  });
});
