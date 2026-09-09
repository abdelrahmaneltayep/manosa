import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { FormBuilderPage } from "~/components/forms/FormBuilderPage";
import { FormListPage } from "~/components/forms/FormListPage";
import { PublicForm, type PublicFormView } from "~/components/forms/PublicForm";
import type {
  FormBuilderView,
  FormCardView,
  FormListView,
} from "~/components/forms/types";
import type { Locale } from "~/i18n/config";
import { DEFAULT_APPEARANCE, DEFAULT_PUBLISH } from "~/lib/forms/appearance";
import { checkContrast } from "~/lib/forms/contrast";
import type { FormField } from "~/lib/forms/schema";
import {
  createCaptureHarness,
  REAL_NOTE,
  type CaptureHarness,
} from "../support/state-capture";

/**
 * Every state in checklist §4, rendered and asserted.
 *
 * The buyer-facing form is also driven for real in tests/e2e/public-form.spec.ts
 * — it is our own page on our own domain, so unlike the embedded admin it can
 * be exercised in a browser, with JavaScript switched off.
 */

const OUT = resolve(process.cwd(), "qa/2.2");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);
/** The buyer-facing form is plain HTML, so its captures are the real page. */
const captureReal = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale, REAL_NOTE);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Forms",
    outFor: () => OUT,
    dirs: [OUT],
  });
});

/* -------------------------------------------------------------------------- */

const card = (overrides: Partial<FormCardView> = {}): FormCardView => ({
  id: "f1",
  name: "Wholesale application",
  slug: "wholesale-application",
  status: "LIVE",
  submissions30d: 24,
  views30d: 300,
  conversion: 8,
  lastEditedAt: "2026-05-30T09:00:00.000Z",
  publicUrl: "https://mannon.test/f/abc123",
  blockingIssues: 0,
  ...overrides,
});

const listView = (overrides: Partial<FormListView> = {}): FormListView => ({
  rows: [],
  templates: [
    { key: "minimal", name: "Minimal", description: "Name, email, company." },
    { key: "standard", name: "Standard", description: "The usual balance." },
    { key: "strict", name: "Strict verification", description: "Fewest applications." },
  ],
  atFormLimit: false,
  requiredPlan: null,
  aiAvailable: false,
  ...overrides,
});

const field = (
  overrides: Partial<FormField> & Pick<FormField, "key" | "kind">,
): FormField => ({
  label: overrides.key,
  required: false,
  showWhen: null,
  ...overrides,
});

const FIELDS: FormField[] = [
  field({ key: "first_name", kind: "text", label: "First name", required: true }),
  field({ key: "email", kind: "email", label: "Email", required: true }),
  field({ key: "company", kind: "company", label: "Company", required: true }),
  field({
    key: "business_type",
    kind: "select",
    label: "Type of business",
    required: true,
    options: ["Retailer", "Distributor"],
  }),
  field({ key: "vat", kind: "vat", label: "VAT / tax registration number" }),
  field({
    key: "licence",
    kind: "file",
    label: "Trade licence",
    required: true,
    showWhen: { field: "business_type", equals: "Distributor" },
  }),
  field({
    key: "privacy",
    kind: "privacy",
    label: "I agree to the privacy policy",
    required: true,
  }),
];

const builderView = (overrides: Partial<FormBuilderView> = {}): FormBuilderView => ({
  id: "f1",
  name: "Wholesale application",
  slug: "wholesale-application",
  status: "DRAFT",
  tab: "configuration",
  fields: FIELDS.map((entry, index) => ({ ...entry, index, canBeCondition: true })),
  appearance: { ...DEFAULT_APPEARANCE },
  emails: {
    confirmation: { subject: "We have your application", body: "Hi {{first_name}}" },
    approved: { subject: "You are in", body: "Welcome" },
    rejected: { subject: "About your application", body: "{{reason}}" },
    needs_info: { subject: "One more thing", body: "{{reason}}" },
  },
  publish: { ...DEFAULT_PUBLISH },
  groups: [{ id: "g1", name: "Gold" }],
  definitionIssues: [],
  emailIssues: [],
  contrast: {
    text: checkContrast(DEFAULT_APPEARANCE.text, DEFAULT_APPEARANCE.background),
    accent: checkContrast(DEFAULT_APPEARANCE.accentText, DEFAULT_APPEARANCE.accent),
  },
  publicUrl: "https://mannon.test/f/abc123",
  recent: [],
  recentTotal: 0,
  testSend: null,
  vatExample: "SA300000000000003",
  saving: false,
  ...overrides,
});

