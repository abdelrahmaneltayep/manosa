import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { CsvPage, type CsvView } from "~/components/pricing/CsvPage";
import { PricingSettingsPage } from "~/components/pricing/PricingSettingsPage";
import { RuleBuilderPage } from "~/components/pricing/RuleBuilderPage";
import { RuleListPage } from "~/components/pricing/RuleListPage";
import type {
  RuleBuilderView,
  RuleListView,
  RuleRowView,
  PricingSettingsView,
} from "~/components/pricing/types";
import type { Locale } from "~/i18n/config";
import { emptyFormView } from "~/lib/pricing/view-model.server";
import { createCaptureHarness, type CaptureHarness } from "../support/state-capture";

/**
 * Every state in checklist §2, rendered and asserted.
 *
 * The embedded admin cannot be driven outside the Shopify iframe and this
 * environment has no egress to the Polaris CDN, so this is where these states
 * are actually exercised. QA_CAPTURE=1 also writes each one to qa/1.3/.
 */

const OUT_13 = resolve(process.cwd(), "qa/1.3");
const OUT_14 = resolve(process.cwd(), "qa/1.4");
/** ✦ The CSV whisperer's mapping screen is 4.3, on the same page. */
const OUT_43 = resolve(process.cwd(), "qa/4.3");
/** Captures numbered 24 and up belong to task 1.4 (CSV import/export). */
const outFor = (name: string) =>
  name.startsWith("ai-") ? OUT_43 : Number(name.slice(0, 2)) >= 24 ? OUT_14 : OUT_13;

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Pricing",
    outFor,
    dirs: [OUT_13, OUT_14, OUT_43],
  });
});

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
  collectionsPending: null,
  search: "",
  archived: false,
  sort: "priority",
  unreadableCount: 0,
  cachedMinutesAgo: null,
  published: { ruleCount: 0, at: null },
  publishError: null,
  atRuleLimit: false,
  aiAvailable: false,
  archiveRetentionDays: 30,
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

  /**
   * A rule that depends on collection membership, live before checkout has
   * been told what is in them.
   *
   * The membership reaches checkout only through a metafield this app writes,
   * and publishing a whole catalogue takes many queued pages. While that runs,
   * a rule excluding a collection excludes nothing at checkout — the buyer is
   * discounted on exactly the products the merchant protected. Nothing said
   * so, which is Invariant 4.
   */
  it("partial — collection rules are live while the catalogue is still publishing", () => {
    const html = render(
      <RuleListPage
        view={listView({
          rows: [row()],
          total: 1,
          totalUnfiltered: 1,
          collectionsPending: { published: 420, ruleCount: 2 },
        })}
      />,
    );
    capture("18-list-collections-pending", html);

    // Pluralised on the rule count, and carrying the real published figure —
    // not "some products", which is a sentence that tells a merchant nothing.
    expect(html).toContain("2 rules use collections");
    expect(html).toContain("420 products");
    // It needs nothing from them, and says so rather than implying an action.
    expect(html).toContain("runs on its own");
  });

  it("says nothing when no rule uses collections", () => {
    const html = render(
      <RuleListPage view={listView({ rows: [row()], total: 1, totalUnfiltered: 1 })} />,
    );

    expect(html).not.toContain("still publishing");
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

describe("boolean attributes on Polaris elements", () => {
  /**
   * React stringifies props on a custom element, so a boolean passed straight
   * through renders as the string "false" — which a browser reads as the
   * attribute being set. Both of these were live defects found in the 2.1 QA
   * pass; they are asserted here so they cannot come back.
   */
  it("does not disable the ✦ button the day the AI layer ships", () => {
    const html = render(<RuleListPage view={listView({ aiAvailable: true })} />);
    expect(html).not.toContain('disabled="false"');
    expect(html).not.toContain('disabled=""');
  });

  it("does not show the combinations box ticked on a rule that does not combine", () => {
    const html = render(
      <RuleBuilderPage
        view={builderView({
          form: { ...emptyFormView("USD"), combinable: false },
        })}
      />,
    );
    expect(html).not.toContain('checked="false"');
  });

  it("still ticks the box on a rule that does combine", () => {
    const html = render(
      <RuleBuilderPage
        view={builderView({ form: { ...emptyFormView("USD"), combinable: true } })}
      />,
    );
    expect(html).toContain("checked");
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

  it("says there is nothing to preview yet, not that the preview broke", () => {
    const html = render(<RuleBuilderPage view={builderView()} />);

    // A new form has nothing to price. Reporting a failure that never happened
    // is the same defect as claiming a success that never happened.
    expect(html).toContain("a sample price will appear here");
    expect(html).not.toContain("Preview unavailable");
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

/* -------------------------------------------------------------------------- */

const csvView = (overrides: Partial<CsvView> = {}): CsvView => ({
  step: "choose",
  mapping: null,
  fileError: null,
  review: null,
  imported: null,
  undone: null,
  undoExpired: false,
  ...overrides,
});

const review = (overrides: Partial<NonNullable<CsvView["review"]>> = {}) => ({
  draftId: "draft-1",
  fileName: "june-prices.csv",
  template: "rules" as const,
  columns: [
    { header: "rule_name", matched: true },
    { header: "type", matched: true },
    { header: "notes", matched: false },
  ],
  totalRows: 220,
  willCreate: 214,
  errors: [],
  warnings: [],
  tooLarge: null,
  ...overrides,
});

describe("CSV import states", () => {
  it("choose — the templates and the upload", () => {
    const html = render(<CsvPage view={csvView()} />);
    capture("24-csv-choose", html);

    expect(html).toContain("Download template");
    expect(html).toContain("CSV only, up to 10 MB");
    expect(html).toContain("Quantity breaks");
  });

  it("file too big, with the limit and what to do", () => {
    const html = render(
      <CsvPage view={csvView({ fileError: { code: "too_large", sizeMb: 24 } })} />,
    );
    capture("25-csv-too-large", html);

    expect(html).toContain("24 MB");
    expect(html).toContain("Split it");
  });

  it("too many rows, with both numbers", () => {
    const html = render(
      <CsvPage
        view={csvView({
          fileError: { code: "too_many_rows", rows: 80000, limit: 50000 },
        })}
      />,
    );
    capture("26-csv-too-many-rows", html);
    expect(html).toContain("80000");
    expect(html).toContain("50000");
  });

  it("columns we do not recognise", () => {
    const html = render(
      <CsvPage view={csvView({ fileError: { code: "unknown_template" } })} />,
    );
    capture("27-csv-unknown-columns", html);
    expect(html).toContain("don&#x27;t recognise those columns");
  });

  /** "214 will import, 6 errors" — the checklist's own example. */
  it("dry run — what the file would do", () => {
    const html = render(
      <CsvPage
        view={csvView({
          step: "review",
          review: review({
            errors: [
              {
                line: 12,
                column: "skus",
                code: "unknown_sku",
                params: { sku: "NOPE-9" },
              },
            ],
            warnings: [{ line: 40, code: "zero_value" }],
          }),
        })}
      />,
    );
    capture("28-csv-dry-run", html);

    expect(html).toContain("214 rules will be created");
    expect(html).toContain("1 row has a problem");
    // Listed with its line, never just counted.
    expect(html).toContain("NOPE-9");
    expect(html).toContain("Download the problem list");
    // An unmatched column is shown as ignored rather than silently dropped.
    expect(html).toContain("notes");
    expect(html).toContain("Ignored");
  });

  it("dry run — nothing importable, so the button is off", () => {
    const html = render(
      <CsvPage
        view={csvView({
          step: "review",
          review: review({
            willCreate: 0,
            errors: [
              { line: 2, column: "type", code: "unknown_type", params: { value: "x" } },
            ],
          }),
        })}
      />,
    );
    capture("29-csv-dry-run-blocked", html);

    expect(html).toContain("Nothing in this file can be imported yet");
    expect(html).toContain('disabled="true"');
  });

  /**
   * Publishing fails on the whole set, so this has to be said before the
   * import rather than after checkout is left on the old prices.
   */
  it("dry run — the import would be too big for checkout", () => {
    const html = render(
      <CsvPage
        view={csvView({
          step: "review",
          review: review({ tooLarge: { bytes: 60 * 1024, limit: 48 * 1024 } }),
        })}
      />,
    );
    capture("30-csv-too-big-for-checkout", html);

    expect(html).toContain("too big for checkout");
    expect(html).toContain("Nothing has been imported");
    expect(html).toContain('disabled="true"');
  });

  it("imported — with undo offered", () => {
    const html = render(
      <CsvPage
        view={csvView({ step: "imported", imported: { count: 214, importId: "imp-1" } })}
      />,
    );
    capture("31-csv-imported", html);

    expect(html).toContain("Imported 214 rules");
    expect(html).toContain("Undo this import");
  });

  it("undone", () => {
    const html = render(
      <CsvPage view={csvView({ step: "undone", undone: { count: 214 } })} />,
    );
    capture("32-csv-undone", html);
    expect(html).toContain("Import undone");
    expect(html).toContain("Nothing else changed");
  });

  /** The hour removes the shortcut, not the data — say which. */
  it("undo expired", () => {
    const html = render(<CsvPage view={csvView({ undoExpired: true })} />);
    capture("33-csv-undo-expired", html);

    expect(html).toContain("no longer be undone in one click");
    expect(html).toContain("archive the rules individually");
  });

  it("renders in Arabic", () => {
    const html = render(
      <CsvPage view={csvView({ step: "review", review: review() })} />,
      "ar",
    );
    capture("34-csv-arabic", html, "ar");

    expect(html).toContain("ما سيفعله هذا الملف");
    expect(html).not.toContain("will be created");
  });
});

/* -------------------------------------------------------------------------- */
/* ✦ The CSV whisperer's mapping screen — spec §2, phase 4.3                   */
/* -------------------------------------------------------------------------- */

describe("✦ column mapping", () => {
  const mapping = (
    overrides: Partial<NonNullable<CsvView["mapping"]>> = {},
  ): NonNullable<CsvView["mapping"]> => ({
    draftId: "draft-1",
    fileName: "supplier-prices-march.csv",
    template: "rules",
    rows: [
      {
        header: "item_code",
        column: "skus",
        confidence: "high",
        samples: ["SKU-1", "SKU-2"],
      },
      {
        header: "discount_%",
        column: "value",
        confidence: "medium",
        samples: ["15", "20"],
      },
      { header: "notes", column: "", confidence: "low", samples: ["spring list"] },
    ],
    targets: [
      { key: "rule_name", required: true },
      { key: "type", required: true },
      { key: "value", required: true },
      { key: "skus", required: false },
    ],
    notes: null,
    aiFailure: null,
    missingRequired: [],
    ...overrides,
  });

  it("shows every column, what it was matched to, and how sure that is", () => {
    const html = render(<CsvPage view={csvView({ step: "map", mapping: mapping() })} />);

    expect(html).toContain("Match your columns");
    expect(html).toContain("supplier-prices-march.csv");
    expect(html).toContain("item_code");
    // The samples are what makes a mapping checkable rather than trusted.
    expect(html).toContain("SKU-1, SKU-2");
    expect(html).toContain("Confident");
    expect(html).toContain("Fairly sure");
    expect(html).toContain("Guess — check this");
    capture("ai-10-csv-mapping", html);
  });

  it("makes every mapping editable, including ignoring a column", () => {
    const html = render(<CsvPage view={csvView({ step: "map", mapping: mapping() })} />);

    expect(html.match(/name="column:/g)).toHaveLength(3);
    expect(html).toContain("Ignore this column");
  });

  it("says which required column nothing fills", () => {
    const html = render(
      <CsvPage
        view={csvView({
          step: "map",
          mapping: mapping({ missingRequired: ["rule_name", "type"] }),
        })}
      />,
    );

    expect(html).toContain("2 required columns are not matched");
    expect(html).toContain("Rule name");
    capture("ai-11-csv-mapping-missing", html);
  });

  it("shows what Claude said it was unsure about", () => {
    const html = render(
      <CsvPage
        view={csvView({
          step: "map",
          mapping: mapping({
            notes:
              "Two columns could be the discount; I used the one holding percentages.",
          }),
        })}
      />,
    );
    expect(html).toContain("Two columns could be the discount");
  });

  it("still lets the merchant map it when Claude could not", () => {
    const html = render(
      <CsvPage
        view={csvView({
          step: "map",
          mapping: mapping({
            aiFailure: "no_key",
            rows: mapping().rows.map((row) => ({ ...row, column: "" })),
          }),
        })}
      />,
    );

    expect(html).toContain("Column matching is switched off");
    expect(html).toContain("Match the columns yourself");
    // The screen is still fully usable: every select is there.
    expect(html.match(/name="column:/g)).toHaveLength(3);
    capture("ai-12-csv-mapping-no-key", html);
  });

  it("renders in Arabic", () => {
    const html = render(
      <CsvPage view={csvView({ step: "map", mapping: mapping() })} />,
      "ar",
    );
    expect(html).toContain("طابِق أعمدتك");
    capture("ai-13-csv-mapping-arabic", html, "ar");
  });
});
