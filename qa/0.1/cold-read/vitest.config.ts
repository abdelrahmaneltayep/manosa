import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://mannon:mannon@localhost:5432/mannon_test?schema=public";

export default defineConfig({
  root: "/home/user/manosa",
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globalSetup: ["/home/user/manosa/tests/support/global-setup.ts"],
    include: ["qa/0.1/cold-read/**/*.test.ts"],
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
