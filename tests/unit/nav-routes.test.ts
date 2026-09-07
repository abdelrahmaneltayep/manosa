import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { NAV_PAGES, navHref } from "~/lib/nav/pages";

/**
 * A nav entry pointing at a route file that does not exist is a 404 the
 * merchant finds before we do, and it cannot be caught by typecheck. This
 * keeps the sidebar and the router in step.
 */
describe("sidebar navigation", () => {
  it("lists all nine pages from the spec, in order", () => {
    expect(NAV_PAGES.map((page) => page.defaultLabel)).toEqual([
      "Home",
      "Pricing",
      "Customers",
      "Forms",
      "Orders",
      "Storefront Agent",
      "Analytics",
      "Settings",
      "Plans",
    ]);
  });

  it("has exactly one home entry, and it is first", () => {
    const homes = NAV_PAGES.filter((page) => page.path === "");
    expect(homes).toHaveLength(1);
    expect(NAV_PAGES[0]?.path).toBe("");
  });

  it("points every entry at a route file that exists", () => {
    for (const page of NAV_PAGES) {
      const file = page.path ? `app.${page.path}.tsx` : "app._index.tsx";
      expect(
        existsSync(resolve(process.cwd(), "app/routes", file)),
        `${page.defaultLabel} -> app/routes/${file}`,
      ).toBe(true);
    }
  });

  it("builds hrefs under /app", () => {
    expect(navHref(NAV_PAGES[0]!)).toBe("/app");
    expect(navHref(NAV_PAGES[1]!)).toBe("/app/pricing");
  });

  it("uses a unique i18n key per page", () => {
    const keys = NAV_PAGES.map((page) => page.i18nKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
