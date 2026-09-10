import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The same portability promise as the pricing engine, for the same reason: this
 * code runs inside a payment customization Function, in the admin, and — when the
 * storefront blocks land — in a browser bundle. One import of a Node built-in
 * breaks the first, and it would be found at deploy time.
 *
 * The one allowed import is `@mannon/pricing-engine`, which is itself pure and
 * is what keeps money in integer minor units on both sides.
 */

const SRC = resolve(import.meta.dirname, "../src");
const ALLOWED = new Set(["@mannon/pricing-engine"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const IMPORT_PATTERN = /(?:^|\n)\s*import\s[^;]*?from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(/;
const REQUIRE = /\brequire\s*\(/;

describe("net terms stay portable", () => {
  const files = sourceFiles(SRC);

  it("has source files to check", () => {
    expect(files.length).toBeGreaterThan(2);
  });

  it("imports nothing but its own modules and the pricing engine", () => {
    const foreign: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1]!;
        if (!specifier.startsWith(".") && !ALLOWED.has(specifier)) {
          foreign.push(`${file.replace(SRC, "src")} imports ${specifier}`);
        }
      }
    }

    expect(foreign).toEqual([]);
  });

  it("has no dynamic imports or require calls", () => {
    const dynamic = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return DYNAMIC_IMPORT.test(source) || REQUIRE.test(source);
    });
    expect(dynamic).toEqual([]);
  });

  it("declares no dependencies", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  /**
   * An invoice that is current at 23:59 and overdue at 00:01 without anything
   * having changed would be one nobody could explain. `now` is an argument
   * everywhere, so a ledger renders the same twice.
   */
  it("does not read the clock or roll dice", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of ["Date.now(", "new Date()", "Math.random(", "process."]) {
        if (source.includes(forbidden)) {
          offenders.push(`${file.replace(SRC, "src")} uses ${forbidden}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
