import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SettingsPage } from "~/components/settings/SettingsPage";
import type { SettingsView } from "~/components/settings/types";
import type { Locale } from "~/i18n/config";
import { createCaptureHarness, type CaptureHarness } from "../support/state-capture";

/** Settings, in every state it has. */

const OUT = resolve(process.cwd(), "qa/6.4");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Settings",
    outFor: () => OUT,
    dirs: [OUT],
  });
});

/* -------------------------------------------------------------------------- */

const view = (overrides: Partial<SettingsView> = {}): SettingsView => ({
  wholesale: {
    wholesaleTag: "wholesale",
    wholesaleOrderTag: "wholesale",
    taggedBuyers: 34,
  },
  display: {
    showCompareAt: true,
    hidePricesFromGuests: false,
    taxDisplay: "excl",
    preview: { price: "$28.00", compareAt: "$40.00", taxNote: "Excluding tax" },
  },
  discounts: {
    allowShopifyDiscounts: false,
    combinableRules: 3,
    combinableHref: "/app/pricing?combinable=1",
  },
  tax: {
    requireVatForTaxExempt: false,
    taxExemptNeedsApproval: true,
    exemptWithoutVat: 2,
  },
  orders: {
    posBypassesLimits: true,
    quoteExpiryDays: 14,
    quoteReminderDays: 3,
    quotesOutstanding: 5,
  },
  sender: {
    senderEmail: "",
    senderDomain: null,
    status: "none",
    checkedAt: null,
    error: null,
    records: [],
    fallbackFrom: "mannon@mannonapp.com",
    verifiable: true,
  },
  danger: { paused: false, pausedAt: null, ruleCount: 7, confirming: false },
  saved: null,
  failedSection: null,
  issues: [],
  ...overrides,
});

const DNS_RECORDS = [
  { kind: "TXT", host: "mannon._domainkey.acme.com", value: "v=DKIM1; k=rsa; p=MIG…" },
  { kind: "TXT", host: "acme.com", value: "v=spf1 include:mannonapp.com ~all" },
  { kind: "MX", host: "reply.acme.com", value: "10 feedback.mannonapp.com" },
];

/* -------------------------------------------------------------------------- */

