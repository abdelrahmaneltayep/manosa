import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { ApplicationsPage } from "~/components/customers/ApplicationsPage";
import type { ApplicationRowView, ApplicationsView } from "~/components/customers/types";
import { FormBuilderPage } from "~/components/forms/FormBuilderPage";
import type { FormBuilderView } from "~/components/forms/types";
import type { Locale } from "~/i18n/config";
import { DEFAULT_APPEARANCE, DEFAULT_PUBLISH } from "~/lib/forms/appearance";
import { DEFAULT_APPROVAL } from "~/lib/forms/approval";
import { REJECTION_REASONS } from "~/lib/forms/approval";
import { checkContrast } from "~/lib/forms/contrast";
import { createCaptureHarness, type CaptureHarness } from "../support/state-capture";

/**
 * Every state in checklist §3's "Pending approvals", plus the auto-approval
 * editor the criteria live in.
 */

const OUT = resolve(process.cwd(), "qa/2.3");
/** ✦ Screening and drafted emails are 4.3, on the same page. */
const OUT_43 = resolve(process.cwd(), "qa/4.3");
const outFor = (name: string) => (name.startsWith("ai-") ? OUT_43 : OUT);

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Applications",
    outFor,
    dirs: [OUT, OUT_43],
  });
});

/* -------------------------------------------------------------------------- */

const row = (overrides: Partial<ApplicationRowView> = {}): ApplicationRowView => ({
  id: "s1",
  company: "Acme Ltd",
  contact: "Sam Reed",
  email: "sam@acme.test",
  formName: "Wholesale application",
  daysAgo: 2,
  submittedAt: "2026-05-30T09:00:00.000Z",
  vatStatus: "VALID",
  vatNote: null,
  uploads: [],
  criteria: null,
  sameDomainCount: 0,
  existingCustomer: false,
  screening: { status: "off", reasons: [] },
  ...overrides,
});

const view = (overrides: Partial<ApplicationsView> = {}): ApplicationsView => ({
  rows: [],
  total: 0,
  page: 1,
  pageSize: 25,
  totalWaiting: 0,
  search: "",
  groups: [
    { id: "g1", name: "Gold", terms: "Net 30 days" },
    { id: "g2", name: "Silver", terms: null },
  ],
  shareUrl: "https://mannon.test/f/abc123",
  loading: false,
  undo: null,
  undoExpired: false,
  editing: null,
  rejectionReasons: [...REJECTION_REASONS],
  aiScreening: false,
  emailDraft: { drafted: false, failure: null },
  emailUnavailable: false,
  ...overrides,
});

const builderView = (overrides: Partial<FormBuilderView> = {}): FormBuilderView => ({
  id: "f1",
  name: "Wholesale application",
  slug: "wholesale-application",
  status: "DRAFT",
  tab: "publish",
  fields: [],
  appearance: { ...DEFAULT_APPEARANCE },
  emails: {
    confirmation: { subject: "Got it", body: "Hi" },
    approved: { subject: "Welcome", body: "In" },
    rejected: { subject: "Sorry", body: "No" },
    needs_info: { subject: "More", body: "?" },
  },
  publish: { ...DEFAULT_PUBLISH },
  approval: { ...DEFAULT_APPROVAL },
  approvalIssues: [],
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
  vatExample: null,
  saving: false,
  ...overrides,
});

/* -------------------------------------------------------------------------- */

