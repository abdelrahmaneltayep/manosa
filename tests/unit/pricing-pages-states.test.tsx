import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { PricingSettingsPage } from "~/components/pricing/PricingSettingsPage";
import { RuleBuilderPage } from "~/components/pricing/RuleBuilderPage";
import { RuleListPage } from "~/components/pricing/RuleListPage";
import type {
  RuleBuilderView,
  RuleListView,
  RuleRowView,
  PricingSettingsView,
} from "~/components/pricing/types";
import { dirFor, type Locale } from "~/i18n/config";
import { createI18n } from "~/i18n/i18next";
import { emptyFormView } from "~/lib/pricing/view-model.server";

/**
 * Every state in checklist §2, rendered and asserted.
 *
 * The embedded admin cannot be driven outside the Shopify iframe and this
 * environment has no egress to the Polaris CDN, so this is where these states
 * are actually exercised. QA_CAPTURE=1 also writes each one to qa/1.3/.
 */

const CAPTURE = process.env.QA_CAPTURE === "1";
const OUT = resolve(process.cwd(), "qa/1.3");
const instances = new Map<Locale, Awaited<ReturnType<typeof createI18n>>>();

beforeAll(async () => {
  for (const locale of ["en", "ar"] as Locale[]) {
    instances.set(locale, await createI18n(locale));
  }
  if (CAPTURE) mkdirSync(OUT, { recursive: true });
});

function render(node: React.ReactNode, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={instances.get(locale)!}>{node}</I18nextProvider>,
  );
}

const STYLES = `
 body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
   margin:0;padding:1.5rem;background:#f6f6f7;color:#1c1d2b}
 .note{background:#fff4e4;border:1px solid #e0b252;border-radius:8px;padding:.75rem 1rem;
   margin-bottom:1.25rem;font-size:12px;color:#5e4200}
 s-page,s-section,s-box{display:block}
 s-section,s-box{background:#fff;border:1px solid #e3e3e3;border-radius:10px;
   padding:1rem;margin-bottom:1rem}
 s-stack{display:flex;gap:.45rem}
 s-stack[direction=block]{flex-direction:column;align-items:flex-start}
 s-stack[direction=inline]{flex-direction:row;align-items:center;flex-wrap:wrap}
 s-heading{display:block;font-weight:700;margin:.25rem 0}
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
 s-banner[tone=success]{border-color:#1f8a53;background:#e7f7ee}
 s-badge{display:inline-block;background:#eef0ff;color:#4f46e5;border-radius:999px;
   padding:.1rem .55rem;font-size:12px;margin-inline-end:.4rem}
 s-button{display:inline-block;background:#4f46e5;color:#fff;border-radius:8px;
   padding:.45rem .9rem;margin-inline-end:.5rem;font-weight:700}
 s-button[variant=tertiary]{background:transparent;color:#4f46e5;font-weight:600}
 s-button[disabled]{opacity:.45}
 s-table{display:table;width:100%;border-collapse:collapse}
 s-table-body{display:table-row-group}
 s-table-header-row,s-table-row{display:table-row}
 s-table-header,s-table-cell{display:table-cell;padding:.4rem .5rem;
   border-bottom:1px solid #eee;text-align:start;vertical-align:top}
 s-table-header{font-weight:700}
 s-text-field,s-number-field,s-money-field,s-select,s-text-area,s-date-field,
 s-search-field,s-checkbox{display:block;margin:.4rem 0}
 s-text-field::before,s-number-field::before,s-money-field::before,
 s-select::before,s-text-area::before,s-date-field::before,
 s-search-field::before,s-checkbox::before{content:attr(label);display:block;
   font-weight:600;font-size:12px;margin-bottom:.15rem}
 s-text-field::after,s-number-field::after,s-money-field::after,
 s-select::after,s-text-area::after,s-date-field::after{
   content:attr(value);display:block;border:1px solid #d5d5d5;border-radius:6px;
   padding:.35rem .5rem;min-height:1.1em;background:#fff;color:#444}
 s-ordered-list{display:block;padding-inline-start:1.2rem}
 s-unordered-list{display:block;padding-inline-start:1.1rem}
 s-list-item{display:list-item;margin:.3rem 0}
 s-link{color:#4f46e5;text-decoration:underline;margin-inline-end:.6rem}
 s-text[accessibilityvisibility=exclusive]{position:absolute;width:1px;height:1px;
   overflow:hidden;clip-path:inset(50%)}
 ui-save-bar{display:none}
`;

