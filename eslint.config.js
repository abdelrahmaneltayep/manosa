import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "build/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "app/generated/**",
      ".shopify/**",
      // QA artefacts: captures, reports, and the probe files a cold read
      // writes to demonstrate a finding. Deliberately outside `tests/` so the
      // committed suite stays green; not application code, and not linted.
      "qa/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // The whole point of the tenant guard is that nothing bypasses it.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@prisma/client",
              importNames: ["PrismaClient"],
              message:
                "Import the shop-scoped client from ~/db.server instead. If you truly need an unscoped query, use withoutShopScope() and say why.",
            },
          ],
        },
      ],
    },
  },
  {
    // db.server.ts is the one place allowed to construct the raw client.
    files: ["app/db.server.ts", "app/lib/tenant/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // End-to-end specs run outside the app, against the built server. They
    // seed fixtures the way an operator would, so they need an unscoped
    // client — the guard is on application code, which is where it matters.
    files: ["tests/e2e/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // The pricing engine has to run inside a Shopify Function and in a browser
    // bundle, so it must not reach into the app or pull in a dependency.
    // packages/pricing-engine/test/purity.test.ts enforces the same thing at
    // runtime; this catches it while you type.
    files: ["packages/pricing-engine/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["~/*", "@prisma/client", "@shopify/*", "@remix-run/*", "react*"],
              message:
                "The pricing engine is pure and dependency-free — it runs in a Shopify Function and in the browser. Pass what it needs in through the context.",
            },
          ],
        },
      ],
    },
  },
);