describe("the settings page", () => {
  it("shows every section, with what each change would affect", () => {
    const html = render(<SettingsPage view={view()} />);

    expect(html).toContain("Wholesale");
    expect(html).toContain("Storefront display");
    expect(html).toContain("Discount combinations");
    expect(html).toContain("Danger zone");
    // Blast radius beside the control, not on another page.
    expect(html).toContain("34 buyers carry the current tag");
    expect(html).toContain("This affects 3 active rules");
    expect(html).toContain("5 quotes are already out");
    capture("01-settings", html);
  });

  it("links to the rules a combination change affects, not just a count", () => {
    const html = render(<SettingsPage view={view()} />);

    // Invariant 5: a number a merchant cannot check is one they have to take
    // on trust, and this one decides whether their trade prices stack.
    expect(html).toContain("/app/pricing?combinable=1");
    expect(html).toContain("See which rules");
  });

  it("says nothing is affected rather than showing a bare zero", () => {
    const html = render(
      <SettingsPage
        view={view({
          discounts: {
            allowShopifyDiscounts: false,
            combinableRules: 0,
            combinableHref: "/app/pricing?combinable=1",
          },
        })}
      />,
    );

    expect(html).toContain("No active rule is set to combine");
    expect(html).not.toContain("This affects 0");
    capture("02-settings-nothing-affected", html);
  });

  it("previews what a buyer reads, rather than describing the setting", () => {
    const html = render(<SettingsPage view={view()} />);

    expect(html).toContain("A buyer will read:");
    expect(html).toContain("$28.00");
    expect(html).toContain("$40.00");
  });

  it("drops the struck-through price from the preview when it is off", () => {
    const html = render(
      <SettingsPage
        view={view({
          display: {
            showCompareAt: false,
            hidePricesFromGuests: true,
            taxDisplay: "incl",
            preview: { price: "$28.00", compareAt: null, taxNote: "Including tax" },
          },
        })}
      />,
    );

    expect(html).not.toContain("$40.00");
    expect(html).toContain("Including tax");
    capture("03-settings-display-off", html);
  });

  it("puts each error beside the field that caused it, and saves nothing", () => {
    const html = render(
      <SettingsPage
        view={view({
          failedSection: "wholesale",
          issues: [
            {
              field: "wholesaleTag",
              message:
                "Shopify splits tags on commas, so a comma here would become two tags and neither would be this one.",
            },
          ],
        })}
      />,
    );

    expect(html).toContain("Shopify splits tags on commas");
    expect(html).toContain("Nothing was saved");
    capture("04-settings-error", html);
  });

  it("confirms a save, on the section that was saved", () => {
    const html = render(<SettingsPage view={view({ saved: "orders" })} />);
    expect(html).toContain("Saved.");
    capture("05-settings-saved", html);
  });

  it("shows a sender's records and says where mail goes meanwhile", () => {
    const html = render(
      <SettingsPage
        view={view({
          sender: {
            senderEmail: "orders@acme.com",
            senderDomain: "acme.com",
            status: "unchecked",
            checkedAt: null,
            error: null,
            records: DNS_RECORDS,
            fallbackFrom: "mannon@mannonapp.com",
            verifiable: true,
          },
        })}
      />,
    );

    // "Not checked yet" is a statement about this app; "unverified" would be
    // a claim about the merchant's DNS that nobody has looked at.
    expect(html).toContain("Not checked yet");
    expect(html).toContain("mannon._domainkey.acme.com");
    expect(html).toContain("mail goes out from mannon@mannonapp.com");
    capture("06-sender-unchecked", html);
  });

  it("says what was wrong when the records were checked and missing", () => {
    const html = render(
      <SettingsPage
        view={view({
          sender: {
            senderEmail: "orders@acme.com",
            senderDomain: "acme.com",
            status: "failed",
            checkedAt: "2 hours ago",
            error: "No TXT record found at mannon._domainkey.acme.com.",
            records: DNS_RECORDS,
            fallbackFrom: "mannon@mannonapp.com",
            verifiable: true,
          },
        })}
      />,
    );

    expect(html).toContain("Records not found");
    expect(html).toContain("No TXT record found");
    expect(html).toContain("Last checked 2 hours ago");
    capture("07-sender-failed", html);
  });

  it("stops claiming a fallback once the domain is verified", () => {
    const html = render(
      <SettingsPage
        view={view({
          sender: {
            senderEmail: "orders@acme.com",
            senderDomain: "acme.com",
            status: "verified",
            checkedAt: "today",
            error: null,
            records: DNS_RECORDS,
            fallbackFrom: "mannon@mannonapp.com",
            verifiable: true,
          },
        })}
      />,
    );

    expect(html).toContain("Verified");
    expect(html).not.toContain("mail goes out from");
    capture("08-sender-verified", html);
  });

  it("says mail cannot be sent at all when nothing is configured", () => {
    const html = render(
      <SettingsPage
        view={view({
          sender: {
            senderEmail: "",
            senderDomain: null,
            status: "none",
            checkedAt: null,
            error: null,
            records: [],
            fallbackFrom: null,
            verifiable: false,
          },
        })}
      />,
    );

    // Invariant 4: if mail cannot be sent, the screen says so — and says what
    // happened to the messages rather than leaving a merchant to guess.
    expect(html).toContain("cannot send mail at all");
    expect(html).toContain("Nothing is queued and nothing is lost");
    // A Verify that checks nothing could only ever report success.
    expect(html).toContain("nothing to check against yet");
    capture("09-sender-none", html);
  });

  it("confirms a pause, saying what stops and what is kept", () => {
    const html = render(
      <SettingsPage
        view={view({
          danger: { paused: false, pausedAt: null, ruleCount: 7, confirming: true },
        })}
      />,
    );

    expect(html).toContain("Pause Mannon?");
    expect(html).toContain("7 pricing rules stop applying");
    expect(html).toContain("Nothing is deleted");
    capture("10-danger-confirm", html);
  });

  it("says the app is paused at the top of the page, not only in the zone", () => {
    const html = render(
      <SettingsPage
        view={view({
          danger: {
            paused: true,
            pausedAt: "1 September 2026",
            ruleCount: 7,
            confirming: false,
          },
        })}
      />,
    );

    // A merchant who paused and forgot has no other signal that their trade
    // prices are switched off.
    expect(html).toContain("Mannon is paused");
    expect(html).toContain("No wholesale price is being applied anywhere");
    expect(html).toContain("Resume, and apply 7 rules again");
    capture("11-danger-paused", html);
  });

  it("states the uninstall policy rather than linking to it", () => {
    const html = render(<SettingsPage view={view()} />);
    expect(html).toContain("deleted within 48 hours");
  });

  it("reads right to left in Arabic", () => {
    const html = render(<SettingsPage view={view()} />, "ar");
    expect(html).toContain("الإعدادات");
    expect(html).toContain("منطقة الخطر");
    capture("12-settings-arabic", html, "ar");
  });
});
