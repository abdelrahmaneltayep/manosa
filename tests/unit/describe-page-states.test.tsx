import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { DescribeRulePage } from "~/components/pricing/DescribeRulePage";
import type {
  DescribeRuleView,
  DraftCardView,
  MarginGuardView,
} from "~/components/pricing/types";
import type { Locale } from "~/i18n/config";
import { createCaptureHarness, type CaptureHarness } from "../support/state-capture";

/**
 * Every state of ✦ Describe a rule, from checklist §2.
 *
 * composing → draft for review → approve / edit / discard, plus the three that
 * matter most and are easiest to skip: the ambiguous term, the below-cost
 * warning, and the store with no API key, where the composer is off and the
 * manual builder is untouched.
 */

const OUT = resolve(process.cwd(), "qa/4.2");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Describe a rule",
    outFor: () => OUT,
    dirs: [OUT],
  });
});

const card = (overrides: Partial<DraftCardView> = {}): DraftCardView => ({
  name: "Wholesale volume tiers",
  kindLabel: "Volume tiers",
  chips: ["10–49 · 5% off", "50+ · 12% off"],
  targetsSummary: "Every product, minus exclusions",
  audienceSummary: "Tagged wholesale",
  scheduleSummary: null,
  combinable: false,
  notes: "Excluded the Sale collection, as you asked.",
  payload: '{"sentence":"..."}',
  builderFields: [{ name: "name", value: "Wholesale volume tiers" }],
  ...overrides,
});

const view = (overrides: Partial<DescribeRuleView> = {}): DescribeRuleView => ({
  aiAvailable: true,
  sentence: "",
  examples: [
    "Buy 10 get 5%, buy 50 get 12%, only for customers tagged wholesale, exclude sale items.",
    "Gold group pays 30% off everything, from the first of next month.",
    "Free-shipping tier: 10% off any order over 2,000.",
  ],
  failure: null,
  draft: null,
  clarifications: [],
  margin: null,
  approveAnywayRequired: false,
  approveAnywayMissing: false,
  atRuleLimit: false,
  ...overrides,
});

const clean: MarginGuardView = {
  status: "checked",
  checked: 42,
  costUnknown: 0,
  sampled: false,
  belowCostCount: 0,
  worst: [],
};

const losing: MarginGuardView = {
  status: "checked",
  checked: 42,
  costUnknown: 3,
  sampled: true,
  belowCostCount: 5,
  worst: [
    {
      label: "SKU-123",
      title: "Oak table",
      quantity: 50,
      unitPrice: "$40.00",
      unitCost: "$60.00",
      shortfall: "$20.00",
    },
    {
      label: "SKU-124",
      title: "Ash table",
      quantity: 50,
      unitPrice: "$36.00",
      unitCost: "$50.00",
      shortfall: "$14.00",
    },
    {
      label: "SKU-125",
      title: "Elm stool",
      quantity: 10,
      unitPrice: "$18.00",
      unitCost: "$22.00",
      shortfall: "$4.00",
    },
  ],
};

/* -------------------------------------------------------------------------- */

describe("composing", () => {
  it("offers an empty box and three examples", () => {
    const html = render(<DescribeRulePage view={view()} />);

    expect(html).toContain("Describe a rule");
    expect(html).toContain("Buy 10 get 5%");
    expect(html).toContain('name="sentence"');
    capture("01-composing", html);
  });

  it("keeps the manual builder one click away", () => {
    expect(render(<DescribeRulePage view={view()} />)).toContain("/app/pricing/new");
  });

  it("turns the composer off, and says why, with no API key", () => {
    const html = render(<DescribeRulePage view={view({ aiAvailable: false })} />);

    expect(html).toContain("Drafting is switched off");
    // Set, or omitted — never `disabled="false"`, which a browser reads as set.
    expect(html).toMatch(/<s-text-area[^>]*disabled="true"/);
    expect(html).not.toContain('disabled="false"');
    // …and the manual path is not disabled with it.
    expect(html).toContain("/app/pricing/new");
    capture("02-no-key", html);
  });

  it("says which way the plan limit bites, without hiding the composer", () => {
    const html = render(<DescribeRulePage view={view({ atRuleLimit: true })} />);

    expect(html).toContain("rule limit is used up");
    expect(html).toContain("/app/plans");
    capture("03-at-rule-limit", html);
  });

  it("asks for a sentence when the box was empty", () => {
    const html = render(<DescribeRulePage view={view({ failure: "empty" })} />);
    expect(html).toContain("Say what the rule should do");
    capture("04-empty-sentence", html);
  });
});

