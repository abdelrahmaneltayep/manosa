import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Cold-read repro harness. Deliberately outside `tests/` so the committed suite
 * stays green; run it with:
 *   npx vitest run --config qa/0.3/cold-read/vitest.config.ts
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://mannon:mannon@localhost:5432/mannon_test?schema=public";

export default defineConfig({
  root: process.cwd(),
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globalSetup: ["./tests/support/global-setup.ts"],
    include: ["qa/0.3/cold-read/**/*.test.{ts,tsx}"],
    fileParallelism: false,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      NODE_ENV: "test",
      SHOPIFY_API_KEY: "test-api-key",
      SHOPIFY_API_SECRET: "test-api-secret",
      SHOPIFY_APP_URL: "https://mannon.test",
      SCOPES: "read_products",
    },
  },
});
