import { describe, expect, it } from "vitest";

import { isSection, SECTIONS } from "~/lib/settings/settings.server";

/**
 * The part of settings that is pure: which sections exist, and what a form
 * body is allowed to name. Everything that reads or writes a shop lives in
 * `tests/integration/settings.test.ts`, against the real writer.
 */

describe("settings sections", () => {
  it("accepts only the sections the page renders", () => {
    for (const section of SECTIONS) expect(isSection(section)).toBe(true);
  });

  it("refuses anything else, including the danger zone", () => {
    // "danger" is handled by its own branch in the action, with a confirm and
    // a redirect. Letting it through `saveSettings` would mean a plain POST
    // could pause a shop with no confirmation at all.
    for (const value of ["danger", "", "shop", "__proto__", "wholesale "]) {
      expect(isSection(value), value).toBe(false);
    }
  });
});
