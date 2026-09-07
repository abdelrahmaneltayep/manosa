import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import en from "~/i18n/locales/en.json";
import {
  NAV_PAGES,
  navHref,
  navLabelKey,
  pageDescriptionKey,
  routeFileFor,
} from "~/lib/nav/pages";

const lookup = (catalog: unknown, key: string) =>
  key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalog,
    );

/**
 * A nav entry pointing at a route file that does not exist is a 404 the
 * merchant finds before we do, and it cannot be caught by typecheck. This
 * keeps the sidebar, the router and the catalogs in step.
 */
describe("sidebar navigation", () => {
  it("lists all nine pages from the spec, in order", () => {
    expect(NAV_PAGES.map((page) => page.key)).toEqual([
      "home",
      "pricing",
      "customers",
      "forms",
      "orders",
      "storefrontAgent",
      "analytics",
      "settings",
      "plans",
    ]);
  });

  it("has exactly one home entry, and it is first", () => {
    expect(NAV_PAGES.filter((page) => page.path === "")).toHaveLength(1);
    expect(NAV_PAGES[0]?.path).toBe("");
  });

  it("points every entry at a route file that exists", () => {
    for (const page of NAV_PAGES) {
      const file = routeFileFor(page);
      expect(
        existsSync(resolve(process.cwd(), "app/routes", file)),
        `${page.key} -> app/routes/${file}`,
      ).toBe(true);
    }
  });

  it("has a label and a description in the catalog for every entry", () => {
    for (const page of NAV_PAGES) {
      expect(lookup(en, navLabelKey(page)), navLabelKey(page)).toBeTypeOf("string");
      expect(lookup(en, pageDescriptionKey(page)), pageDescriptionKey(page)).toBeTypeOf(
        "string",
      );
    }
  });

  it("builds hrefs under /app", () => {
    expect(navHref(NAV_PAGES[0]!)).toBe("/app");
    expect(navHref(NAV_PAGES[1]!)).toBe("/app/pricing");
  });

  it("uses a unique key per page", () => {
    const keys = NAV_PAGES.map((page) => page.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
