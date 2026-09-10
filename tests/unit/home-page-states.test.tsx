import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { HomePage } from "~/components/home/HomePage";
import type {
  ActivityView,
  AskView,
  BriefingView,
  HomeView,
  KpiView,
  SetupView,
} from "~/components/home/types";
import type { Locale } from "~/i18n/config";
import { createCaptureHarness, type CaptureHarness } from "../support/state-capture";

/**
 * Home — every state in checklist §1.
 *
 * The states that matter most are the ones where the agent has nothing: day
 * one, all quiet, and the model being down. Each is a different sentence,
 * because a merchant acts differently on each, and none of them is silence.
 */

const OUT = resolve(process.cwd(), "qa/4.4");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({ title: "Home", outFor: () => OUT, dirs: [OUT] });
});

const ask = (overrides: Partial<AskView> = {}): AskView => ({
  available: true,
  question: "",
  examples: [
    "Who owes me money?",
    "How many buyers have gone quiet?",
    "What did I sell to wholesale last week?",
  ],
  result: null,
  failure: null,
  reformulations: [
    "Who owes me money?",
    "Which quotes expire this week?",
    "How many applications are waiting?",
  ],
  cooldownSeconds: null,
  ...overrides,
});

const briefing = (overrides: Partial<BriefingView> = {}): BriefingView => ({
  status: "ready",
  items: [
    {
      kind: "invoices_overdue",
      reason: "Money that is already late, and the longer it sits the harder it gets.",
      figure: "$1,200.00 overdue on 2 invoices",
      href: "/app/orders/terms",
      actionKey: "home.briefing.action.chase",
    },
    {
      kind: "applications_waiting",
      reason: "Someone is waiting on you to decide.",
      figure: "6 applications",
      href: "/app/customers/applications",
      actionKey: "home.briefing.action.review",
    },
  ],
  writtenAt: "2026-06-01T09:00:00.000Z",
  writtenAtLabel: "1 June 2026",
  stale: false,
  muted: [],
  confirmingMute: null,
  ...overrides,
});

const kpis = (overrides: Partial<KpiView> = {}): KpiView => ({
  period: 30,
  periods: [7, 30, 90],
  empty: false,
  coversDays: null,
  cards: [
    {
      key: "wholesale_revenue",
      value: "$12,400.00",
      previous: "$9,300.00",
      deltaPercent: 33,
      partial: false,
      href: "/app/orders",
    },
    {
      key: "wholesale_orders",
      value: "18",
      previous: "14",
      deltaPercent: 29,
      partial: false,
      href: "/app/orders",
    },
    {
      key: "pending_approvals",
      value: "6",
      previous: null,
      deltaPercent: null,
      partial: false,
      href: "/app/customers/applications",
    },
    {
      key: "active_rules",
      value: "4",
      previous: null,
      deltaPercent: null,
      partial: false,
      href: "/app/pricing",
    },
    {
      key: "terms_outstanding",
      value: "$1,200.00",
      previous: null,
      deltaPercent: null,
      partial: false,
      href: "/app/orders/terms",
    },
  ],
  ...overrides,
});

const setup = (overrides: Partial<SetupView> = {}): SetupView => ({
  items: [
    { step: "embed", done: true, href: "/app/settings", attested: false },
    { step: "rule", done: true, href: "/app/pricing/new", attested: false },
    { step: "form", done: false, href: "/app/forms", attested: false },
    { step: "buyer", done: false, href: "/app/customers/applications", attested: false },
    { step: "order", done: false, href: "/app/orders", attested: false },
    { step: "plan", done: true, href: "/app/plans", attested: false },
  ],
  done: 3,
  total: 6,
  complete: false,
  dismissed: false,
  ...overrides,
});

const activity = (overrides: Partial<ActivityView> = {}): ActivityView => ({
  rows: [
    {
      id: "order:1",
      summary: "#1001 — Acme Ltd",
      when: "2 hours ago",
      at: "2026-06-01T07:00:00.000Z",
      href: "/app/orders",
      agent: false,
      kindLabel: "Order",
    },
    {
      id: "audit:1",
      summary: "Created the rule “Wholesale 35%”.",
      when: "yesterday",
      at: "2026-05-31T09:00:00.000Z",
      href: "/app/pricing",
      agent: true,
      kindLabel: "Pricing",
    },
  ],
  href: "/app/activity",
  empty: false,
  ...overrides,
});

const view = (overrides: Partial<HomeView> = {}): HomeView => ({
  shopName: "Acme Wholesale",
  kpis: kpis(),
  briefing: briefing(),
  ask: ask(),
  setup: setup(),
  activity: activity(),
  ...overrides,
});

/* -------------------------------------------------------------------------- */

