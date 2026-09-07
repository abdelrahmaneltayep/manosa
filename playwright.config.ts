import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run start",
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      NODE_ENV: "production",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://mannon:mannon@localhost:5432/mannon_test?schema=public",
      SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY ?? "e2e-api-key",
      SHOPIFY_API_SECRET: process.env.SHOPIFY_API_SECRET ?? "e2e-api-secret",
      SHOPIFY_APP_URL: BASE_URL,
      SCOPES: "read_products",
    },
  },
});
