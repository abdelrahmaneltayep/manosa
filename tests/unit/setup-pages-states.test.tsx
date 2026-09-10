import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { ActivityPage } from "~/components/activity/ActivityPage";
import type { ActivityLogView } from "~/components/activity/types";
import { WizardPage } from "~/components/setup/WizardPage";
import type { WizardView } from "~/components/setup/types";
import type { Locale } from "~/i18n/config";
import { createCaptureHarness, type CaptureHarness } from "../support/state-capture";

/**
 * The two pages 4.5 adds: the full activity log, and the ✦ setup wizard.
 *
 * The wizard's states are the ones worth walking. It is the only screen in the
 * app that creates three different kinds of thing at once, so "what it says it
 * will do" and "what it did" both have to be legible before the merchant
 * presses anything.
 */

const OUT = resolve(process.cwd(), "qa/4.5");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Setup and activity",
    outFor: () => OUT,
    dirs: [OUT],
  });
});

const wizard = (overrides: Partial<WizardView> = {}): WizardView => ({
  available: true,
  locked: null,
  description: "",
  plan: null,
  payload: "",
  failure: null,
  applied: null,
  ...overrides,
});

const plan = (overrides: Partial<NonNullable<WizardView["plan"]>> = {}) => ({
  summary: "You sell roasted coffee to cafés, monthly, at a trade discount.",
  groups: [
    { name: "Cafés", tag: "cafes", description: "Independent cafés ordering monthly." },
    { name: "Key accounts", tag: "key-accounts", description: "Your three largest." },
  ],
  rule: {
    name: "Café trade price",
    summary: "25% off everything, for buyers tagged cafes.",
  },
  form: { name: "Trade application", fields: ["Company", "Email", "VAT number"] },
  notes: "You didn't say what the key accounts get, so I priced only the cafés.",
  ...overrides,
});

const log = (overrides: Partial<ActivityLogView> = {}): ActivityLogView => ({
  rows: [
    {
      id: "order:1",
      summary: "#1001 — Acme Ltd",
      when: "2 hours ago",
      at: "2026-06-01T07:00:00.000Z",
      href: "/app/orders",
      agent: false,
      kindLabel: "Order",
      actorLabel: "Acme Ltd",
    },
    {
      id: "audit:1",
      summary: "Created the rule “Wholesale 35%”.",
      when: "3 days ago",
      at: "2026-05-29T09:00:00.000Z",
      href: "/app/pricing",
      agent: true,
      kindLabel: "Pricing",
      actorLabel: "Claude",
    },
  ],
  filter: "all",
  filters: ["all", "orders", "registrations", "pricing"],
  nextHref: "/app/activity?filter=all&before=2026-05-29T09%3A00%3A00.000Z",
  ...overrides,
});

/* -------------------------------------------------------------------------- */

describe("the setup wizard", () => {
  it("asks one question, with an example of an answer", () => {
    const html = render(<WizardPage view={wizard()} />);

    expect(html).toContain("Tell me about your wholesale business");
    expect(html).toContain("forty cafés");
    capture("01-wizard-empty", html);
  });

  it("shows everything it would create before it creates any of it", () => {
    const html = render(<WizardPage view={wizard({ plan: plan(), payload: "{}" })} />);

    expect(html).toContain("Here&#x27;s what I&#x27;d set up");
    expect(html).toContain("2 customer groups");
    expect(html).toContain("25% off everything, for buyers tagged cafes");
    expect(html).toContain("Trade application");
    // What it assumed, above the button rather than folded away.
    expect(html).toContain("what the key accounts get");
    expect(html).toContain("Set this up");
    capture("02-wizard-preview", html);
  });

  it("says so when a shop already has rules or a form", () => {
    const html = render(
      <WizardPage view={wizard({ plan: plan({ rule: null, form: null }) })} />,
    );

    expect(html).toContain("You already have pricing rules");
    expect(html).toContain("You already have a registration form");
  });

  it("confirms what it made, and that the form is a draft", () => {
    const html = render(
      <WizardPage
        view={wizard({
          applied: {
            links: [
              { label: "Your customer groups", href: "/app/customers/groups" },
              { label: "The pricing rule", href: "/app/pricing/r1" },
              { label: "The registration form", href: "/app/forms/f1" },
            ],
            formDraft: true,
          },
        })}
      />,
    );

    expect(html).toContain("here&#x27;s what I made");
    expect(html).toContain("The form is a draft");
    expect(html).toContain("/app/pricing/r1");
    capture("03-wizard-applied", html);
  });

  it("says the wizard is off, and that everything can be done by hand", () => {
    const html = render(
      <WizardPage view={wizard({ available: false, locked: "no_key" })} />,
    );

    expect(html).toContain("The setup wizard is off");
    expect(html).toContain("can be done by hand");
    capture("04-wizard-off", html);
  });

  it("says the plan does not include it, when that is the reason", () => {
    const html = render(
      <WizardPage view={wizard({ available: false, locked: "plan" })} />,
    );
    expect(html).toContain("Merchant Agent on your plan");
    capture("05-wizard-plan-locked", html);
  });

  it("offers the manual path when the model could not be reached", () => {
    const html = render(<WizardPage view={wizard({ failure: "timeout" })} />);

    expect(html).toContain("That took too long");
    expect(html).toContain("Set it up by hand instead");
    capture("06-wizard-timeout", html);
  });

  it("says nothing was created when a plan limit stops it", () => {
    const html = render(<WizardPage view={wizard({ failure: "limit" })} />);
    expect(html).toContain("Your plan is at its limit");
    capture("07-wizard-limit", html);
  });

  it("renders in Arabic", () => {
    const html = render(<WizardPage view={wizard({ plan: plan() })} />, "ar");
    expect(html).toContain("هذا ما سأعدّه");
    capture("08-wizard-arabic", html, "ar");
  });
});

describe("the activity log", () => {
  it("lists what happened, filtered, with a way further back", () => {
    const html = render(<ActivityPage view={log()} />);

    expect(html).toContain("#1001 — Acme Ltd");
    expect(html).toContain("3 days ago");
    expect(html).toContain("✦");
    expect(html).toContain("Show older");
    expect(html).toContain("/app/activity?filter=orders");
    capture("09-activity-log", html);
  });

  it("says the log is empty, before anything has happened", () => {
    const html = render(<ActivityPage view={log({ rows: [], nextHref: null })} />);

    expect(html).toContain("Activity will appear here");
    expect(html).not.toContain("Show older");
    capture("10-activity-empty", html);
  });

  it("says a filter is empty differently from a log that is", () => {
    const html = render(
      <ActivityPage view={log({ rows: [], nextHref: null, filter: "pricing" })} />,
    );
    expect(html).toContain("Nothing of this kind yet");
  });

  it("renders in Arabic", () => {
    const html = render(<ActivityPage view={log()} />, "ar");
    expect(html).toContain("النشاط");
    capture("11-activity-arabic", html, "ar");
  });
});
