import { describe, expect, it } from "vitest";

import { expectNoRawCatalogKeys } from "../support/state-capture";

/**
 * The guard that reads every capture.
 *
 * It exists because i18next falls back to the key when it cannot resolve one,
 * and `forms.submit` in the middle of a page is invisible to anyone skimming a
 * screenshot. Settings → Translations shows keys on purpose, so the guard
 * gained an opt-out — and an opt-out nobody tests is how a safety net every
 * capture in the repo relies on gets switched off by accident.
 */

const fails = (html: string) => {
  try {
    expectNoRawCatalogKeys(html, "under-test");
    return false;
  } catch {
    return true;
  }
};

describe("the raw-key guard", () => {
  it("catches a key that leaked into the page as text", () => {
    expect(fails("<s-paragraph>forms.submit</s-paragraph>")).toBe(true);
  });

  it("lets prose containing a full stop through", () => {
    expect(fails("<s-paragraph>Two forms. Both open.</s-paragraph>")).toBe(false);
  });

  it("exempts only the text of the element that opted out", () => {
    expect(fails('<s-text data-string-key="forms.submit">forms.submit</s-text>')).toBe(
      false,
    );
  });

  it("still catches a leak elsewhere on a page that shows keys on purpose", () => {
    // The one that matters: the Translations page is exactly where a real
    // fallback would be easiest to miss, because keys belong there.
    expect(
      fails(
        '<s-text data-string-key="forms.submit">forms.submit</s-text>' +
          "<s-paragraph>quotes.expiresIn</s-paragraph>",
      ),
    ).toBe(true);
  });

  it("does not let an opted-out element exempt its siblings", () => {
    expect(
      fails(
        '<s-text data-string-key="forms.submit">forms.submit</s-text><s-badge>agent.failure.timeout</s-badge>',
      ),
    ).toBe(true);
  });
});