describe("the briefing", () => {
  it("shows at most three items, each with our figure and one action", () => {
    const html = render(<HomePage view={view()} />);

    expect(html).toContain("$1,200.00 overdue on 2 invoices");
    expect(html).toContain("Money that is already late");
    expect(html).toContain("/app/orders/terms");
    expect(html).toContain("Chase");
    expect(html).toContain("Not this again");
    capture("01-briefing-ready", html);
  });

  it("introduces itself on day one, with what it will watch", () => {
    const html = render(
      <HomePage
        view={view({
          briefing: briefing({ status: "empty", items: [], writtenAt: null }),
        })}
      />,
    );

    expect(html).toContain("the Merchant Agent");
    expect(html).toContain("Applications waiting");
    capture("02-briefing-day-one", html);
  });

  it("says all quiet, which is a real answer", () => {
    const html = render(
      <HomePage view={view({ briefing: briefing({ status: "quiet", items: [] }) })} />,
    );

    expect(html).toContain("All quiet");
    expect(html).toContain("Nothing needs you today");
    capture("03-briefing-quiet", html);
  });

  it("falls back to the last one when today's could not be written", () => {
    const html = render(
      <HomePage view={view({ briefing: briefing({ status: "unavailable" }) })} />,
    );

    expect(html).toContain("Briefing unavailable");
    expect(html).toContain("this is the last one");
    // The figures beside it are still current — that is why nothing is stored
    // with a number in it.
    expect(html).toContain("$1,200.00 overdue on 2 invoices");
    capture("04-briefing-unavailable", html);
  });

  it("says so when there is not even an old one", () => {
    const html = render(
      <HomePage
        view={view({ briefing: briefing({ status: "unavailable", items: [] }) })}
      />,
    );
    expect(html).toContain("no earlier one to show");
  });

  it("badges a briefing older than a day", () => {
    const html = render(
      <HomePage view={view({ briefing: briefing({ stale: true }) })} />,
    );
    // A date a merchant reads, not a timestamp a database prints.
    expect(html).toContain("Written 1 June 2026");
    capture("05-briefing-stale", html);
  });

  it("shows three shimmering lines while it is being written", () => {
    const html = render(
      <HomePage view={view({ briefing: briefing({ status: "loading", items: [] }) })} />,
    );
    expect(html).toContain("Reading your shop");
    capture("06-briefing-loading", html);
  });

  it("says the agent is off, and that nothing else is affected", () => {
    const html = render(
      <HomePage
        view={view({
          briefing: briefing({ status: "off", items: [] }),
          ask: ask({ available: false }),
        })}
      />,
    );

    expect(html).toContain("The Merchant Agent is off");
    expect(html).toContain("Everything else in Mannon works without it");
    expect(html).toMatch(/<s-text-field[^>]*disabled="true"/);
    expect(html).not.toContain('disabled="false"');
    capture("07-agent-off", html);
  });

  it("renders in Arabic", () => {
    const html = render(<HomePage view={view()} />, "ar");
    expect(html).toContain("هذا الصباح");
    expect(html).not.toContain("This morning");
    capture("08-briefing-arabic", html, "ar");
  });
});

/* -------------------------------------------------------------------------- */

describe("muting a kind", () => {
  it("asks before it mutes, and the ask writes nothing", () => {
    const html = render(
      <HomePage
        view={view({ briefing: briefing({ confirmingMute: "invoices_overdue" }) })}
      />,
    );

    expect(html).toContain("Stop showing");
    expect(html).toContain("Overdue invoices");
    expect(html).toContain("Keep showing it");
    // The item's own control is a link: nothing is posted until the merchant
    // answers the question.
    expect(html).toContain("/app?confirm=invoices_overdue");
    capture("13-briefing-confirm-mute", html);
  });

  it("lists what has been muted, each with a way back", () => {
    const html = render(
      <HomePage
        view={view({
          briefing: briefing({
            muted: [
              { kind: "invoices_overdue", label: "Overdue invoices" },
              { kind: "rules_unused", label: "Rules nothing matches" },
            ],
          }),
        })}
      />,
    );

    expect(html).toContain("2 types you have muted");
    expect(html).toContain("Show “Overdue invoices” again");
    expect(html).toContain('value="unmute"');
    capture("14-briefing-muted", html);
  });
});

describe("the Ask bar", () => {
  it("offers three examples while idle", () => {
    const html = render(<HomePage view={view()} />);
    expect(html).toContain("Who owes me money?");
    expect(html).toContain("Ask about your wholesale business");
  });

  it("shows the answer under the bar", () => {
    const html = render(
      <HomePage
        view={view({
          ask: ask({
            question: "who owes me money",
            result: {
              headline: "2 invoices are overdue — $1,200.00 outstanding.",
              rows: [
                { label: "#1001 · Acme Ltd", detail: "$800.00" },
                { label: "#1004 · Bolt & Co", detail: "$400.00" },
              ],
              href: "/app/orders/terms",
              isBuilder: false,
            },
          }),
        })}
      />,
    );

    expect(html).toContain("$1,200.00 outstanding");
    expect(html).toContain("#1001 · Acme Ltd");
    expect(html).toContain("See all of it");
    capture("09-ask-answer", html);
  });

  it("routes a change to the page that does it, and says it did not do it", () => {
    const html = render(
      <HomePage
        view={view({
          ask: ask({
            question: "delete all my pricing rules",
            result: {
              headline: "That's a change to your pricing — here's where you make it.",
              rows: [],
              href: "/app/pricing/describe",
              isBuilder: true,
            },
          }),
        })}
      />,
    );

    expect(html).toContain("where you make it");
    expect(html).toContain("Mannon does not change anything from here");
    expect(html).toContain("Take me there");
    capture("10-ask-destructive", html);
  });

  it("offers three reformulations when it did not understand", () => {
    const html = render(
      <HomePage
        view={view({ ask: ask({ question: "asdf", failure: "invalid_output" }) })}
      />,
    );

    expect(html).toContain("catch that");
    expect(html).toContain("Which quotes expire this week?");
    capture("11-ask-unparseable", html);
  });

  it("says how long to wait when rate-limited", () => {
    const html = render(
      <HomePage
        view={view({ ask: ask({ failure: "rate_limited", cooldownSeconds: 30 }) })}
      />,
    );

    expect(html).toContain("Try again in 30 seconds");
    capture("12-ask-rate-limited", html);
  });
});

