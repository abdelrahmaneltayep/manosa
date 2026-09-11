import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { AnalyticsPage } from "~/components/analytics/AnalyticsPage";
import { ReviewPage } from "~/components/analytics/ReviewPage";
import type {
  AnalyticsView,
  AskView,
  ReviewsView,
  ReviewView,
} from "~/components/analytics/types";
import type { Locale } from "~/i18n/config";
import { createCaptureHarness, type CaptureHarness } from "../support/state-capture";

/** The two ✦ analytics features, in every state they have. */

const OUT = resolve(process.cwd(), "qa/6.3");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

/**
 * A `<details>` renders closed, so a screenshot of the page with the "why"
 * expander shut is the same picture as the page without it — which is how
 * `11-review-why.png` was, for one commit, byte-identical to `10-review.png`
 * while claiming to show the audit trail. The capture opens it, as a merchant
 * does, and says so in its banner.
 */
const opened = (html: string) => html.replaceAll("<details>", "<details open>");

const OPENED_NOTE = `<strong>QA capture — structure only, disclosure opened.</strong> Polaris
web components are not upgraded here, so the styling is a plain stand-in and is <em>not</em>
what a merchant sees. The "Why this?" expander is shown opened, which is what a merchant
gets on clicking it; everything else is as the page renders.`;

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Ask your data, and the monthly review",
    outFor: () => OUT,
    dirs: [OUT],
  });
});

const money = (amount: number) =>
  new Intl.NumberFormat("en", { style: "currency", currency: "USD" }).format(
    amount / 100,
  );

/* -------------------------------------------------------------------------- */

const ask = (overrides: Partial<AskView> = {}): AskView => ({
  available: true,
  locked: null,
  requiredPlan: null,
  question: "",
  reply: null,
  chart: null,
  href: null,
  insteadTry: [],
  failure: null,
  ...overrides,
});

const analytics = (): AnalyticsView => ({
  loading: false,
  range: 30,
  ranges: [7, 30, 90],
  isExample: false,
  partial: false,
  historyDays: 120,
  currencyCode: "USD",
  timeZone: "Europe/London",
  excludedOrders: 0,
  ordersMissingLines: 0,
  ordersCapped: false,
  annotations: [],
  aov: { value: money(31_000), orders: 42 },
  axisTicks: [money(20_000), money(15_000), money(10_000), money(5_000), money(0)],
  revenue: {
    wholesale: { key: "wholesale", points: [], total: money(1_060_000) },
    retail: { key: "retail", points: [], total: money(315_000) },
  },
  byGroup: [],
  topBuyers: [],
  topProducts: [],
  rules: [],
  funnel: [
    { key: "submitted", value: 48, ofPrevious: null },
    { key: "approved", value: 31, ofPrevious: "65%" },
    { key: "ordered", value: 22, ofPrevious: "71%" },
  ],
  aging: [],
});

describe("asking your data", () => {
  it("offers a question box with an example of one", () => {
    const html = render(<AnalyticsPage view={analytics()} ask={ask()} />);

    expect(html).toContain("Ask your data");
    expect(html).toContain("which group grew fastest");
    capture("01-ask-empty", html);
  });

  it("cites the chart an answer came from, and links to it", () => {
    const html = render(
      <AnalyticsPage
        view={analytics()}
        ask={ask({
          question: "which group spends the most?",
          reply: "Cafés, at $6,200.00 — about twice what Restaurants spend.",
          chart: "byGroup",
          href: "/app/analytics?range=30#groups",
        })}
      />,
    );

    // An answer with no citation is a figure a merchant has to take on trust.
    expect(html).toContain("From: Wholesale revenue by group.");
    expect(html).toContain("/app/analytics?range=30#groups");
    expect(html).toContain("Show me");
    capture("02-ask-answered", html);
  });

  it("offers what can be answered when the chosen chart is empty", () => {
    const html = render(
      <AnalyticsPage
        view={analytics()}
        ask={ask({
          question: "which products sell best?",
          chart: "topProducts",
          href: "/app/analytics?range=30#products",
          insteadTry: ["revenue", "funnel"],
        })}
      />,
    );

    expect(html).toContain("That chart has nothing in it for this window");
    expect(html).toContain("Registration funnel");
    capture("03-ask-no-data", html);
  });

  it("says which plan it needs, and that the charts still work", () => {
    const html = render(
      <AnalyticsPage
        view={analytics()}
        ask={ask({ available: false, locked: "plan", requiredPlan: "growth" })}
      />,
    );

    expect(html).toContain("comes with the Merchant Agent, on growth");
    expect(html).toContain("charts below work on every plan");
    capture("04-ask-plan-locked", html);
  });

  it("says Claude is not connected rather than failing quietly", () => {
    const html = render(
      <AnalyticsPage
        view={analytics()}
        ask={ask({ available: false, locked: "no_key" })}
      />,
    );

    expect(html).toContain("no Anthropic API key");
    capture("05-ask-no-key", html);
  });

  it("says what went wrong when a question could not be answered", () => {
    const html = render(
      <AnalyticsPage
        view={analytics()}
        ask={ask({ question: "how are we doing?", failure: "timeout" })}
      />,
    );

    expect(html).toContain("took too long");
    capture("06-ask-failed", html);
  });
});