const publicView = (
  overrides: Partial<PublicFormView> = {},
  locale: Locale = "en",
): PublicFormView => ({
  action: "/f/abc123",
  name: "Wholesale application",
  intro: null,
  fields: FIELDS,
  appearance: { ...DEFAULT_APPEARANCE },
  answers: {},
  issues: [],
  renderedAt: 1_780_000_000_000,
  dir: locale === "ar" ? "rtl" : "ltr",
  ...overrides,
});

/* -------------------------------------------------------------------------- */

describe("forms list states", () => {
  it("empty — three templates, each saying what it trades", () => {
    const html = render(<FormListPage view={listView()} />);
    capture("01-forms-empty", html);

    expect(html).toContain("No registration form yet");
    // The real decision is how much to ask for, so the trade-off is on screen.
    expect(html).toContain("every extra question costs you applications");
    expect(html).toContain("Strict verification");
  });

  it("✦ generate is offered but disabled until the AI layer lands", () => {
    const html = render(<FormListPage view={listView()} />);
    expect(html).toContain("✦ Describe your form");
    expect(html).toContain("disabled");
  });

  it("ideal — status, applications, conversion and last edited", () => {
    const html = render(
      <FormListPage view={listView({ rows: [card()], templates: [] })} />,
    );
    capture("02-forms-ideal", html);

    expect(html).toContain("Live");
    expect(html).toContain("24 applications in 30 days");
    expect(html).toContain("8% of visitors applied");
  });

  it("a form nobody has opened has no conversion rate, not zero per cent", () => {
    const html = render(
      <FormListPage
        view={listView({
          rows: [
            card({ views30d: 0, submissions30d: 0, conversion: null, status: "DRAFT" }),
          ],
          templates: [],
        })}
      />,
    );
    capture("03-forms-never-viewed", html);

    expect(html).toContain("Nobody has opened it yet");
    expect(html).not.toContain("0% of visitors");
  });

  it("flags a form that cannot go live", () => {
    const html = render(
      <FormListPage
        view={listView({
          rows: [card({ status: "DRAFT", blockingIssues: 2 })],
          templates: [],
        })}
      />,
    );
    capture("04-forms-has-issues", html);

    expect(html).toContain("2 things to fix");
  });

  it("over quota — the existing form keeps working", () => {
    const html = render(
      <FormListPage
        view={listView({ rows: [card()], atFormLimit: true, requiredPlan: "pro" })}
      />,
    );
    capture("05-forms-at-limit", html);

    expect(html).toContain("Your plan includes one form");
    expect(html).toContain("keeps working either way");
    expect(html).toContain("disabled");
  });
});