describe("when the model does not answer", () => {
  const failures = [
    ["timeout", "did not answer in time"],
    ["rate_limited", "Too many requests"],
    ["refused", "did not draft that one"],
    ["invalid_output", "could not be read"],
    ["error", "Drafting failed"],
  ] as const;

  it.each(failures)("says what happened for %s, with a way forward", (failure, text) => {
    const html = render(<DescribeRulePage view={view({ failure })} />);

    expect(html).toContain(text);
    expect(html).toContain("/app/pricing/new");
  });

  it("captures the timeout", () => {
    capture(
      "05-timeout",
      render(<DescribeRulePage view={view({ failure: "timeout" })} />),
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("the draft card", () => {
  it("shows the rule as chips, and says nothing is live", () => {
    const html = render(
      <DescribeRulePage
        view={view({ sentence: "Buy 10 get 5%", draft: card(), margin: clean })}
      />,
    );

    expect(html).toContain("Wholesale volume tiers");
    expect(html).toContain("10–49 · 5% off");
    expect(html).toContain("50+ · 12% off");
    expect(html).toContain("Drafted by Claude");
    expect(html).toContain("You approve it, not the AI");
    expect(html).toContain("Approve &amp; activate");
    expect(html).toContain("Edit in the builder");
    expect(html).toContain("Discard");
    capture("06-draft-clean", html);
  });

  it("shows what Claude assumed, as its own words", () => {
    const html = render(
      <DescribeRulePage view={view({ draft: card(), margin: clean })} />,
    );
    expect(html).toContain("What Claude assumed");
    expect(html).toContain("Excluded the Sale collection");
  });

  it("posts the whole draft to the builder on Edit", () => {
    const html = render(
      <DescribeRulePage
        view={view({
          draft: card({
            builderFields: [
              { name: "name", value: "Wholesale volume tiers" },
              { name: "tierMin", value: "10" },
              { name: "tierMin", value: "50" },
            ],
          }),
          margin: clean,
        })}
      />,
    );

    expect(html).toContain('action="/app/pricing/new"');
    expect(html).toContain('value="prefill"');
    expect(html.match(/name="tierMin"/g)).toHaveLength(2);
  });

  it("renders in Arabic without leaking an English string", () => {
    const html = render(
      <DescribeRulePage view={view({ draft: card(), margin: clean })} />,
      "ar",
    );

    expect(html).toContain("مسودة للمراجعة");
    expect(html).toContain("وافق وفعّل");
    expect(html).not.toContain("Approve");
    capture("07-draft-arabic", html, "ar");
  });
});

describe("an ambiguous term", () => {
  const ambiguous = view({
    draft: card(),
    clarifications: [
      {
        key: "targets.collectionIds:summer",
        field: "targets.collectionIds",
        term: "summer",
        options: [
          { id: "gid://shopify/Collection/1", label: "Sale" },
          { id: "gid://shopify/Collection/2", label: "Summer sale" },
        ],
      },
    ],
  });

  it("asks which one was meant, and offers the candidates", () => {
    const html = render(<DescribeRulePage view={ambiguous} />);

    expect(html).toContain("Which did you mean");
    expect(html).toContain("Summer sale");
    capture("08-clarify", html);
  });

  it("will not let the draft be approved until it is answered", () => {
    const html = render(<DescribeRulePage view={ambiguous} />);
    expect(html).toMatch(/<s-button[^>]*disabled="true"[^>]*>[^<]*Approve/);
  });

  it("says so plainly when nothing in the shop is close", () => {
    const html = render(
      <DescribeRulePage
        view={view({
          draft: card(),
          clarifications: [
            {
              key: "targets.collectionIds:sofas",
              field: "targets.collectionIds",
              term: "sofas",
              options: [],
            },
          ],
        })}
      />,
    );

    expect(html).toContain("Nothing in this store is called");
    capture("09-clarify-no-match", html);
  });

  it("does not run the margin guard on a draft that is still a question", () => {
    const html = render(<DescribeRulePage view={ambiguous} />);
    expect(html).not.toContain("below cost");
  });
});

/* -------------------------------------------------------------------------- */

describe("the margin guard", () => {
  it("says nothing sells below cost, and how much it checked", () => {
    const html = render(
      <DescribeRulePage view={view({ draft: card(), margin: clean })} />,
    );

    expect(html).toContain("Nothing sells below cost");
    expect(html).toContain("42 products");
    capture("10-margin-clear", html);
  });

  it("lists the three worst, counts them all, and admits the sample", () => {
    const html = render(
      <DescribeRulePage
        view={view({ draft: card(), margin: losing, approveAnywayRequired: true })}
      />,
    );

    expect(html).toContain("5 products sell below cost");
    expect(html).toContain("SKU-123");
    expect(html).toContain("$60.00");
    expect(html).toContain("3 of them have no cost recorded");
    expect(html).toContain("the check is a sample");
    expect(html).toContain('name="approveAnyway"');
    capture("11-margin-below-cost", html);
  });

  it("asks for the tick again when it was not given", () => {
    const html = render(
      <DescribeRulePage
        view={view({
          draft: card(),
          margin: losing,
          approveAnywayRequired: true,
          approveAnywayMissing: true,
        })}
      />,
    );

    expect(html).toContain("Tick the box to approve this one");
    capture("12-approve-anyway-missing", html);
  });

  it("says the costs could not be checked rather than reporting them clear", () => {
    const html = render(
      <DescribeRulePage
        view={view({
          draft: card(),
          margin: {
            status: "unavailable",
            checked: 0,
            costUnknown: 0,
            sampled: false,
            belowCostCount: 0,
            worst: [],
          },
        })}
      />,
    );

    expect(html).toContain("Costs could not be checked");
    expect(html).not.toContain("Nothing sells below cost");
    capture("13-margin-unavailable", html);
  });

  it("does not make a merchant tick a box when the check could not run", () => {
    const html = render(
      <DescribeRulePage
        view={view({
          draft: card(),
          margin: {
            status: "unavailable",
            checked: 0,
            costUnknown: 0,
            sampled: false,
            belowCostCount: 0,
            worst: [],
          },
        })}
      />,
    );

    expect(html).not.toContain('name="approveAnyway"');
  });
});
