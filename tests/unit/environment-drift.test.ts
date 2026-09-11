import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ENVIRONMENT } from "~/lib/config/environment.server";

/**
 * The environment list, the code and `.env.example` agree.
 *
 * A list somebody keeps up to date is a registration step, and this repo has
 * now forgotten five of them (`CATALOG_ROOTS`, `qa:capture`'s file list, the
 * audit action picker, the ✦ chart menu, the privacy table list). This one
 * matters more than most: a variable the code reads and nobody documents is a
 * deployment that runs wrongly and says nothing, which is the whole reason
 * `environment.server.ts` exists.
 *
 * Found on its first run: `SHOPIFY_DISCOUNT_FUNCTION_ID` was read by the
 * pricing publisher and was in neither file.
 */

const ROOT = process.cwd();

/** Variables that are the runtime's own, or belong to the test harness. */
const NOT_OURS = new Set([
  "NODE_ENV",
  "PORT",
  "HOST",
  "CI",
  "SHOP_CUSTOM_DOMAIN",
  "E2E_SHOP_DOMAIN",
  "MANNON_AI_MODEL",
  "MANNON_EMAIL_FROM",
  "MANNON_EMAIL_TRANSPORT",
  "SHOPIFY_BILLING_TEST_MODE",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && statSync(path).isFile() ? [path] : [];
  });
}

const readEverywhere = new Set(
  sourceFiles(resolve(ROOT, "app"))
    .flatMap((path) => [
      ...readFileSync(path, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g),
    ])
    .map((match) => match[1]!)
    .filter((name) => !NOT_OURS.has(name)),
);

const example = readFileSync(resolve(ROOT, ".env.example"), "utf8");
const declared = new Set(ENVIRONMENT.map((one) => one.name));

describe("the environment list", () => {
  it("finds the variables at all, rather than matching nothing", () => {
    expect(readEverywhere.size).toBeGreaterThan(3);
  });

  it("names every variable the app actually reads", () => {
    const undocumented = [...readEverywhere].filter((name) => !declared.has(name));
    expect(undocumented).toEqual([]);
  });

  it("names nothing the app does not read", () => {
    // Except the two that are read by tooling rather than by `app/`: the
    // database URL is Prisma's, and the model key is read by the SDK client.
    const byTooling = new Set(["DATABASE_URL", "ANTHROPIC_API_KEY"]);
    const unread = [...declared].filter(
      (name) => !readEverywhere.has(name) && !byTooling.has(name),
    );
    expect(unread).toEqual([]);
  });

  it("appears in .env.example, which is the file somebody copies", () => {
    const missing = [...declared].filter(
      (name) => !new RegExp(`^${name}=`, "m").test(example),
    );
    expect(missing).toEqual([]);
  });
});