function capture(name: string, html: string, locale: Locale = "en") {
  if (!CAPTURE) return;
  writeFileSync(
    resolve(OUT, `${name}.html`),
    `<!doctype html><html lang="${locale}" dir="${dirFor(locale)}"><head>
<meta charset="utf-8"><title>Pricing — ${name}</title><style>${STYLES}</style></head><body>
<div class="note"><strong>QA capture — structure only.</strong> Polaris web components
are not upgraded here: this build environment has no egress to Shopify's CDN, so the
styling below is a plain stand-in and is <em>not</em> what a merchant sees. What this
capture verifies is which content and which states render.</div>
${html}</body></html>\n`,
  );
}

/* -------------------------------------------------------------------------- */

const row = (overrides: Partial<RuleRowView> = {}): RuleRowView => ({
  id: "r1",
  name: "Wholesale 35%",
  kind: "percentage",
  status: "active",
  priority: 100,
  targetsSummary: "Every product",
  audienceSummary: "Tagged wholesale",
  usage30d: null,
  unused: false,
  missingTargetCount: 0,
  startsInDays: null,
  endsInDays: null,
  ended: false,
  duplicateName: false,
  archivedAt: null,
  ...overrides,
});

const listView = (overrides: Partial<RuleListView> = {}): RuleListView => ({
  rows: [],
  total: 0,
  page: 1,
  pageSize: 50,
  totalUnfiltered: 0,
  search: "",
  archived: false,
  sort: "priority",
  unreadableCount: 0,
  cachedMinutesAgo: null,
  published: { ruleCount: 0, at: null },
  publishError: null,
  atRuleLimit: false,
  aiAvailable: false,
  ...overrides,
});

const builderView = (overrides: Partial<RuleBuilderView> = {}): RuleBuilderView => ({
  form: emptyFormView("USD"),
  issues: [],
  duplicateName: null,
  preview: null,
  conflict: null,
  saving: false,
  ...overrides,
});

describe("rule list states", () => {
  it("empty — offers both ways in, and is honest that Claude is not ready", () => {
    const html = render(<RuleListPage view={listView()} />);
    capture("01-list-empty", html);

    expect(html).toContain("No pricing rules yet");
    expect(html).toContain("Describe a rule");
    expect(html).toContain("Create manually");
    // Claude drafts rules in 4.2; the control is visible but disabled rather
    // than absent, so the merchant knows it is coming.
    expect(html).toContain('disabled="true"');
  });

  it("partial — two rules, no filter bar", () => {
    const html = render(
      <RuleListPage
        view={listView({
          rows: [row(), row({ id: "r2", name: "Gold tier", kind: "volume_tier" })],
          total: 2,
          totalUnfiltered: 2,
        })}
      />,
    );
    capture("02-list-partial", html);

    expect(html).toContain("Gold tier");
    // Two rules do not need a search box; the controls would outnumber the data.
    expect(html).not.toContain("Search rules by name");
  });

  it("ideal — the filter bar appears from three rules", () => {
    const rows = [
      row(),
      row({ id: "r2", name: "Gold tier" }),
      row({ id: "r3", name: "VIP" }),
    ];
    const html = render(
      <RuleListPage view={listView({ rows, total: 3, totalUnfiltered: 3 })} />,
    );
    capture("03-list-ideal", html);
    expect(html).toContain("Search rules by name");
  });

  it("badges — missing targets, schedule, duplicate name, unused", () => {
    const html = render(
      <RuleListPage
        view={listView({
          rows: [
            row({ missingTargetCount: 2 }),
            row({ id: "r2", name: "Starts soon", startsInDays: 3 }),
            row({ id: "r3", name: "Summer tiers", duplicateName: true }),
            row({ id: "r4", name: "Old rule", usage30d: 0, unused: true }),
            row({ id: "r5", name: "Finished", ended: true }),
          ],
          total: 5,
          totalUnfiltered: 5,
        })}
      />,
    );
    capture("04-list-badges", html);

    expect(html).toContain("2 targets missing");
    expect(html).toContain("Starts in 3 days");
    expect(html).toContain("Another rule is also called");
    expect(html).toContain("Unused");
    expect(html).toContain("Ended");
  });

  /**
   * A rule created yesterday with no uses is new, not unused. Flagging it would
   * be telling the merchant something untrue.
   */
  it("does not call a never-measured rule unused", () => {
    const html = render(
      <RuleListPage view={listView({ rows: [row()], total: 1, totalUnfiltered: 1 })} />,
    );
    expect(html).not.toContain("Unused");
    expect(html).toContain("Usage is counted once you have wholesale orders");
  });

  it("no search results — different from empty", () => {
    const html = render(
      <RuleListPage view={listView({ search: "gold", total: 0, totalUnfiltered: 7 })} />,
    );
    capture("05-list-no-results", html);

    expect(html).toContain("No rules match");
    expect(html).not.toContain("No pricing rules yet");
  });

  it("error — a cached list, marked as cached", () => {
    const html = render(
      <RuleListPage
        view={listView({
          rows: [row()],
          total: 1,
          totalUnfiltered: 1,
          cachedMinutesAgo: 2,
        })}
      />,
    );
    capture("06-list-cached", html);

    expect(html).toContain("Showing the last list we loaded");
    expect(html).toContain("loaded 2 minutes ago");
    expect(html).toContain("Try again");
  });

  it("publish failed — the rules saved, checkout did not update", () => {
    const html = render(
      <RuleListPage
        view={listView({
          rows: [row()],
          total: 1,
          totalUnfiltered: 1,
          publishError: "too_large",
        })}
      />,
    );
    capture("07-list-publish-failed", html);

    expect(html).toContain("Too many rules to send to checkout");
    // Says what the buyer currently sees, not just that something failed.
    expect(html).toContain("checkout still has the previous set");
  });

  it("at the plan's rule limit", () => {
    const html = render(
      <RuleListPage
        view={listView({
          rows: [row()],
          total: 1,
          totalUnfiltered: 1,
          atRuleLimit: true,
        })}
      />,
    );
    capture("08-list-at-limit", html);
    expect(html).toContain('disabled="true"');
  });

  it("archived tab, empty", () => {
    const html = render(<RuleListPage view={listView({ archived: true })} />);
    capture("09-list-archived-empty", html);
    expect(html).toContain("Nothing archived");
    expect(html).toContain("30 days");
  });

  it("paginates past one page", () => {
    // A realistic second page: fifty rows of a hundred and twenty.
    const rows = Array.from({ length: 50 }, (_, index) =>
      row({ id: `r${index}`, name: `Rule ${index + 51}` }),
    );
    const html = render(
      <RuleListPage
        view={listView({ rows, total: 120, totalUnfiltered: 120, page: 2, pageSize: 50 })}
      />,
    );
    capture("10-list-paginated", html);

    expect(html).toContain("51–100 of 120");
    expect(html).toContain("Previous");
    expect(html).toContain("Next");
  });
});

