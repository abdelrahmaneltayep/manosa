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

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Applications",
    outFor: () => OUT,
    dirs: [OUT],
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
      <ApplicationsPage view={view({ rows: [row()], total: 1, totalWaiting: 1 })} />,
    );
    capture("04-queue-ideal", html);

    expect(html).toContain("Acme Ltd");
    expect(html).toContain("2 days ago");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
  });

  it("screening is unavailable, and says so without blocking approval", () => {
    const html = render(
      <ApplicationsPage view={view({ rows: [row()], total: 1, totalWaiting: 1 })} />,
    );
    capture("05-queue-screening-unavailable", html);

    expect(html).toContain("Screening unavailable");
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