describe("builder states", () => {
  it("configuration — fields, with keyboard reorder and the VAT example", () => {
    const html = render(<FormBuilderPage view={builderView()} />);
    capture("06-builder-configuration", html);

    // The checklist asks for keyboard support; a button is the keyboard
    // support, so reorder is not drag-only.
    expect(html).toContain("Move First name up");
    expect(html).toContain("Example for your country: SA300000000000003");
    expect(html).toContain("Shown only when business_type is “Distributor”.");
  });

  it("the first field cannot move up and the last cannot move down", () => {
    const html = render(<FormBuilderPage view={builderView()} />);
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("a form with no fields says so instead of showing an empty list", () => {
    const html = render(<FormBuilderPage view={builderView({ fields: [] })} />);
    capture("07-builder-no-fields", html);

    expect(html).toContain("asks nothing yet");
  });

  it("issues — a draft may be unfinished, and this says what blocks publishing", () => {
    const html = render(
      <FormBuilderPage
        view={builderView({
          definitionIssues: [
            { code: "no_email_field" },
            { code: "condition_cycle", key: "a", detail: "a → b → a" },
          ],
          emailIssues: [
            { email: "confirmation", code: "unknown_tag", detail: "firstname" },
          ],
        })}
      />,
    );
    capture("08-builder-issues", html);

    expect(html).toContain("This form cannot go live yet");
    expect(html).toContain("A draft can be unfinished");
    expect(html).toContain("none of them can ever appear");
    // The consequence, not the rule: it would go out to a buyer as written.
    expect(html).toContain("would go out to a buyer as written");
  });

  it("appearance — contrast passes", () => {
    const html = render(<FormBuilderPage view={builderView({ tab: "appearance" })} />);
    capture("09-builder-appearance", html);

    expect(html).toContain("That passes");
  });

  it("appearance — the grey the checklist calls out fails, and says what to change", () => {
    const appearance = { ...DEFAULT_APPEARANCE, text: "#999999" };
    const html = render(
      <FormBuilderPage
        view={builderView({
          tab: "appearance",
          appearance,
          contrast: {
            text: checkContrast(appearance.text, appearance.background),
            accent: checkContrast(appearance.accentText, appearance.accent),
          },
        })}
      />,
    );
    capture("10-builder-contrast-fails", html);

    expect(html).toContain("below the 4.5:1");
    expect(html).toContain("Darken the text or lighten the background");
  });

  it("appearance — a colour that is not a colour", () => {
    const appearance = { ...DEFAULT_APPEARANCE, text: "chartreuse" };
    const html = render(
      <FormBuilderPage
        view={builderView({
          tab: "appearance",
          appearance,
          contrast: {
            text: checkContrast(appearance.text, appearance.background),
            accent: checkContrast(appearance.accentText, appearance.accent),
          },
        })}
      />,
    );
    capture("11-builder-contrast-unreadable", html);

    expect(html).toContain("not a colour we can read");
  });

  it("emails — the four templates and the merge tags", () => {
    const html = render(<FormBuilderPage view={builderView({ tab: "emails" })} />);
    capture("12-builder-emails", html);

    expect(html).toContain("{{first_name}}");
    expect(html).toContain("Send a test to myself");
  });

  it("emails — a test send with no sender says nothing was sent", () => {
    const html = render(
      <FormBuilderPage view={builderView({ tab: "emails", testSend: "no_sender" })} />,
    );
    capture("13-builder-no-sender", html);

    // A button that reports success while sending nothing is how a merchant
    // finds out from an applicant who never got a confirmation.
    expect(html).toContain("Nothing was sent");
  });

  it("publish — link, block instructions and the spam default", () => {
    const html = render(<FormBuilderPage view={builderView({ tab: "publish" })} />);
    capture("14-builder-publish", html);

    expect(html).toContain("https://mannon.test/f/abc123");
    expect(html).toContain("Wholesale registration");
    expect(html).toContain("checked");
  });

  it("publish is refused while the form has problems", () => {
    const html = render(
      <FormBuilderPage
        view={builderView({
          tab: "publish",
          definitionIssues: [{ code: "no_email_field" }],
        })}
      />,
    );
    capture("15-builder-publish-blocked", html);

    expect(html).toContain("Fix the problems above first");
    expect(html).toContain("disabled");
  });

  it("publish — a live form offers to unpublish, never disabled", () => {
    const html = render(
      <FormBuilderPage
        view={builderView({
          tab: "publish",
          status: "LIVE",
          definitionIssues: [{ code: "no_email_field" }],
        })}
      />,
    );
    // A form already taking applications must always be stoppable, even if it
    // has since become invalid.
    expect(html).toContain("Unpublish");
    expect(html).not.toContain("Fix the problems above first");
  });

  it("publish — applications, with unscanned uploads labelled", () => {
    const html = render(
      <FormBuilderPage
        view={builderView({
          tab: "publish",
          recentTotal: 3,
          recent: [
            {
              id: "s1",
              who: "Acme Ltd",
              at: "2026-06-01T10:00:00.000Z",
              status: "PENDING",
              vatStatus: "UNVERIFIED",
              uploads: [{ id: "u1", fileName: "licence.pdf", scanned: false }],
            },
            {
              id: "s2",
              who: "Bright Supply",
              at: "2026-05-31T10:00:00.000Z",
              status: "PENDING",
              vatStatus: "VALID",
              uploads: [],
            },
          ],
        })}
      />,
    );
    capture("16-builder-applications", html);

    expect(html).toContain("Not virus-scanned");
    expect(html).toContain("VAT unverified");
    expect(html).toContain("/app/forms/upload/u1");
  });
});

describe("the buyer's form", () => {
  it("renders every field, and the honeypot nobody can see", () => {
    const html = render(<PublicForm view={publicView()} />);
    captureReal("17-public-form", html);

    expect(html).toContain("Send application");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('name="website"');
    // Pushed off-screen it would overflow a right-to-left document; clipping
    // hides it in both directions and creates no scrollable area.
    expect(html).not.toContain("-9999px");
    expect(html).toContain("clip-path:inset(50%)");
    // The render timestamp is what catches a form filled in in a millisecond.
    expect(html).toContain('name="_t"');
  });

  it("renders a conditional field too, because hiding it needs JavaScript", () => {
    const html = render(<PublicForm view={publicView()} />);
    // The server does not require an answer to a field its condition excludes,
    // so showing it costs a question rather than costing the applicant a field
    // they can never fill in.
    expect(html).toContain("Trade licence");
    expect(html).toContain('data-show-when-field="business_type"');
  });

  it("errors — a summary at the top, linked, and inline on each field", () => {
    const html = render(
      <PublicForm
        view={publicView({
          answers: { first_name: "Sam", email: "not-an-email" },
          issues: [
            { key: "email", code: "email_format" },
            { key: "company", code: "required" },
            { key: "privacy", code: "privacy_required" },
          ],
        })}
      />,
    );
    captureReal("18-public-errors", html);

    expect(html).toContain('role="alert"');
    expect(html).toContain('href="#field-email"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("does not look like an email address");
    // What the buyer typed survives the round trip.
    expect(html).toContain('value="not-an-email"');
  });

  it("a file that is too big says by how much", () => {
    const html = render(
      <PublicForm
        view={publicView({
          issues: [{ key: "licence", code: "too_long", detail: String(6 * 1024 * 1024) }],
        })}
      />,
    );
    captureReal("19-public-file-too-large", html);

    expect(html).toContain("6.0 MB");
    expect(html).toContain("the limit is 5 MB");
  });

  it("a file of the wrong type names the type", () => {
    const html = render(
      <PublicForm
        view={publicView({
          issues: [
            { key: "licence", code: "not_an_option", detail: "application/vnd.ms-excel" },
          ],
        })}
      />,
    );
    captureReal("20-public-file-type", html);

    expect(html).toContain("application/vnd.ms-excel");
    expect(html).toContain("Send a PDF, JPG or PNG");
  });

  it("a boxed layout honours the merchant's colours and width", () => {
    const html = render(
      <PublicForm
        view={publicView({
          appearance: {
            ...DEFAULT_APPEARANCE,
            layout: "boxed",
            width: 480,
            accent: "#0a7d55",
          },
        })}
      />,
    );
    captureReal("21-public-boxed", html);

    expect(html).toContain("480px");
    expect(html).toContain("#0a7d55");
  });

  it("renders right to left in Arabic, including the file control", () => {
    const html = render(<PublicForm view={publicView({}, "ar")} />, "ar");
    captureReal("22-public-arabic", html, "ar");

    expect(html).toContain("إرسال الطلب");
    expect(html).toContain("(مطلوب)");
    expect(html).not.toContain("Send application");
  });

  it("shows Arabic error wording, not English", () => {
    const html = render(
      <PublicForm
        view={publicView({ issues: [{ key: "email", code: "email_format" }] }, "ar")}
      />,
      "ar",
    );
    captureReal("23-public-arabic-errors", html, "ar");

    expect(html).toContain("يرجى مراجعة ما يلي");
    expect(html).not.toContain("Please check");
  });
});
