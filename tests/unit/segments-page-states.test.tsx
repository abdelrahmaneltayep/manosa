import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SegmentsPage } from "~/components/customers/SegmentsPage";
import type { SegmentDraftView, SegmentsView } from "~/components/customers/types";
import type { Locale } from "~/i18n/config";
import { createCaptureHarness, type CaptureHarness } from "../support/state-capture";

/**
 * ✦ Segment builder — every state in checklist §3.
 *
 * The one that matters most is zero results: "No one matches — loosen which
 * condition?" with the tightest condition highlighted. A builder that says
 * "0 customers" and stops is a dead end a merchant cannot get out of.
 */

const OUT = resolve(process.cwd(), "qa/4.3");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Segments",
    outFor: () => OUT,
    dirs: [OUT],
  });
});

const draft = (overrides: Partial<SegmentDraftView> = {}): SegmentDraftView => ({
  name: "Big quiet buyers",
  chips: [
    { index: 0, label: "Spent over $5,000.00", loosen: false },
    { index: 1, label: "No order in 45 days", loosen: false },
  ],
  count: 84,
  samples: [
    { id: "c1", name: "Acme Ltd", email: "buyer@acme.test" },
    { id: "c2", name: "Bolt & Co", email: "trade@bolt.test" },
  ],
  payload: '{"sentence":"..."}',
  notes: null,
  clarifications: [],
  ...overrides,
});

const view = (overrides: Partial<SegmentsView> = {}): SegmentsView => ({
  aiAvailable: true,
  sentence: "",
  examples: [
    "Wholesale buyers who spent over 5,000 and have not ordered in 45 days.",
    "Gold group in Saudi Arabia, tax-exempt.",
    "Anyone approved who has never placed an order.",
  ],
  failure: null,
  draft: null,
  saveError: null,
  saved: [],
  ...overrides,
});

/* -------------------------------------------------------------------------- */

describe("composing", () => {
  it("offers an empty box and three examples", () => {
    const html = render(<SegmentsPage view={view()} />);

    expect(html).toContain("Segments");
    expect(html).toContain("Wholesale buyers who spent over 5,000");
    capture("20-segments-composing", html);
  });

  it("turns the composer off, and says why, with no key", () => {
    const html = render(<SegmentsPage view={view({ aiAvailable: false })} />);

    expect(html).toContain("Segments are switched off");
    expect(html).toMatch(/<s-text-field[^>]*disabled="true"/);
    expect(html).not.toContain('disabled="false"');
    capture("21-segments-no-key", html);
  });

  it("asks for a sentence when the box was empty", () => {
    const html = render(<SegmentsPage view={view({ failure: "empty" })} />);
    expect(html).toContain("Say who you mean");
  });

  it("says what happened when the model did not answer", () => {
    const html = render(<SegmentsPage view={view({ failure: "timeout" })} />);
    expect(html).toContain("Claude did not answer in time");
    capture("22-segments-timeout", html);
  });
});

describe("the draft", () => {
  it("shows the filters as chips, with a count and who is in it", () => {
    const html = render(<SegmentsPage view={view({ draft: draft() })} />);

    expect(html).toContain("Spent over $5,000.00");
    expect(html).toContain("No order in 45 days");
    expect(html).toContain("84 customers match");
    expect(html).toContain("Acme Ltd");
    capture("23-segments-draft", html);
  });

  it("offers a way to remove each chip", () => {
    const html = render(<SegmentsPage view={view({ draft: draft() })} />);
    // "Editable after generation" means editable without JavaScript.
    expect(html.match(/value="remove"/g)).toHaveLength(2);
    expect(html).toContain("Remove “Spent over $5,000.00”");
  });

  it("names the condition to loosen when nobody matches", () => {
    const html = render(
      <SegmentsPage
        view={view({
          draft: draft({
            count: 0,
            samples: [],
            chips: [
              { index: 0, label: "Spent over $5,000.00", loosen: true },
              { index: 1, label: "No order in 45 days", loosen: false },
            ],
          }),
        })}
      />,
    );

    expect(html).toContain("No one matches");
    expect(html).toContain("Loosen “Spent over $5,000.00”");
    capture("24-segments-empty", html);
  });

  it("will not let an empty segment be saved", () => {
    const html = render(
      <SegmentsPage view={view({ draft: draft({ count: 0, samples: [] }) })} />,
    );
    expect(html).toMatch(/<s-button[^>]*disabled="true"[^>]*>[^<]*Save segment/);
  });

  it("asks which group was meant, and holds the save until it is answered", () => {
    const html = render(
      <SegmentsPage
        view={view({
          draft: draft({
            count: null,
            samples: [],
            clarifications: [
              {
                index: 0,
                term: "Platinum",
                options: [{ id: "grp_gold", label: "Gold" }],
              },
            ],
          }),
        })}
      />,
    );

    expect(html).toContain("Which group did you mean");
    expect(html).toContain("Gold");
    expect(html).toMatch(/<s-button[^>]*disabled="true"[^>]*>[^<]*Save segment/);
    capture("25-segments-clarify", html);
  });

  it("says a name is taken rather than overwriting one", () => {
    const html = render(
      <SegmentsPage view={view({ draft: draft(), saveError: "duplicate_name" })} />,
    );
    expect(html).toContain("That name is taken");
    capture("26-segments-duplicate-name", html);
  });

  it("renders in Arabic", () => {
    const html = render(<SegmentsPage view={view({ draft: draft() })} />, "ar");
    expect(html).toContain("ما قرأه كلود");
    expect(html).not.toContain("What Claude read");
    capture("27-segments-arabic", html, "ar");
  });
});

describe("saved segments", () => {
  it("says there are none, rather than showing an empty table", () => {
    const html = render(<SegmentsPage view={view()} />);
    expect(html).toContain("No segments yet");
  });

  it("shows a count as of a date, never as live truth", () => {
    const html = render(
      <SegmentsPage
        view={view({
          saved: [
            {
              id: "seg1",
              name: "Big quiet buyers",
              conditionCount: 2,
              lastCount: 84,
              lastCountAt: "2026-06-01T12:00:00.000Z",
              fromSentence: true,
            },
            {
              id: "seg2",
              name: "Never ordered",
              conditionCount: 1,
              lastCount: null,
              lastCountAt: null,
              fromSentence: false,
            },
          ],
        })}
      />,
    );

    expect(html).toContain("84 as of 2026-06-01");
    expect(html).toContain("Not counted yet");
    expect(html).toContain("2 filters");
    capture("28-segments-saved", html);
  });
});
