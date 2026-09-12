// Cold-read probes. Deliberately OUTSIDE tests/ so the committed suite stays green.
// Run from the repo root:
//   export TEST_DATABASE_URL='postgresql://mannon:mannon@localhost:5432/mannon_cr1?schema=public'
//   npx vitest run --config qa/1.1-1.2/cold-read/vitest.config.ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://mannon:mannon@localhost:5432/mannon_test?schema=public";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["qa/1.1-1.2/cold-read/**/*.test.ts"],
    globalSetup: ["./tests/support/global-setup.ts"],
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