describe("rule builder states", () => {
  it("new — an empty form", () => {
    const html = render(<RuleBuilderPage view={builderView()} />);
    capture("11-builder-new", html);

    expect(html).toContain("New pricing rule");
    expect(html).toContain("Rule name");
    // The combination warning the checklist asks for, before it can bite.
    expect(html).toContain("reduce a price to zero");
  });

  it("validation — errors beside the fields that caused them", () => {
    const html = render(
      <RuleBuilderPage
        view={builderView({
          form: { ...emptyFormView("USD"), name: "", percentage: "150" },
          issues: [
            { code: "name_required", field: "name" },
            {
              code: "percentage_out_of_range",
              field: "value.percentage",
              params: { percentage: 150 },
            },
          ],
        })}
      />,
    );
    capture("12-builder-errors", html);

    // The exact wording the checklist names.
    expect(html).toContain("Name is required. Please input.");
    expect(html).toContain("Enter a percentage between 0 and 100.");
  });

  it("overlapping tiers, named the way the checklist words it", () => {
    const html = render(
      <RuleBuilderPage
        view={builderView({
          form: {
            ...emptyFormView("USD"),
            kind: "volume_tier",
            tiers: [
              { minQuantity: "10", maxQuantity: "49", kind: "percentage", value: "5" },
              { minQuantity: "40", maxQuantity: "60", kind: "percentage", value: "12" },
            ],
          },
          issues: [
            {
              code: "tier_overlap",
              field: "value.tiers.1",
              params: { first: "10–49", second: "40–60" },
            },
          ],
        })}
      />,
    );
    capture("13-builder-tier-overlap", html);
    expect(html).toContain("10–49 overlaps 40–60.");
  });

  it("live preview of what a matching buyer pays", () => {
    const html = render(
      <RuleBuilderPage
        view={builderView({
          preview: {
            was: "100.00",
            now: "65.00",
            changed: true,
            quantity: 10,
            unavailable: false,
          },
        })}
      />,
    );
    capture("14-builder-preview", html);

    expect(html).toContain("65.00");
    expect(html).toContain("Live preview");
  });

  /** A broken preview must never stop a merchant saving their work. */
  it("preview unavailable, and saving still offered", () => {
    const html = render(
      <RuleBuilderPage
        view={builderView({
          preview: { was: "", now: "", changed: false, quantity: 10, unavailable: true },
        })}
      />,
    );
    capture("15-builder-preview-unavailable", html);

    expect(html).toContain("does not stop you saving");
    expect(html).toContain("Save");
  });

  it("conflict — someone else saved while this was open", () => {
    const html = render(
      <RuleBuilderPage
        view={builderView({
          form: { ...emptyFormView("USD"), id: "r1", version: 1 },
          conflict: {
            name: "Wholesale 35%",
            theirVersion: 2,
            theirUpdatedAt: "2026-09-08T10:00:00Z",
          },
        })}
      />,
    );
    capture("16-builder-conflict", html);

    expect(html).toContain("Someone else changed this rule");
    expect(html).toContain("Nothing has been overwritten");
    expect(html).toContain("Overwrite with mine");
    expect(html).toContain("Keep theirs and reload");
  });

  it("duplicate name is a warning, not a block", () => {
    const html = render(
      <RuleBuilderPage view={builderView({ duplicateName: "Summer tiers" })} />,
    );
    capture("17-builder-duplicate-name", html);
    expect(html).toContain("Another rule is also called");
    expect(html).toContain("Save");
  });
});