describe("queue states", () => {
  it("empty — the link to share, right there", () => {
    const html = render(<ApplicationsPage view={view()} />);
    capture("01-queue-empty", html);

    expect(html).toContain("No applications waiting");
    expect(html).toContain("https://mannon.test/f/abc123");
  });

  it("empty with no form yet — points at the thing that has to exist first", () => {
    const html = render(<ApplicationsPage view={view({ shareUrl: null })} />);
    capture("02-queue-no-form", html);

    expect(html).toContain("Create a registration form");
    expect(html).not.toContain("Your form's link");
  });

  it("loading — three skeleton rows, hidden from assistive tech", () => {
    const html = render(<ApplicationsPage view={view({ loading: true })} />);
    capture("03-queue-loading", html);

    expect(html).toContain('accessibilityVisibility="hidden"');
  });

  it("ideal — company, contact, how long they have waited, and the actions", () => {
    const html = render(
      <ApplicationsPage
        view={view({
          // The ideal queue is the one with screening working, not the one with
          // it switched off — that is the state below, and for one commit both
          // captures were the same picture.
          rows: [
            row({
              screening: {
                status: "recommend",
                reasons: [
                  { signal: "vat_valid", detail: null },
                  { signal: "years_established", detail: 12 },
                ],
              },
            }),
          ],
          total: 1,
          totalWaiting: 1,
          aiScreening: true,
        })}
      />,
    );
    capture("04-queue-ideal", html);

    expect(html).toContain("Acme Ltd");
    expect(html).toContain("2 days ago");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    expect(html).toContain("Nothing here looks wrong");
  });

  it("screening is off, and says so without blocking approval", () => {
    const html = render(
      <ApplicationsPage view={view({ rows: [row()], total: 1, totalWaiting: 1 })} />,
    );
    // Named for what it is: the whole feature switched off. The per-row
    // "could not screen this one" verdict is `ai-04-screening-unavailable`.
    capture("05-queue-screening-off", html);

    expect(html).toContain("Screening is off");
    // The checklist's rule: it has never blocked approving anybody.
    expect(html).toContain("Approve");
    expect(html).not.toContain("disabled");
  });

  it("criteria met — with the working, not just the verdict", () => {
    const html = render(
      <ApplicationsPage
        view={view({
          rows: [
            row({
              criteria: {
                met: true,
                reasons: [
                  { field: "vat_valid", met: true },
                  { field: "years_in_business", met: true, detail: "2" },
                ],
              },
            }),
          ],
          total: 1,
          totalWaiting: 1,
        })}
      />,
    );
    capture("06-queue-criteria-met", html);

    expect(html).toContain("Meets your approval criteria");
    expect(html).toContain("VAT number confirmed by VIES");
    expect(html).toContain("In business at least 2 years");
  });

  it("criteria not met — names which line failed", () => {
    const html = render(
      <ApplicationsPage
        view={view({
          rows: [
            row({
              vatStatus: "UNVERIFIED",
              vatNote: "vies_unreachable",
              criteria: {
                met: false,
                reasons: [
                  { field: "vat_valid", met: false },
                  { field: "years_in_business", met: true, detail: "2" },
                ],
              },
            }),
          ],
          total: 1,
          totalWaiting: 1,
        })}
      />,
    );
    capture("07-queue-criteria-not-met", html);

    expect(html).toContain("Does not meet your approval criteria");
    // Unverified is not wrong, and the row says which it is.
    expect(html).toContain("Unverified is not the same as wrong");
    expect(html).toContain("VIES could not be reached");
    // And each line says whether it passed: a list that mixes the two without
    // marking them hides the one thing the merchant opened it to find.
    expect(html).toContain("Not met");
    expect(html).toContain("Met");
  });

  it("edges — already a customer, and others from the same domain", () => {
    const html = render(
      <ApplicationsPage
        view={view({
          rows: [
            row({ existingCustomer: true, sameDomainCount: 2 }),
            row({
              id: "s2",
              company: "Bright Supply",
              email: "ops@bright.test",
              uploads: [{ id: "u1", fileName: "licence.pdf", scanned: false }],
            }),
          ],
          total: 2,
          totalWaiting: 2,
        })}
      />,
    );
    capture("08-queue-edges", html);

    // Approving will attach to the account they have rather than making a
    // second one that splits their order history.
    expect(html).toContain("Already a customer");
    expect(html).toContain("2 other applications from this domain");
    expect(html).toContain("Not virus-scanned");
  });

  it("a rejection cannot be sent without a reason", () => {
    const html = render(
      <ApplicationsPage view={view({ rows: [row()], total: 1, totalWaiting: 1 })} />,
    );
    // No blank option in the reason list: a rejection nobody gave a reason for
    // is one nobody can answer for.
    const reasonSelect = html.slice(html.indexOf('name="reason"'));
    expect(reasonSelect.slice(0, 400)).not.toContain('<s-option value="">');
    expect(html).toContain("Also block acme.test");
  });

  it("the undo window, with the seconds left", () => {
    const html = render(
      <ApplicationsPage
        view={view({ undo: { id: "s1", who: "Acme Ltd", secondsLeft: 8 } })}
      />,
    );
    capture("09-queue-undo", html);

    expect(html).toContain("Acme Ltd approved");
    expect(html).toContain("8 seconds to take this back");
  });

  it("undo after the window says what to do instead", () => {
    const html = render(<ApplicationsPage view={view({ undoExpired: true })} />);
    capture("10-queue-undo-expired", html);

    expect(html).toContain("Too late to undo");
    // Reversing an approval after the fact is a decision, and needs a reason.
    expect(html).toContain("which is a decision with a reason");
  });

  it("says plainly when no applicant is being emailed", () => {
    const html = render(
      <ApplicationsPage
        view={view({ rows: [row()], total: 1, totalWaiting: 1, emailUnavailable: true })}
      />,
    );
    capture("11-queue-no-email", html);

    expect(html).toContain("No email is going out");
    expect(html).toContain("Approving still works");
  });

  it("editing the email before sending it", () => {
    const html = render(
      <ApplicationsPage
        view={view({
          rows: [row()],
          total: 1,
          totalWaiting: 1,
          editing: {
            id: "s1",
            intent: "approve",
            subject: "Welcome {{company}}",
            body: "You are in.",
            reason: "",
            note: "",
          },
        })}
      />,
    );
    capture("12-queue-edit-email", html);

    expect(html).toContain("The email they will get when you approve them");
    expect(html).toContain("Send and approve");
  });

  it("no results is a different screen from an empty queue", () => {
    const html = render(
      <ApplicationsPage
        view={view({ rows: [], total: 0, totalWaiting: 12, search: "zzz" })}
      />,
    );
    capture("13-queue-no-results", html);

    expect(html).toContain("Nothing matched that search");
    expect(html).not.toContain("No applications waiting");
  });

  it("paginates a long queue", () => {
    const html = render(
      <ApplicationsPage
        view={view({ rows: [row()], total: 80, totalWaiting: 80, page: 2 })}
      />,
    );
    capture("14-queue-paginated", html);

    expect(html).toContain("26–50 of 80");
  });

  it("renders in Arabic, right to left", () => {
    const html = render(
      <ApplicationsPage view={view({ rows: [row()], total: 1, totalWaiting: 1 })} />,
      "ar",
    );
    capture("15-queue-arabic", html, "ar");

    expect(html).toContain("الطلبات");
    expect(html).not.toContain("No applications waiting");
  });
});