/* -------------------------------------------------------------------------- */

const review = (overrides: Partial<ReviewView> = {}): ReviewView => ({
  month: "2026-08",
  monthLabel: "August 2026",
  generatedAt: "2 days ago",
  quiet: false,
  sections: [
    {
      kind: "worked",
      headline: "Café trade price did the heavy lifting",
      body: "It priced 42 lines and brought in $6,200.00 — more than every other rule together.",
      action: "open_pricing",
      actionHref: "/app/pricing",
      because: ["rule Café trade price: 42 lines", "wholesale revenue: $12,400.00"],
    },
    {
      kind: "dead_weight",
      headline: "Launch offer priced nothing at all",
      body: "It has been active all month and has not touched an order.",
      action: "open_rule_builder",
      actionHref: "/app/pricing/new",
      because: ["active rule that priced nothing this month: Launch offer"],
    },
    {
      kind: "risk",
      headline: "Three buyers went quiet",
      body: "They ordered in July and not in August.",
      action: "open_segments",
      actionHref: "/app/customers/segments",
      because: ["buyers who ordered last month but not this one: 3"],
    },
  ],
  diff: [
    { key: "revenue", label: "+$2,400.00", better: true },
    { key: "orders", label: "+12", better: true },
    { key: "buyers", label: "−2", better: false },
  ],
  months: [
    { month: "2026-08", label: "August 2026", current: true },
    { month: "2026-07", label: "July 2026", current: false },
  ],
  ...overrides,
});

const reviews = (overrides: Partial<ReviewsView> = {}): ReviewsView => ({
  available: true,
  locked: null,
  requiredPlan: null,
  latest: review(),
  scheduled: true,
  ...overrides,
});

describe("the monthly review", () => {
  it("shows what moved, and what to do about it", () => {
    const html = render(<ReviewPage view={reviews()} />);

    expect(html).toContain("August 2026");
    expect(html).toContain("Revenue +$2,400.00");
    expect(html).toContain("Café trade price did the heavy lifting");
    // A recommendation is a link to a page, never something this app did.
    expect(html).toContain("/app/pricing/new");
    capture("10-review", html);
  });

  it("shows the data behind every recommendation", () => {
    const html = render(<ReviewPage view={reviews()} />);

    // Invariant 5: advice a merchant cannot audit is advice they cannot act on.
    expect(html).toContain("Why this?");
    expect(html).toContain("rule Café trade price: 42 lines");
    harness.capture("11-review-why", opened(html), "en", OPENED_NOTE);
  });

  it("does not claim a change for a first month", () => {
    const html = render(
      <ReviewPage view={reviews({ latest: review({ diff: null, months: [] }) })} />,
    );

    // "No change" would be a claim about a month that does not exist.
    expect(html).toContain("no month before it to compare against");
    expect(html).not.toContain("Revenue +");
    capture("12-review-first-month", html);
  });

  it("says a quiet month was quiet, rather than padding it", () => {
    const html = render(
      <ReviewPage view={reviews({ latest: review({ quiet: true, sections: [] }) })} />,
    );

    expect(html).toContain("a real answer, not a missing one");
    capture("13-review-quiet", html);
  });

  it("says the first one is coming rather than showing nothing", () => {
    const html = render(<ReviewPage view={reviews({ latest: null })} />);

    expect(html).toContain("first one will be written");
    capture("14-review-none-yet", html);
  });

  it("says which plan it needs, and where the figures still are", () => {
    const html = render(
      <ReviewPage
        view={reviews({
          latest: null,
          available: false,
          locked: "plan",
          requiredPlan: "growth",
        })}
      />,
    );

    expect(html).toContain("comes with the Merchant Agent, on growth");
    capture("15-review-plan-locked", html);
  });

  it("says Claude is not connected, and points at the charts", () => {
    const html = render(
      <ReviewPage view={reviews({ latest: null, available: false, locked: "no_key" })} />,
    );

    expect(html).toContain("Every figure it would have used is on the charts page");
    capture("16-review-no-key", html);
  });

  it("reads right to left in Arabic", () => {
    const html = render(<ReviewPage view={reviews()} />, "ar");

    expect(html).toContain("المراجعة الشهرية");
    expect(html).toContain("لماذا؟");
    capture("17-review-arabic", html, "ar");
  });
});
