import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { AnalyticsPage } from "~/components/analytics/AnalyticsPage";
import { ReviewPage } from "~/components/analytics/ReviewPage";
import { CHART_KEYS } from "~/components/analytics/types";
import type {
  AnalyticsView,
  AskView,
  ReviewsView,
  ReviewView,
} from "~/components/analytics/types";
import type { Locale } from "~/i18n/config";
import { money as money_ } from "@mannon/pricing-engine";
import { fillSlots } from "~/lib/ai/prompts/buyer-agent.server";
import { factLines } from "~/lib/analytics/review.server";
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
  nothingToAnswer: false,
  pending: false,
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
  // The charts an answer cites must have something in them. A capture whose
  // answer quotes $6,200 from a chart rendering "Nothing in this window" three
  // inches below is a state the product cannot produce.
  byGroup: [
    {
      key: "cafés",
      label: "Cafés",
      value: 620_000,
      money: money(620_000),
      isRest: false,
    },
    {
      key: "restaurants",
      label: "Restaurants",
      value: 310_000,
      money: money(310_000),
      isRest: false,
    },
    {
      key: "rest",
      label: "Everyone else",
      value: 130_000,
      money: money(130_000),
      isRest: true,
    },
  ],
  topBuyers: [
    {
      key: "acme-ltd",
      label: "Acme Ltd",
      value: 430_000,
      money: money(430_000),
      isRest: false,
    },
    {
      key: "café-aroma",
      label: "Café Aroma",
      value: 210_000,
      money: money(210_000),
      isRest: false,
    },
  ],
  topProducts: [
    {
      key: "dark-roast",
      label: "Colombian Dark Roast 1kg",
      value: 210_000,
      money: money(210_000),
      isRest: false,
    },
  ],
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

  it("names every chart it can cite, in the merchant's words", () => {
    // Three of the seven catalogue keys do not match their `ChartKey`
    // (`groups` → `byGroup`), and the citation interpolated the key straight
    // in — so an answer about groups, buyers or products was captioned
    // "From: analytics.groups.heading." The example question in the help text
    // routes to `groups`, so this was the primary flow.
    for (const chart of CHART_KEYS) {
      const html = render(
        <AnalyticsPage
          view={analytics()}
          ask={ask({
            question: "how are we doing?",
            reply: "Fine.",
            chart,
            href: "/app/analytics",
          })}
        />,
      );
      expect(html, chart).not.toContain("analytics.");
    }

    // And the same for the list offered when the chosen chart was empty.
    const offered = render(
      <AnalyticsPage
        view={analytics()}
        ask={ask({ question: "how are we doing?", insteadTry: [...CHART_KEYS] })}
      />,
    );
    expect(offered).not.toContain("analytics.");
  });

  it("says so when no chart has anything to answer from", () => {
    const html = render(
      <AnalyticsPage
        view={analytics()}
        ask={ask({ question: "how are we doing?", nothingToAnswer: true })}
      />,
    );

    // Before this the page came back byte-identical to before the click.
    expect(html).toContain("no chart on this page has any data");
    capture("07-ask-nothing-yet", html);
  });

  it("says a question is in flight, and stops a second one", () => {
    const html = render(
      <AnalyticsPage
        view={analytics()}
        ask={ask({ question: "how are we doing?", pending: true })}
      />,
    );

    expect(html).toContain("Asking…");
    expect(html).toContain("can take up to a minute");
    capture("08-ask-pending", html);
  });

  it("cites the chart an answer came from, and links to it", () => {
    const html = render(
      <AnalyticsPage
        view={analytics()}
        ask={ask({
          question: "which group spends the most?",
          reply:
            "Cafés spend the most, at $6,200.00. Restaurants are next, at $3,100.00.",
          chart: "groups",
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
          // The chart it chose has to be one that renders empty on this same
          // page, and the ones offered have to be the ones that render full —
          // `chartsWithData` cannot return anything else. The first version of
          // this capture asked about a chart with three rows in it and offered
          // one showing "Nothing in this window" two inches below.
          question: "which pricing rules are earning?",
          chart: "rules",
          href: "/app/analytics?range=30#rules",
          insteadTry: ["groups", "buyers", "products", "funnel"],
        })}
      />,
    );

    expect(html).toContain("That chart has nothing in it for this window");
    expect(html).toContain("Registration funnel");
    // Every chart offered is one this page is actually rendering rows for.
    for (const offered of ["Wholesale revenue by group", "Top wholesale buyers"]) {
      expect(html).toContain(offered);
    }
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

/**
 * The facts a month actually produces, and the slots that go with them.
 *
 * Built by calling the production `factLines`, not typed out — every fixture
 * below is `fillSlots`ed through the same path `writeMonthlyReview` uses. The
 * previous version of this file invented two shapes the writer cannot emit
 * ("rule Café trade price: 42 lines", and money already substituted into a
 * `because` line the app never filled in), which is how `11-review-why.png`
 * came to show a clean audit trail the product rendered as `{{f1}}`.
 */
const FACTS = {
  month: "2026-08",
  currencyCode: "USD",
  wholesaleRevenue: money_(1_240_000, "USD"),
  retailRevenue: money_(315_000, "USD"),
  wholesaleOrders: 42,
  buyers: 18,
  newBuyers: 5,
  applications: 9,
  approvals: 7,
  owedNow: money_(120_000, "USD"),
  overdueNow: money_(0, "USD"),
  topBuyer: { label: "Acme Ltd", amount: money_(430_000, "USD") },
  topProduct: { label: "Colombian Dark Roast 1kg", amount: money_(210_000, "USD") },
  deadRules: ["Launch offer"],
  quietBuyers: 3,
};

const { facts: FACT_LINES, slots: SLOTS } = factLines(FACTS, "en");
/** A template the model may write, filled the way the app fills it. */
const written = (template: string) => fillSlots(template, SLOTS);
/** A `because` line, cited exactly as the model was given it and then filled. */
const cite = (startsWith: string) =>
  fillSlots(
    FACT_LINES.find((line) => line.startsWith(startsWith))!,
    SLOTS,
  );

const review = (overrides: Partial<ReviewView> = {}): ReviewView => ({
  month: "2026-08",
  monthLabel: "August 2026",
  generatedAt: "2 days ago",
  quiet: false,
  sections: [
    {
      kind: "worked",
      headline: written("Acme Ltd carried the month"),
      body: written(
        "They took {{f5}} of your {{f1}} wholesale revenue across {{q1}} orders.",
      ),
      action: "open_pricing",
      actionHref: "/app/pricing",
      because: [cite("biggest buyer"), cite("wholesale revenue")],
    },
    {
      kind: "dead_weight",
      headline: written("Launch offer priced nothing at all"),
      body: written("It has been active all month and has not touched an order."),
      action: "open_rule_builder",
      actionHref: "/app/pricing/new",
      because: [cite("active rule that priced nothing")],
    },
    {
      kind: "risk",
      headline: written("{{q6}} buyers went quiet"),
      body: written("They ordered in July and not in August."),
      action: "open_segments",
      actionHref: "/app/customers/segments",
      because: [cite("buyers who ordered last month")],
    },
  ],
  diff: [
    { key: "revenue", label: "+$2,400.00", better: true },
    { key: "orders", label: "+12", better: true },
    { key: "buyers", label: "−2", better: false },
  ],
  noDiffBecause: null,
  months: [
    { month: "2026-08", label: "August 2026", current: true },
    { month: "2026-07", label: "July 2026", current: false },
  ],
  olderHref: null,
  newerHref: null,
  ...overrides,
});

const reviews = (overrides: Partial<ReviewsView> = {}): ReviewsView => ({
  available: true,
  locked: null,
  requiredPlan: null,
  latest: review(),
  scheduled: true,
  failedMonth: null,
  ...overrides,
});

describe("the monthly review", () => {
  it("shows what moved, and what to do about it", () => {
    const html = render(<ReviewPage view={reviews()} />);

    expect(html).toContain("August 2026");
    expect(html).toContain("Revenue +$2,400.00");
    expect(html).toContain("Acme Ltd carried the month");
    // Substituted, not a placeholder: the figures in the prose are this app's.
    expect(html).toContain("$12,400.00");
    expect(html).not.toContain("{{");
    // A recommendation is a link to a page, never something this app did.
    expect(html).toContain("/app/pricing/new");
    capture("10-review", html);
  });

  it("shows the data behind every recommendation", () => {
    const html = render(<ReviewPage view={reviews()} />);

    // Invariant 5: advice a merchant cannot audit is advice they cannot act on.
    expect(html).toContain("Why this?");
    // The audit trail as the writer emits it — a fact line, filled in. It
    // rendered "wholesale revenue: {{f1}}" to merchants until this round.
    expect(html).toContain("biggest buyer: Acme Ltd at $4,300.00");
    expect(html).toContain("wholesale revenue: $12,400.00");
    expect(html).not.toContain("{{f");
    harness.capture("11-review-why", opened(html), "en", OPENED_NOTE);
  });

  it("does not claim a change for a first month", () => {
    const html = render(
      <ReviewPage
        view={reviews({
          latest: review({ diff: null, noDiffBecause: "first", months: [] }),
        })}
      />,
    );

    // "No change" would be a claim about a month that does not exist.
    expect(html).toContain("no month before it to compare against");
    expect(html).not.toContain("Revenue +");
    capture("12-review-first-month", html);
  });

  it("says the month before was quiet rather than calling this the first", () => {
    const html = render(
      <ReviewPage
        view={reviews({
          latest: review({ diff: null, noDiffBecause: "previousQuiet" }),
        })}
      />,
    );

    // The switcher lists July and August, so "this is your first review" is a
    // claim the same screen disproves two inches higher.
    expect(html).toContain("had no wholesale activity");
    expect(html).not.toContain("your first review");
    expect(html).toContain("July 2026");
    capture("18-review-previous-quiet", html);
  });

  it("says a quiet month was quiet, rather than padding it", () => {
    const html = render(
      <ReviewPage view={reviews({ latest: review({ quiet: true, sections: [] }) })} />,
    );

    // Softened: the diff chips are computed independently of the model's
    // "quiet" judgement, so "nothing happened" sat directly under "Revenue
    // +$2,400.00" on the same screen.
    expect(html).toContain("Nothing last month needs anything from you");
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