describe("the auto-approval editor", () => {
  it("off, with nothing set — every application waits for a person", () => {
    const html = render(<FormBuilderPage view={builderView()} />);
    capture("16-approval-off", html);

    expect(html).toContain("Off unless you switch it on");
    expect(html).toContain("every application waits for you");
  });

  it("shows the criteria as sentences", () => {
    const html = render(
      <FormBuilderPage
        view={builderView({
          approval: {
            enabled: true,
            otherwise: "review",
            criteria: [
              { field: "vat_valid" },
              { field: "years_in_business", atLeast: 2 },
              { field: "country", op: "in", values: ["SA", "AE"] },
            ],
          },
        })}
      />,
    );
    capture("17-approval-criteria", html);

    expect(html).toContain("Approve when all of these are true");
    expect(html).toContain("They have been trading at least 2 years");
    expect(html).toContain("SA, AE");
  });

  it("flags being switched on with nothing to check", () => {
    const html = render(
      <FormBuilderPage
        view={builderView({
          approval: { enabled: true, otherwise: "review", criteria: [] },
          approvalIssues: [{ code: "no_criteria" }],
        })}
      />,
    );
    capture("18-approval-empty-rule", html);

    expect(html).toContain("switched on with nothing to check");
  });

  it("says what rejecting automatically means before it is chosen", () => {
    const html = render(<FormBuilderPage view={builderView()} />);
    expect(html).toContain("turns somebody away without a person reading it");
  });
});

/* -------------------------------------------------------------------------- */
/* ✦ Screening and drafted emails — checklist §3, phase 4.3                    */
/* -------------------------------------------------------------------------- */

