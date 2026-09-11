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
    // Priced by the engine from this shop's own rule, and named so a merchant
    // can check it. The first version hardcoded a 30% discount and labelled it
    // "A buyer will read:".
    preview: {
      price: "$28.00",
      compareAt: "$40.00",
      taxNote: "Excluding tax",
      ruleName: "Café trade price",
    },
  },
  discounts: {
    allowShopifyDiscounts: false,
    combinableRules: 3,
    combinableHref: "/app/pricing?combinable=1",
  },
  tax: { requireVatForTaxExempt: false, exemptWithoutVat: 2 },
  orders: {
    posBypassesLimits: true,
    quoteExpiryDays: 14,
    quoteReminderDays: 3,
    quotesOutstanding: 5,
  },
  agent: {
    mayScreen: true,
    mayDraft: true,
    noKey: false,
    samples: [
      {
        id: "s1",
        label: "How I welcome a new buyer",
        body: "Hi Sam — lovely to have you on board. Your trade prices are live now, so anything you add to the basket comes through at your rate. Shout if a line looks wrong.",
        added: "2026-08-14",
      },
    ],
    samplesWanted: 3,
    draft: { label: "", body: "" },
    removing: null,
    mutedBriefings: [
      { kind: "rules_unused", label: "Pricing rules that priced nothing" },
    ],
    auditHref: "/app/activity",
    retentionMonths: 12,
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
  danger: {
    paused: false,
    pausedAt: null,
    ruleCount: 7,
    confirming: false,
    reachedCheckout: true,
  },
  saved: null,
  failedSection: null,
  issues: [],
  ...overrides,
});

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

    // Labelled as an example, and naming the rule it came from.
    expect(html).toContain("Example");
    expect(html).toContain("Café trade price");
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
            preview: {
              price: "$28.00",
              compareAt: null,
              taxNote: "Including tax",
              ruleName: "Café trade price",
            },
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

  it("says where mail goes, and that a domain cannot be checked yet", () => {
    const html = render(
      <SettingsPage
        view={view({
          sender: {
            senderEmail: "orders@acme.com",
            senderDomain: "acme.com",
            status: "unchecked",
            checkedAt: null,
            error: null,
            records: [],
            fallbackFrom: "mannon@mannonapp.com",
            verifiable: false,
          },
        })}
      />,
    );

    // The "verified" and "records not found" screens are deliberately gone:
    // nothing in this app writes `senderVerifiedAt`, `senderCheckedAt` or
    // `senderDnsRecords`, so a screen for either was a screen for something
    // that could not happen — and the tests reached them by hand-setting the
    // columns, which is a test that cannot fail. They come back with a
    // provider.
    expect(html).toContain("mail goes out from mannon@mannonapp.com");
    expect(html).toContain("cannot check a domain");
    // A button that checks nothing could only ever report success or crash.
    // It did the second: enabled whenever MANNON_EMAIL_FROM was set, and a 501.
    expect(html).not.toContain("Check the records");
    capture("06-sender-set", html);
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
    capture("09-sender-none", html);
  });

  it("confirms a pause, saying what stops and what is kept", () => {
    const html = render(
      <SettingsPage
        view={view({
          danger: {
            paused: false,
            pausedAt: null,
            ruleCount: 7,
            confirming: true,
            reachedCheckout: true,
          },
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
            reachedCheckout: true,
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

  it("does not claim a pause reached checkout when the publish failed", () => {
    const html = render(
      <SettingsPage
        view={view({
          danger: {
            paused: true,
            pausedAt: "1 September 2026",
            ruleCount: 7,
            confirming: false,
            reachedCheckout: false,
          },
        })}
      />,
    );

    // Half a pause: our own code has stopped, Shopify's metafield has not, so
    // checkout is still discounting. This is the screen a merchant reads in a
    // hurry to find out whether it stopped.
    expect(html).toContain("did not reach Shopify");
    expect(html).not.toContain("No wholesale price is being applied anywhere");
    capture("13-danger-not-at-checkout", html);
  });

  it("shows no example price when there is no rule to price one from", () => {
    const html = render(
      <SettingsPage
        view={view({
          display: {
            showCompareAt: true,
            hidePricesFromGuests: false,
            taxDisplay: "excl",
            preview: { price: null, compareAt: null, taxNote: "Excluding tax" },
          },
        })}
      />,
    );

    expect(html).toContain("no active pricing rule to price one from");
    expect(html).not.toContain("$");
    capture("14-display-no-example", html);
  });

  it("says what Claude may do, and that it never writes on its own", () => {
    const html = render(<SettingsPage view={view()} />);

    // Before 6.5 there was no control at all: every ✦ surface asked only
    // whether an API key was set.
    expect(html).toContain("Let Claude read new registration applications");
    expect(html).toContain("Let Claude draft messages, rules and reviews");
    expect(html).toContain("Nothing here lets Claude change a price");
    // Muted from the home page and readable nowhere until now.
    expect(html).toContain("Pricing rules that priced nothing");
    expect(html).toContain("kept for 12 months");
    // No capture: the agent card is part of the default page, already
    // captured whole as "01-settings". A second copy of it under a section's
    // name would make the set look like it covers a state it does not.
  });

  it("shows the merchant their own writing in full", () => {
    const html = render(<SettingsPage view={view()} />);

    // A sample a merchant cannot re-read is one they cannot withdraw.
    expect(html).toContain("How I welcome a new buyer");
    expect(html).toContain("lovely to have you on board");
    expect(html).toContain("Remove this sample");
  });

  it("says the toggles decide nothing without a key", () => {
    const html = render(
      <SettingsPage
        view={view({
          agent: {
            mayScreen: false,
            mayDraft: true,
            noKey: true,
            samples: [],
            samplesWanted: 3,
            mutedBriefings: [],
            draft: { label: "", body: "" },
            removing: null,
            auditHref: "/app/activity",
            retentionMonths: 12,
          },
        })}
      />,
    );

    expect(html).toContain("nothing here runs whichever way these are set");
    expect(html).toContain("No samples yet");
    capture("15-agent-no-key", html);
  });

  it("says that is as many samples as Claude reads, and hides the form", () => {
    const html = render(
      <SettingsPage
        view={view({
          agent: {
            ...view().agent,
            samples: Array.from({ length: 5 }, (_, index) => ({
              id: `s${index}`,
              label: `Sample ${index + 1}`,
              body: `Message ${index + 1}, as the merchant wrote it.`,
              added: "2026-08-14",
            })),
          },
        })}
      />,
    );

    expect(html).toContain("as many samples as Claude reads");
    expect(html).not.toContain("Add this sample");
    capture("16-voice-full", html);
  });

  it("keeps the pasted message when the sample is rejected", () => {
    const html = render(
      <SettingsPage
        view={view({
          failedSection: "agent",
          agent: {
            ...view().agent,
            draft: { label: "", body: "Hi Sam — your trade prices are live now." },
          },
          issues: [
            {
              field: "label",
              message: "Give the sample a name, so you can tell your samples apart.",
            },
          ],
        })}
      />,
    );

    // The body used to be hard-coded `value=""`, so a rejected 3,000-character
    // email was simply gone with the error where it had been.
    expect(html).toContain("your trade prices are live now");
    expect(html).toContain("Give the sample a name");
    capture("17-voice-rejected", html);
  });

  it("confirms before deleting the merchant's own writing", () => {
    const html = render(
      <SettingsPage view={view({ agent: { ...view().agent, removing: "s1" } })} />,
    );

    // A hard delete with no undo, on the same page whose danger zone confirms
    // for less.
    expect(html).toContain("Remove this sample for good?");
    expect(html).toContain("Yes, remove it");
    capture("18-voice-confirm-remove", html);
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
