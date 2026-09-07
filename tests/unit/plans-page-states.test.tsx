import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { PlansPage } from "~/components/plans/PlansPage";
import type { PlansView } from "~/components/plans/types";
import { dirFor, type Locale } from "~/i18n/config";
import { createI18n } from "~/i18n/i18next";
import { meterFor } from "~/lib/billing/usage.server";

/**
 * The Plans page renders every one of its states here.
 *
 * The embedded admin cannot be driven outside the Shopify iframe, and this
 * environment has no egress to the Polaris CDN, so this is where the states in
 * checklist §9 are actually exercised. Set QA_CAPTURE=1 to also write each one
 * to qa/0.3/ for the QA record.
 */

const CAPTURE = process.env.QA_CAPTURE === "1";
const OUT = resolve(process.cwd(), "qa/0.3");

const instances = new Map<Locale, Awaited<ReturnType<typeof createI18n>>>();

beforeAll(async () => {
  for (const locale of ["en", "ar"] as Locale[]) {
    instances.set(locale, await createI18n(locale));
  }
  if (CAPTURE) mkdirSync(OUT, { recursive: true });
});

function render(view: PlansView, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={instances.get(locale)!}>
      <PlansPage view={view} />
    </I18nextProvider>,
  );
}

function capture(name: string, html: string, locale: Locale = "en") {
  if (!CAPTURE) return;
  writeFileSync(
    resolve(OUT, `${name}.html`),
    `<!doctype html><html lang="${locale}" dir="${dirFor(locale)}"><head>
<meta charset="utf-8"><title>Plans — ${name}</title>
<style>
 body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
   margin:0;padding:1.5rem;background:#f6f6f7;color:#1c1d2b}
 .note{background:#fff4e4;border:1px solid #e0b252;border-radius:8px;padding:.75rem 1rem;
   margin-bottom:1.25rem;font-size:12px;color:#5e4200}
 s-page,s-section,s-box{display:block}
 s-stack{display:flex;gap:.45rem}
 s-stack[direction=block]{flex-direction:column;align-items:flex-start}
 s-stack[direction=inline]{flex-direction:row;align-items:center;flex-wrap:wrap}
 s-stack[justifycontent=space-between]{justify-content:space-between;width:100%}
 s-section,s-box{background:#fff;border:1px solid #e3e3e3;border-radius:10px;
   padding:1rem;margin-bottom:1rem}
 s-heading{display:block;font-weight:700;margin:.25rem 0}
 /* App Bridge renders these attributes as headings; the stand-in must too, or
    the capture looks like the heading is missing when it is not. */
 s-page[heading]::before{content:attr(heading);display:block;font-size:20px;
   font-weight:800;margin-bottom:1rem}
 s-section[heading]::before{content:attr(heading);display:block;font-weight:700;
   margin-bottom:.5rem}
 s-banner[heading]::before{content:attr(heading);display:block;font-weight:700}
 s-paragraph{display:block;margin:.35rem 0}
 s-banner{display:block;border-inline-start:4px solid #8a8a8a;background:#fafafa;
   padding:.75rem 1rem;margin:.5rem 0;border-radius:6px}
 s-banner[tone=critical]{border-color:#d64545;background:#fdeaea}
 s-banner[tone=warning]{border-color:#b7791f;background:#fff2dd}
 s-banner[tone=info]{border-color:#2f6bd6;background:#eaf1ff}
 s-badge{display:inline-block;background:#eef0ff;color:#4f46e5;border-radius:999px;
   padding:.1rem .55rem;font-size:12px;margin-inline-end:.4rem}
 s-button{display:inline-block;background:#4f46e5;color:#fff;border-radius:8px;
   padding:.45rem .9rem;margin-inline-end:.5rem;font-weight:700}
 s-button[variant=secondary]{background:#fff;color:#1c1d2b;border:1px solid #d5d5d5}
 s-table{display:table;width:100%;border-collapse:collapse}
 s-table-body{display:table-row-group}
 s-table-header-row,s-table-row{display:table-row}
 s-table-header,s-table-cell{display:table-cell;padding:.35rem .5rem;
   border-bottom:1px solid #eee;text-align:start}
 s-table-header{font-weight:700}
 s-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem}
 s-unordered-list{display:block;padding-inline-start:1.1rem}
 s-list-item{display:list-item}
 s-link{color:#4f46e5;text-decoration:underline;margin-inline-end:.6rem}
 s-text[accessibilityvisibility=exclusive]{position:absolute;width:1px;height:1px;
   overflow:hidden;clip-path:inset(50%)}
</style></head><body>
<div class="note"><strong>QA capture — structure only.</strong> Polaris web components
are not upgraded here: this build environment has no egress to Shopify's CDN, so the
styling below is a plain stand-in and is <em>not</em> what a merchant sees. What this
capture verifies is which content and which states render.</div>
${html}</body></html>\n`,
  );
}