describe("✦ screening", () => {
  const screened = (
    status: ApplicationRowView["screening"]["status"],
    reasons: ApplicationRowView["screening"]["reasons"] = [],
  ) =>
    view({
      rows: [row({ screening: { status, reasons } })],
      total: 1,
      totalWaiting: 1,
      aiScreening: true,
    });

  it("says it is still checking, and lets the merchant decide anyway", () => {
    const html = render(<ApplicationsPage view={screened("waiting")} />);

    expect(html).toContain("Checking their details");
    expect(html).toContain("You can decide without it");
    expect(html).toContain("Approve");
    capture("ai-01-screening-waiting", html);
  });

  it("recommends, with the reasons in our words", () => {
    const html = render(
      <ApplicationsPage
        view={screened("recommend", [
          { signal: "vat_valid", detail: null },
          { signal: "years_established", detail: 12 },
          { signal: "business_email_domain", detail: null },
        ])}
      />,
    );

    expect(html).toContain("Nothing here looks wrong");
    expect(html).toContain("Their VAT id checked out");
    expect(html).toContain("In business 12 years");
    // Every reason is ours, translated from a code — never a model's sentence.
    expect(html).not.toContain("vat_valid");
    capture("ai-02-screening-recommend", html);
  });

  it("flags one worth reading, without deciding anything", () => {
    const html = render(
      <ApplicationsPage
        view={screened("look", [
          { signal: "free_email_domain", detail: null },
          { signal: "website_mismatch", detail: null },
          { signal: "duplicate_domain", detail: 2 },
        ])}
      />,
    );

    expect(html).toContain("Worth reading before you approve");
    expect(html).toContain("free email address");
    expect(html).toContain("2 other applications are waiting");
    // Neither button is touched by a verdict.
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    capture("ai-03-screening-look", html);
  });

  it("says it could not screen, rather than showing a clean bill of health", () => {
    const html = render(<ApplicationsPage view={screened("unavailable")} />);

    expect(html).toContain("Screening unavailable");
    expect(html).not.toContain("Nothing here looks wrong");
    capture("ai-04-screening-unavailable", html);
  });

  it("renders a verdict in Arabic", () => {
    const html = render(
      <ApplicationsPage
        view={screened("look", [{ signal: "free_email_domain", detail: null }])}
      />,
      "ar",
    );

    expect(html).toContain("يستحق القراءة قبل الموافقة");
    expect(html).toContain("قدّموا الطلب من بريد مجاني");
    capture("ai-05-screening-arabic", html, "ar");
  });

  it("pluralises a count-bearing reason rather than printing its key", () => {
    const html = render(
      <ApplicationsPage
        view={screened("look", [{ signal: "documents_unscanned", detail: 1 }])}
      />,
    );
    expect(html).toContain("1 document has not been virus-scanned");
    expect(html).not.toContain("applications.signal");
  });
});

describe("✦ drafted emails", () => {
  it("offers a draft link only when there is a key", () => {
    const withKey = render(
      <ApplicationsPage
        view={view({ rows: [row()], total: 1, totalWaiting: 1, aiScreening: true })}
      />,
    );
    const withoutKey = render(
      <ApplicationsPage view={view({ rows: [row()], total: 1, totalWaiting: 1 })} />,
    );

    expect(withKey).toContain("draft=1");
    expect(withoutKey).not.toContain("draft=1");
    // The manual path is there either way.
    expect(withoutKey).toContain("Edit email");
  });

  it("says who wrote the draft, above the send box", () => {
    const html = render(
      <ApplicationsPage
        view={view({
          rows: [row()],
          total: 1,
          totalWaiting: 1,
          aiScreening: true,
          emailDraft: { drafted: true, failure: null },
          editing: {
            id: "s1",
            intent: "reject",
            subject: "About your trade account",
            body: "Hi {{first_name}}, we are not able to open one just now. {{reason}}",
            reason: "",
            note: "",
          },
        })}
      />,
    );

    expect(html).toContain("Drafted by Claude");
    expect(html).toContain("You send it, not the AI");
    expect(html).toContain("About your trade account");
    capture("ai-06-email-drafted", html);
  });

  it("falls back to the merchant's own template, and says the draft failed", () => {
    const html = render(
      <ApplicationsPage
        view={view({
          rows: [row()],
          total: 1,
          totalWaiting: 1,
          aiScreening: true,
          emailDraft: { drafted: false, failure: "timeout" },
          editing: {
            id: "s1",
            intent: "reject",
            subject: "Sorry {{company}}",
            body: "{{reason}}",
            reason: "",
            note: "",
          },
        })}
      />,
    );

    expect(html).toContain("Claude did not answer in time");
    expect(html).toContain("your own template is below");
    expect(html).toContain("Sorry {{company}}");
    capture("ai-07-email-draft-failed", html);
  });
});
