import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The engine's portability is a promise, not a preference: the same code has to
 * run inside a Shopify Function, in a browser bundle on the storefront, and on
 * the server. One `import` of a Node built-in or an npm package quietly breaks
 * one of those three, and it would be found at deploy time.
 */

const SRC = resolve(import.meta.dirname, "../src");

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

describe("the engine stays portable", () => {
  const files = sourceFiles(SRC);

  it("has source files to check", () => {
    expect(files.length).toBeGreaterThan(4);
  });

  it("imports nothing but its own modules", () => {
    const foreign: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1]!;
        if (!specifier.startsWith(".")) {
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
   * Reaching for the clock or randomness inside a resolver would make the same
   * input produce different prices, which is the one thing this package must
   * never do. Time comes in through `context.now`.
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
