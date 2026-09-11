import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { TranslationsPage } from "~/components/settings/TranslationsPage";
import type { TranslationsView } from "~/components/settings/types";
import type { Locale } from "~/i18n/config";
import { createCaptureHarness, type CaptureHarness } from "../support/state-capture";

/** Settings → Translations, in every state it has. */

const OUT = resolve(process.cwd(), "qa/6.6");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Translations",
    outFor: () => OUT,
    dirs: [OUT],
  });
});

/* -------------------------------------------------------------------------- */

const view = (overrides: Partial<TranslationsView> = {}): TranslationsView => ({
  locale: "ar",
  locales: [
    { code: "en", name: "English" },
    { code: "ar", name: "Arabic" },
  ],
  search: "",
  unwrittenOnly: false,
  reviewOnly: false,
  filtered: false,

  rows: [
    {
      key: "forms.public.submit",
      shipped: "قدّم الطلب",
      value: null,
      needsReview: false,
      placeholders: [],
      error: null,
    },
    {
      key: "quotes.public.expiresOn",
      shipped: "هذا العرض ساري حتى {{date}}.",
      value: "صالح حتى {{date}}.",
      needsReview: false,
      placeholders: ["date"],
      error: null,
    },
    {
      key: "checkout.below_minimum_subtotal",
      shipped: "أضف {{gap}} لتبلغ الحد الأدنى {{required}} للطلب.",
      value: "يسعدنا انضمامك إلينا.",
      needsReview: true,
      placeholders: [],
      error: null,
    },
  ],
  total: 51,
  page: 1,
  pages: 3,
  nextHref: "/app/settings/translations?locale=ar&page=2",
  previousHref: null,

  imported: null,
  importIssue: null,

  fill: {
    pending: 48,
    filled: 0,
    locked: null,
    requiredPlan: null,
    failure: null,
    running: false,
  },
  ...overrides,
});

/* -------------------------------------------------------------------------- */

describe("the translations table", () => {
  it("says who wrote every string, and what Mannon ships", () => {
    const html = render(<TranslationsPage view={view()} />);

    // Invariant 5 for this feature: a suggestion a merchant cannot tell from
    // their own words is one they cannot decide about.
    expect(html).toContain("As Mannon ships it");
    expect(html).toContain("Your wording");
    expect(html).toContain("Claude suggested this");
    expect(html).toContain("Mannon ships: هذا العرض ساري حتى");
    capture("01-translations", html);
  });

  it("names the tags a translation has to keep", () => {
    const html = render(<TranslationsPage view={view()} />);

    // `{{days}}` dropped means a buyer reads "expires in days", i18next has
    // nothing to complain about, and nobody finds out.
    expect(html).toContain("Keep {{date}} exactly as written");
  });

  it("names what is edited elsewhere, rather than promising it here", () => {
    const html = render(<TranslationsPage view={view()} />);

    // The approval and rejection emails are per-form templates, not catalogue
    // strings — the body used to list them among what this page changes, which
    // is a merchant looking for something that was never here.
    expect(html).toContain("under Forms → Emails");
    expect(html).toContain("in the theme editor");
    expect(html).not.toMatch(/puts in front of a buyer[^<]*approval and rejection/u);
  });

  it("puts the error beside the string that caused it", () => {
    const html = render(
      <TranslationsPage
        view={view({
          rows: [
            {
              ...view().rows[1]!,
              value: "صالح لفترة.",
              error:
                "This has to keep the same {{…}} tags as Mannon's wording. Mannon fills them in, and a missing one reads as a gap to the buyer.",
            },
          ],
        })}
      />,
    );

    expect(html).toContain("has to keep the same");
    capture("02-translations-error", html);
  });

  it("says nothing matched the filters rather than nothing exists", () => {
    const html = render(
      <TranslationsPage
        view={view({ rows: [], total: 0, pages: 1, nextHref: null, filtered: true })}
      />,
    );

    expect(html).toContain("No string matches those filters");
    capture("03-translations-filtered-empty", html);
  });

  it("promises the suggestion is a suggestion, before it is pressed", () => {
    const html = render(<TranslationsPage view={view()} />);

    // A merchant deciding whether to press this needs to know the result
    // arrives marked, not live.
    expect(html).toContain("arrives marked as a suggestion");
    expect(html).toContain("48 strings are still in Mannon&#x27;s words");
  });

  it("says which of the three reasons ✦ is unavailable", () => {
    for (const [locked, phrase] of [
      ["permission", "switched off letting Claude draft"],
      ["plan", "needs the Pro plan"],
      ["no_key", "not connected to this store"],
    ] as const) {
      const html = render(
        <TranslationsPage
          view={view({
            fill: { ...view().fill, locked, requiredPlan: "Pro" },
          })}
        />,
      );
      expect(html, locked).toContain(phrase);
      // And writing every string by hand is still offered, in all three.
      if (locked !== "permission")
        expect(html).toContain("still write every string yourself");
    }

    const html = render(
      <TranslationsPage
        view={view({ fill: { ...view().fill, locked: "no_key", requiredPlan: null } })}
      />,
    );
    capture("04-translations-no-key", html);
  });

  it("says a suggestion arrived, and how many", () => {
    const html = render(
      <TranslationsPage view={view({ fill: { ...view().fill, filled: 25 } })} />,
    );

    expect(html).toContain("Claude suggested 25 strings");
    capture("05-translations-filled", html);
  });

  it("says what went wrong when a suggestion could not be written", () => {
    const html = render(
      <TranslationsPage view={view({ fill: { ...view().fill, failure: "timeout" } })} />,
    );

    expect(html).toContain("took too long and nothing was written");
    // This page's own copy, not the Buyer Agent's "so the agent can't answer".
    expect(html).not.toContain("nothing was sent");
    capture("06-translations-failed", html);
  });

  it("says what an import did, refusals and all", () => {
    const html = render(
      <TranslationsPage
        view={view({
          imported: {
            applied: 12,
            unchanged: 3,
            rejected: [
              { key: "quotes.public.expiresOn", reason: "placeholders" },
              { key: "settings.heading", reason: "unknownKey" },
              { key: "forms.public.submit", reason: "empty" },
            ],
          },
        })}
      />,
    );

    // A file whose wording was quietly refused, under a heading that says
    // "imported", is the merchant finding out from a buyer.
    expect(html).toContain("Imported 12 strings");
    expect(html).toContain("3 strings in the file already said exactly this");
    expect(html).toContain("3 strings were not imported");
    expect(html).toContain("changed the {{…}} tags");
    expect(html).toContain("not a string a merchant can change");
    capture("08-translations-imported", html);
  });

  it("says why a whole file was refused, and what to send instead", () => {
    const html = render(<TranslationsPage view={view({ importIssue: "wrongLocale" })} />);

    expect(html).toContain("That file is for a different language");
    capture("09-translations-import-refused", html);
  });

  it("reads right to left in Arabic", () => {
    const html = render(<TranslationsPage view={view()} />, "ar");
    expect(html).toContain("الترجمات");
    capture("07-translations-arabic", html, "ar");
  });
});