describe("the KPI cards", () => {
  it("shows five figures, the period, and a delta that has a base", () => {
    const html = render(<HomePage view={view()} />);

    expect(html).toContain("$12,400.00");
    expect(html).toContain("Wholesale revenue");
    expect(html).toContain("▲ 33%");
    expect(html).toContain("/app?period=7");
    capture("15-kpi-cards", html);
  });

  it("hides the delta rather than dividing by nothing", () => {
    const html = render(
      <HomePage
        view={view({
          kpis: kpis({
            cards: kpis().cards.map((card) => ({
              ...card,
              deltaPercent: null,
              previous: null,
            })),
          }),
        })}
      />,
    );

    expect(html).not.toContain("▲");
    expect(html).not.toContain("▼");
  });

  it("says a metric needs a week rather than printing a number", () => {
    const html = render(
      <HomePage
        view={view({
          kpis: kpis({
            cards: kpis().cards.map((card) => ({ ...card, partial: true })),
          }),
        })}
      />,
    );

    expect(html).toContain("Needs a week of data");
    expect(html).not.toContain("$12,400.00");
    capture("16-kpi-partial", html);
  });

  it("explains the zeros before there is anything to count", () => {
    const html = render(<HomePage view={view({ kpis: kpis({ empty: true }) })} />);
    expect(html).toContain("Waiting for your first wholesale order");
    capture("17-kpi-empty", html);
  });

  it("holds the tiles at a fixed height, so nothing below them moves", () => {
    const html = render(<HomePage view={view()} />);
    expect(html).toContain('minBlockSize="120px"');
  });

  it("says how much history a period actually covers", () => {
    const html = render(<HomePage view={view({ kpis: kpis({ coversDays: 8 }) })} />);

    // A shop installed eight days ago asking for ninety gets a figure covering
    // eight, and is told so.
    expect(html).toContain("Covering the 8 days since you installed Mannon");
    capture("18-kpi-short-history", html);
  });

  it("shows the previous period beside the figure", () => {
    const html = render(<HomePage view={view()} />);
    expect(html).toContain("was $9,300.00");
  });
});

describe("the setup checklist", () => {
  it("lists six steps, each a link, with what is done", () => {
    const html = render(<HomePage view={view()} />);

    expect(html).toContain("3 of 6 done");
    expect(html).toContain("Publish a registration form");
    expect(html).toContain("/app/pricing/new");
    expect(html).toContain("Let Claude set this up for you");
    capture("19-setup-checklist", html);
  });

  it("says when the embed is the merchant's word rather than something seen", () => {
    const html = render(
      <HomePage
        view={view({
          setup: setup({
            items: setup().items.map((item) =>
              item.step === "embed" ? { ...item, done: true, attested: true } : item,
            ),
          }),
        })}
      />,
    );

    expect(html).toContain("we haven&#x27;t seen your storefront call us yet");
  });

  it("collapses to a pill once it is finished, with a way back", () => {
    const html = render(
      <HomePage
        view={view({
          setup: setup({
            items: setup().items.map((item) => ({ ...item, done: true })),
            done: 6,
            complete: true,
            dismissed: true,
          }),
        })}
      />,
    );

    expect(html).toContain("Setup complete");
    expect(html).toContain("Show the checklist");
    expect(html).not.toContain("Publish a registration form");
    capture("20-setup-pill", html);
  });
});

describe("recent activity", () => {
  it("shows what happened, when, and chips the agent's rows", () => {
    const html = render(<HomePage view={view()} />);

    expect(html).toContain("#1001 — Acme Ltd");
    expect(html).toContain("2 hours ago");
    expect(html).toContain("✦");
    expect(html).toContain("/app/activity");
    capture("21-activity", html);
  });

  it("says what will appear here, before anything has", () => {
    const html = render(
      <HomePage view={view({ activity: activity({ rows: [], empty: true }) })} />,
    );

    expect(html).toContain("Activity will appear here");
    capture("22-activity-empty", html);
  });
});