describe("priority and combinations", () => {
  const settings = (
    overrides: Partial<PricingSettingsView> = {},
  ): PricingSettingsView => ({
    order: [
      { id: "r1", name: "Contract price", kind: "fixed_price", combinable: false },
      { id: "r2", name: "Gold tier", kind: "volume_tier", combinable: true },
    ],
    anyCombinable: true,
    explain: null,
    explainInput: { variantId: "", tags: "wholesale", quantity: "10", price: "100.00" },
    orderSaved: false,
    ...overrides,
  });

  it("shows the order and warns about combining", () => {
    const html = render(<PricingSettingsPage view={settings()} />);
    capture("18-settings-order", html);

    expect(html).toContain("Which rule wins");
    expect(html).toContain("reduce a price to zero");
    // Reordering must be reachable from a keyboard, not drag-only.
    expect(html).toContain("Move up");
  });

  it("why this price — every skipped rule says why", () => {
    const html = render(
      <PricingSettingsPage
        view={settings({
          explain: {
            unitPrice: "88.00",
            basePrice: "100.00",
            clampedAtZero: false,
            trace: [
              {
                ruleId: "r1",
                ruleName: "Contract price",
                applied: false,
                reason: "audience_mismatch",
                priceAfter: null,
              },
              {
                ruleId: "r2",
                ruleName: "Gold tier",
                applied: true,
                reason: null,
                priceAfter: "88.00",
              },
            ],
          },
        })}
      />,
    );
    capture("19-settings-explain", html);

    expect(html).toContain("88.00 per unit");
    expect(html).toContain("Applied");
    // The reason is the answer the merchant came for.
    expect(html).toContain("This buyer doesn&#x27;t match");
  });

  it("why this price — no rules match", () => {
    const html = render(
      <PricingSettingsPage
        view={settings({
          explain: {
            unitPrice: "100.00",
            basePrice: "100.00",
            clampedAtZero: false,
            trace: [],
          },
        })}
      />,
    );
    capture("20-settings-explain-none", html);
    expect(html).toContain("they pay the shelf price");
  });

  it("why this price — stacking reached zero", () => {
    const html = render(
      <PricingSettingsPage
        view={settings({
          explain: {
            unitPrice: "0.00",
            basePrice: "100.00",
            clampedAtZero: true,
            trace: [
              {
                ruleId: "r1",
                ruleName: "Half off",
                applied: true,
                reason: null,
                priceAfter: "0.00",
              },
            ],
          },
        })}
      />,
    );
    capture("21-settings-explain-zero", html);
    expect(html).toContain("The buyer pays nothing for this item");
  });
});

describe("Arabic", () => {
  it("renders the list mirrored and translated", () => {
    const html = render(
      <RuleListPage
        view={listView({
          rows: [row({ missingTargetCount: 3, startsInDays: 3 })],
          total: 1,
          totalUnfiltered: 1,
        })}
      />,
      "ar",
    );
    capture("22-list-arabic", html, "ar");

    expect(html).toContain("قواعد التسعير");
    // Arabic's "few" category, which English does not have.
    expect(html).toContain("3 أهداف مفقودة");
    expect(html).toContain("تبدأ خلال 3 أيام");
    expect(html).not.toContain("Pricing rules");
  });

  it("renders the builder in Arabic", () => {
    const html = render(<RuleBuilderPage view={builderView()} />, "ar");
    capture("23-builder-arabic", html, "ar");
    expect(html).toContain("قاعدة تسعير جديدة");
  });
});