const baseView = (overrides: Partial<PlansView> = {}): PlansView => ({
  plan: "free",
  effectivePlan: "free",
  status: "NONE",
  interval: null,
  selectedInterval: "monthly",
  trialDaysRemaining: null,
  graceDaysRemaining: null,
  currentPeriodEndLabel: null,
  isTest: false,
  meters: [meterFor("pricingRules", 0, 1), meterFor("forms", 0, 1)],
  pendingChange: null,
  error: false,
  ...overrides,
});

describe("Plans page states", () => {
  it("Free, nothing used yet", () => {
    const html = render(baseView());
    capture("01-free-empty", html);

    expect(html).toContain("Free");
    expect(html).toContain("Pro");
    expect(html).toContain("Growth");
    expect(html).toContain("Agentic");
    // Current plan is always visible.
    expect(html).toContain("Current plan");
    // No warnings when there is nothing to warn about.
    expect(html).not.toContain("close to your");
  });

  it("Free, quota reached", () => {
    const html = render(
      baseView({ meters: [meterFor("pricingRules", 1, 1), meterFor("forms", 0, 1)] }),
    );
    capture("02-free-at-limit", html);

    expect(html).toContain("reached your");
    // The wall explains the way past it rather than just refusing.
    expect(html).toContain("Upgrade to add more");
    expect(html).toContain("keeps working");
  });

  it("warns before the wall, at 80%", () => {
    const html = render(
      baseView({
        effectivePlan: "free",
        meters: [meterFor("pricingRules", 8, 10), meterFor("forms", 0, 1)],
      }),
    );
    capture("03-nearing-limit", html);
    expect(html).toContain("close to your");
    expect(html).toContain("8");
  });

  it("Pro, active", () => {
    const html = render(
      baseView({
        plan: "pro",
        effectivePlan: "pro",
        status: "ACTIVE",
        interval: "monthly",
        meters: [meterFor("pricingRules", 14, null), meterFor("forms", 2, null)],
      }),
    );
    capture("04-pro-active", html);

    expect(html).toContain("14 used");
    expect(html).not.toContain("close to your");
  });

  it("trial running, with days left on the badge", () => {
    const html = render(
      baseView({
        plan: "pro",
        effectivePlan: "pro",
        status: "TRIAL",
        interval: "monthly",
        trialDaysRemaining: 9,
        meters: [meterFor("pricingRules", 3, null), meterFor("forms", 1, null)],
      }),
    );
    capture("05-trial", html);

    expect(html).toContain("9 days left in your trial");
    // Nine days out is a pill, not an interruption.
    expect(html).not.toContain("Your trial ends in");
  });

  it("trial ending, which earns a banner", () => {
    const html = render(
      baseView({
        plan: "pro",
        effectivePlan: "pro",
        status: "TRIAL",
        interval: "monthly",
        trialDaysRemaining: 2,
        meters: [meterFor("pricingRules", 3, null), meterFor("forms", 1, null)],
      }),
    );
    capture("06-trial-ending", html);

    expect(html).toContain("Your trial ends in 2 days");
    expect(html).toContain("$29 a month");
    // No pressure language — Built for Shopify forbids it.
    expect(html).toContain("Nothing is deleted");
  });

  it("charge failed, inside the grace period", () => {
    const html = render(
      baseView({
        plan: "growth",
        effectivePlan: "growth",
        status: "PAST_DUE",
        interval: "monthly",
        graceDaysRemaining: 5,
        meters: [meterFor("pricingRules", 22, null), meterFor("forms", 3, null)],
      }),
    );
    capture("07-past-due", html);

    expect(html).toContain("couldn&#x27;t take the last payment");
    expect(html).toContain("5 more days");
    // The plan still applies — that is the point of the grace period.
    expect(html).toContain("Growth");
  });

  it("subscription cancelled, features paused and data kept", () => {
    const html = render(
      baseView({
        plan: "growth",
        effectivePlan: "free",
        status: "CANCELLED",
        meters: [meterFor("pricingRules", 22, 1), meterFor("forms", 3, 1)],
      }),
    );
    capture("08-cancelled", html);

    expect(html).toContain("Paid features are paused");
    expect(html).toContain("Nothing has been deleted");
  });

  it("annual pricing, with the saving shown", () => {
    const html = render(baseView({ selectedInterval: "annual" }));
    capture("09-annual", html);

    expect(html).toContain("$290/year");
    expect(html).toContain("Save $58 a year");
    expect(html).toContain("$990/year");
  });

  it("upgrade confirmation, explaining proration before any charge", () => {
    const html = render(
      baseView({
        plan: "pro",
        effectivePlan: "pro",
        status: "ACTIVE",
        interval: "monthly",
        pendingChange: {
          to: "growth",
          toInterval: "monthly",
          direction: "upgrade",
          price: 59,
          gaining: ["net_terms", "merchant_agent"],
          losing: [],
          limitImpacts: [],
          hasOverage: false,
        },
      }),
    );
    capture("10-upgrade-confirm", html);

    expect(html).toContain("Switch to Growth");
    expect(html).toContain("credit you for the unused part");
    expect(html).toContain("Net payment terms");
    expect(html).toContain("Continue to Shopify");
  });

  it("downgrade confirmation, naming exactly what pauses", () => {
    const html = render(
      baseView({
        plan: "growth",
        effectivePlan: "growth",
        status: "ACTIVE",
        interval: "monthly",
        currentPeriodEndLabel: "1 July 2026",
        pendingChange: {
          to: "free",
          toInterval: "monthly",
          direction: "downgrade",
          price: 0,
          gaining: [],
          losing: ["net_terms", "merchant_agent", "csv_import"],
          limitImpacts: [
            { key: "pricingRules", used: 14, becomes: 1, overBy: 13 },
            { key: "forms", used: 1, becomes: 1, overBy: 0 },
          ],
          hasOverage: true,
        },
      }),
    );
    capture("11-downgrade-confirm", html);

    expect(html).toContain("Move to Free");
    // Numbers, not vagueness.
    expect(html).toContain("13");
    expect(html).toContain("Merchant Agent in the admin");
    expect(html).toContain("Nothing is deleted");
    // The merchant keeps what they already paid for.
    expect(html).toContain("1 July 2026");
  });

  it("a failed billing request, with nothing charged", () => {
    const html = render(baseView({ error: true }));
    capture("12-billing-error", html);

    expect(html).toContain("couldn&#x27;t start that change");
    expect(html).toContain("Nothing was charged");
  });

  it("a test subscription says so", () => {
    const html = render(
      baseView({ plan: "pro", effectivePlan: "pro", status: "ACTIVE", isTest: true }),
    );
    capture("13-test-subscription", html);
    expect(html).toContain("no money changes hands");
  });

  it("Arabic, mirrored", () => {
    const html = render(
      baseView({
        plan: "growth",
        effectivePlan: "growth",
        status: "TRIAL",
        interval: "monthly",
        trialDaysRemaining: 3,
        meters: [meterFor("pricingRules", 5, null), meterFor("forms", 2, null)],
      }),
      "ar",
    );
    capture("14-arabic", html, "ar");

    expect(html).toContain("النمو");
    // Arabic's "few" plural category, which English does not have.
    expect(html).toContain("تنتهي فترتك التجريبية خلال 3 أيام");
    expect(html).not.toContain("days left in your trial");
  });
});

describe("no dark patterns", () => {
  it("offers a downgrade with the same control as an upgrade", () => {
    const html = render(
      baseView({ plan: "growth", effectivePlan: "growth", status: "ACTIVE" }),
    );
    // Every plan that is not the current one is reachable in one click, in
    // both directions.
    for (const plan of ["Free", "Pro", "Agentic"]) {
      expect(html).toContain(`Switch to ${plan}`);
    }
  });

  it("uses no urgency or guilt language anywhere on the page", () => {
    const html = [
      render(baseView()),
      render(
        baseView({
          status: "TRIAL",
          plan: "pro",
          effectivePlan: "pro",
          trialDaysRemaining: 1,
        }),
      ),
      render(baseView({ status: "CANCELLED", plan: "growth" })),
    ].join(" ");

    for (const phrase of [
      "hurry",
      "act now",
      "don't miss",
      "last chance",
      "only today",
      "are you sure you want to lose",
    ]) {
      expect(html.toLowerCase()).not.toContain(phrase);
    }
  });
});
