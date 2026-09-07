import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://mannon:mannon@localhost:5432/mannon_test?schema=public";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globalSetup: ["./tests/support/global-setup.ts"],
    include: ["tests/unit/**/*.test.{ts,tsx}", "tests/integration/**/*.test.{ts,tsx}"],
    // Integration tests share one Postgres schema and truncate between cases,
    // so they must not run concurrently with each other.
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
