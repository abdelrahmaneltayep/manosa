import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every raw SQL statement filters by shop itself.
 *
 * The tenant guard rewrites a `where` and stamps a `create`, and it cannot do
 * either to an opaque SQL string: `$queryRaw` and `$executeRaw` carry no model,
 * so the model hook never sees them. The guard now refuses to run raw SQL with
 * no tenant at all — but inside a scope it can only take the statement on
 * trust, and "the author remembered" is exactly the control ADR 0002 says must
 * not be the only one.
 *
 * So the control is here: every raw statement in `app/` names `shop` in its own
 * `WHERE`. A new one that forgets fails the build rather than quietly reading
 * or deleting every merchant's rows.
 */

const APP = resolve(process.cwd(), "app");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && statSync(path).isFile() ? [path] : [];
  });
}

/** A raw call and the statement it carries, up to its closing backtick. */
const RAW =
  /\$(?:queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)\s*(?:`([^`]*)`|\(([^)]*)\))/g;

interface RawCall {
  file: string;
  statement: string;
}

const calls: RawCall[] = sourceFiles(APP)
  // The guard itself names the operations; it issues none.
  .filter((path) => !path.endsWith("shop-scope.server.ts"))
  .flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return [...source.matchAll(RAW)].map((match) => ({
      file: path.replace(`${process.cwd()}/`, ""),
      statement: (match[1] ?? match[2] ?? "").replace(/\s+/g, " ").trim(),
    }));
  });

describe("raw SQL", () => {
  it("is rare, and this test can still find it", () => {
    // If the regex stops matching, this guard stops guarding.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThan(12);
  });

  it("names shop in every statement that touches a shop-scoped table", () => {
    const unscoped = calls
      // `SELECT 1` and the like touch no table and carry no rows.
      .filter((call) => /\b(FROM|UPDATE|DELETE\s+FROM|INTO)\s+"/i.test(call.statement))
      .filter((call) => !/"shop"\s*=/i.test(call.statement))
      .map((call) => `${call.file}: ${call.statement.slice(0, 80)}`);

    expect(unscoped).toEqual([]);
  });

  it("never interpolates a shop that did not come from the scope", () => {
    // `${shop}` must be the tenant, not something a caller passed in. Every
    // current call site reads it from `shopScope.require(...)`.
    for (const call of calls) {
      if (!/"shop"\s*=/i.test(call.statement)) continue;
      const source = readFileSync(resolve(process.cwd(), call.file), "utf8");
      expect(source, call.file).toMatch(/shopScope\.require\(/);
    }
  });
});
