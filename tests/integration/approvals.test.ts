import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { setEmailTransport, type EmailTransport } from "~/lib/email/send.server";
import { DEFAULT_APPEARANCE, DEFAULT_PUBLISH } from "~/lib/forms/appearance";
import { DEFAULT_APPROVAL, type ApprovalCriteria } from "~/lib/forms/approval";
import {
  AlreadyDecidedError,
  approveSubmission,
  blockDomain,
  isDomainBlocked,
  listBlockedDomains,
  rejectSubmission,
  requestMoreInformation,
  undoApproval,
  UndoWindowClosedError,
  UNDO_WINDOW_MS,
} from "~/lib/forms/decisions.server";
import { createForm } from "~/lib/forms/forms.server";
import type { EmailTemplates } from "~/lib/forms/merge-tags";
import { listApplications } from "~/lib/forms/queue.server";
import type { FormDefinition } from "~/lib/forms/schema";
import { RENDERED_AT_FIELD, submitForm } from "~/lib/forms/submissions.server";
import { decideApplications } from "~/lib/jobs/handlers/decide-applications.server";
import { createGroup } from "~/lib/customers/groups.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const actor = { type: "STAFF" as const, id: "staff-1" };
const NOW = new Date("2026-06-01T12:00:00Z");

/* -------------------------------------------------------------------------- */

interface AdminCall {
  query: string;
  variables: Record<string, unknown>;
}

/** An Admin API that knows about one existing customer, if we tell it to. */
function fakeAdmin(options: { existing?: boolean } = {}) {
  const calls: AdminCall[] = [];

  const node = (id: string, tags: string[] = []) => ({
    id,
    email: "buyer@acme.test",
    firstName: "Sam",
    lastName: "Reed",
    phone: null,
    state: "ENABLED",
    taxExempt: false,
    tags,
    numberOfOrders: "0",
    amountSpent: { amount: "0.00", currencyCode: "USD" },
    lastOrder: null,
    defaultAddress: { company: "Acme Ltd", countryCodeV2: "SA", provinceCode: null },
  });

  const admin: AdminGraphql & { calls: AdminCall[] } = {
    calls,
    graphql: vi.fn(
      async (query: string, opts?: { variables?: Record<string, unknown> }) => {
        calls.push({ query, variables: opts?.variables ?? {} });

        if (query.includes("MannonCustomerByEmail")) {
          return {
            json: async () => ({
              data: {
                customers: {
                  nodes: options.existing
                    ? [node("gid://shopify/Customer/1", ["retail"])]
                    : [],
                },
              },
            }),
          };
        }
        if (query.includes("MannonCustomerCreate")) {
          return {
            json: async () => ({
              data: {
                customerCreate: {
                  customer: node("gid://shopify/Customer/9"),
                  userErrors: [],
                },
              },
            }),
          };
        }

        const data = query.includes("MannonCustomerTagsAdd")
          ? { tagsAdd: { userErrors: [] } }
          : query.includes("MannonCustomerTagsRemove")
            ? { tagsRemove: { userErrors: [] } }
            : { metafieldsSet: { metafields: [], userErrors: [] } };

        return { json: async () => ({ data }) };
      },
    ),
  };

  return admin;
}

const queried = (admin: { calls: AdminCall[] }, name: string) =>
  admin.calls.filter((call) => call.query.includes(name));

/** A transport that records instead of sending. */
function recordingTransport() {
  const sent: { to: string; subject: string; body: string; reason: string }[] = [];
  const transport: EmailTransport = {
    name: "test",
    async send(email) {
      sent.push({ ...email });
    },
  };
  return { transport, sent };
}

/* -------------------------------------------------------------------------- */

const emails = (): EmailTemplates => ({
  confirmation: { subject: "Got it", body: "Hi {{first_name}}" },
  approved: { subject: "Welcome {{company}}", body: "You are in, {{group_name}}" },
  rejected: { subject: "Sorry {{company}}", body: "{{reason}}" },
  needs_info: { subject: "One more thing", body: "{{reason}}" },
});

const definition = (): FormDefinition => ({
  v: 1,
  fields: [
    {
      key: "first_name",
      kind: "text",
      label: "First name",
      required: true,
      showWhen: null,
    },
    {
      key: "last_name",
      kind: "text",
      label: "Last name",
      required: false,
      showWhen: null,
    },
    { key: "email", kind: "email", label: "Email", required: true, showWhen: null },
    { key: "company", kind: "company", label: "Company", required: true, showWhen: null },
    {
      key: "years",
      kind: "years_in_business",
      label: "Years",
      required: false,
      showWhen: null,
    },
    { key: "vat", kind: "vat", label: "VAT", required: false, showWhen: null },
  ],
});

const answers = (overrides: Record<string, string> = {}) => ({
  first_name: "Sam",
  last_name: "Reed",
  email: "buyer@acme.test",
  company: "Acme Ltd",
  years: "5",
  [RENDERED_AT_FIELD]: String(NOW.getTime() - 30_000),
  ...overrides,
});

const headers = (ip = "203.0.113.5") => new Headers({ "x-forwarded-for": ip });

async function installShop(shop: string) {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: { ...tenant(), planKey: "pro", billingStatus: "ACTIVE", countryCode: "SA" },
    }),
  );
}

async function liveForm(overrides: Record<string, unknown> = {}) {
  const created = await createForm(
    {
      name: "Wholesale application",
      definition: definition(),
      appearance: { ...DEFAULT_APPEARANCE },
      emails: emails(),
      publish: { ...DEFAULT_PUBLISH, autoTags: ["wholesale"] },
      ...overrides,
    },
    actor,
  );
  return db.registrationForm.update({
    where: { id: created.id },
    data: { status: "LIVE" },
  });
}

async function apply(
  form: { id: string; status: string },
  extra: Record<string, string> = {},
) {
  const row = await db.registrationForm.findUniqueOrThrow({ where: { id: form.id } });
  const result = await submitForm({
    form: row,
    answers: answers(extra),
    files: [],
    headers: headers(),
    now: NOW,
    vies: {
      fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch,
    },
  });
  if (!result.ok || "silentlyDropped" in result)
    throw new Error("submission was dropped");
  return result.submission;
}

beforeEach(async () => {
  await resetDatabase();
  setEmailTransport(null);
  delete process.env.MANNON_EMAIL_FROM;
});
afterAll(async () => {
  setEmailTransport(null);
  await prismaBase.$disconnect();
});

/* -------------------------------------------------------------------------- */

describe("approving", () => {
  it("creates the Shopify customer, tags them, and tells checkout", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);
      const gold = await createGroup({ name: "Gold", tag: "gold" }, actor);

      const result = await approveSubmission(
        submission.id,
        { groupId: gold.id },
        { admin, actor, now: NOW },
      );

      expect(result.createdCustomer).toBe(true);
      expect(queried(admin, "MannonCustomerCreate")).toHaveLength(1);
      // The tier's tag and the form's tags go on together.
      expect(queried(admin, "MannonCustomerCreate")[0]!.variables).toMatchObject({
        input: expect.objectContaining({ tags: ["gold", "wholesale"] }),
      });
      // Checkout has to be told, or the admin shows a price the till ignores.
      expect(queried(admin, "MannonSetBuyerFacts")).toHaveLength(1);

      const decided = await db.formSubmission.findUniqueOrThrow({
        where: { id: submission.id },
      });
      expect(decided.status).toBe("APPROVED");
      expect(decided.customerId).toBe("gid://shopify/Customer/9");

      const mirrored = await db.customer.findFirstOrThrow();
      expect(mirrored.groupId).toBe(gold.id);
      expect(mirrored.status).toBe("APPROVED");
    });
  });

  it("attaches to the account they already have rather than making a second", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin({ existing: true });

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);

      const result = await approveSubmission(
        submission.id,
        {},
        { admin, actor, now: NOW },
      );

      // A second account would split their order history in half.
      expect(result.createdCustomer).toBe(false);
      expect(queried(admin, "MannonCustomerCreate")).toHaveLength(0);
      // Additive tagging, so a loyalty app's tag on the retail account lives.
      expect(queried(admin, "MannonCustomerTagsAdd")[0]!.variables.tags).toEqual([
        "wholesale",
      ]);
      expect((await db.customer.findFirstOrThrow()).tags).toContain("retail");
    });
  });

  it("sends the approval email, and records what it sent", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();
    const { transport, sent } = recordingTransport();
    process.env.MANNON_EMAIL_FROM = "hello@acme.test";
    setEmailTransport(transport);

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);
      const gold = await createGroup({ name: "Gold", tag: "gold" }, actor);

      await approveSubmission(
        submission.id,
        { groupId: gold.id },
        { admin, actor, now: NOW },
      );

      const approval = sent.find((email) => email.reason === "approved");
      expect(approval?.to).toBe("buyer@acme.test");
      expect(approval?.subject).toBe("Welcome Acme Ltd");
      expect(approval?.body).toContain("Gold");

      const recorded = await db.emailMessage.findFirst({ where: { kind: "approved" } });
      expect(recorded?.status).toBe("SENT");
      expect(recorded?.submissionId).toBe(submission.id);
    });
  });

  it("records a failure rather than losing the fact that nothing was sent", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();
    // No transport: a merchant must be able to see that nobody was told.
    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);
      await approveSubmission(submission.id, {}, { admin, actor, now: NOW });

      const recorded = await db.emailMessage.findFirstOrThrow({
        where: { kind: "approved" },
      });
      expect(recorded.status).toBe("FAILED");
      expect(recorded.error).toContain("No email sender");
      // And the approval itself stood.
      expect(
        (await db.formSubmission.findUniqueOrThrow({ where: { id: submission.id } }))
          .status,
      ).toBe("APPROVED");
    });
  });

  it("lets the merchant replace the email for one applicant", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();
    const { transport, sent } = recordingTransport();
    process.env.MANNON_EMAIL_FROM = "hello@acme.test";
    setEmailTransport(transport);

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);

      await approveSubmission(
        submission.id,
        { email: { subject: "Just for you", body: "Hello {{company}}" } },
        { admin, actor, now: NOW },
      );

      const approval = sent.find((email) => email.reason === "approved");
      expect(approval?.subject).toBe("Just for you");
      // Merge tags still fill in: it is a different template, not a raw string.
      expect(approval?.body).toBe("Hello Acme Ltd");
      // And the form's own template is untouched for everybody else.
      const stored = await db.registrationForm.findFirstOrThrow();
      expect((stored.emails as { approved: { subject: string } }).approved.subject).toBe(
        "Welcome {{company}}",
      );
    });
  });

  it("refuses to decide the same application twice", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);
      await approveSubmission(submission.id, {}, { admin, actor, now: NOW });

      // Two people working the queue at once.
      await expect(
        approveSubmission(submission.id, {}, { admin, actor, now: NOW }),
      ).rejects.toThrow(AlreadyDecidedError);
      await expect(
        rejectSubmission(submission.id, { reason: "other" }, { admin, actor, now: NOW }),
      ).rejects.toThrow(AlreadyDecidedError);
    });
  });
});

describe("undoing an approval", () => {
  it("takes the tags and the tier back off, and returns it to the queue", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);
      const gold = await createGroup({ name: "Gold", tag: "gold" }, actor);
      await approveSubmission(
        submission.id,
        { groupId: gold.id },
        { admin, actor, now: NOW },
      );

      await undoApproval(submission.id, { admin, actor, now: NOW });

      const restored = await db.formSubmission.findUniqueOrThrow({
        where: { id: submission.id },
      });
      expect(restored.status).toBe("PENDING");
      expect(restored.customerId).toBeNull();

      const mirrored = await db.customer.findFirstOrThrow();
      expect(mirrored.groupId).toBeNull();
      expect(mirrored.tags).not.toContain("gold");
      expect(mirrored.tags).not.toContain("wholesale");

      expect(queried(admin, "MannonCustomerTagsRemove")[0]!.variables.tags).toEqual([
        "gold",
        "wholesale",
      ]);
    });
  });

  it("leaves the Shopify customer in place, and says so", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);
      await approveSubmission(submission.id, {}, { admin, actor, now: NOW });
      await undoApproval(submission.id, { admin, actor, now: NOW });

      // Deleting a customer account is destructive and irreversible; a stray
      // account nobody has used costs nothing.
      expect(await db.customer.count()).toBe(1);
      const entry = await db.auditLog.findFirstOrThrow({
        where: { action: "form.approval_undone" },
      });
      expect(entry.summary).toContain("left in place");
    });
  });

  it("closes after ten seconds", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);
      await approveSubmission(submission.id, {}, { admin, actor, now: NOW });

      const later = new Date(NOW.getTime() + UNDO_WINDOW_MS + 1);
      await expect(
        undoApproval(submission.id, { admin, actor, now: later }),
      ).rejects.toThrow(UndoWindowClosedError);

      expect(
        (await db.formSubmission.findUniqueOrThrow({ where: { id: submission.id } }))
          .status,
      ).toBe("APPROVED");
    });
  });

  it("cannot undo something that was never approved", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);
      await expect(
        undoApproval(submission.id, { admin, actor, now: NOW }),
      ).rejects.toThrow(AlreadyDecidedError);
    });
  });
});

describe("rejecting", () => {
  it("records the reason and tells the applicant what the reviewer typed", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();
    const { transport, sent } = recordingTransport();
    process.env.MANNON_EMAIL_FROM = "hello@acme.test";
    setEmailTransport(transport);

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);

      await rejectSubmission(
        submission.id,
        { reason: "competitor", note: "We do not supply resellers in your city." },
        { admin, actor, now: NOW },
      );

      const decided = await db.formSubmission.findUniqueOrThrow({
        where: { id: submission.id },
      });
      expect(decided.status).toBe("REJECTED");
      expect(decided.rejectionCode).toBe("competitor");

      const email = sent.find((message) => message.reason === "rejected");
      // The reviewer's words, not the internal code: "competitor" is not a
      // sentence to send anyone.
      expect(email?.body).toBe("We do not supply resellers in your city.");
      expect(email?.body).not.toContain("competitor");
    });
  });

  it("can block the domain, and then turns away the next application from it", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);

      await rejectSubmission(
        submission.id,
        { reason: "not_a_business", blockDomain: true },
        { admin, actor, now: NOW },
      );

      expect(await isDomainBlocked("someone@acme.test")).toBe(true);
      expect(await isDomainBlocked("someone@other.test")).toBe(false);
      expect(await listBlockedDomains()).toHaveLength(1);

      const again = await submitForm({
        form: await db.registrationForm.findUniqueOrThrow({ where: { id: form.id } }),
        answers: answers({ email: "another@acme.test" }),
        files: [],
        headers: headers("198.51.100.4"),
        now: NOW,
      });

      // Answered as success: a blocklist a spammer can probe is one that tells
      // them what to change.
      expect(again).toMatchObject({ ok: true, silentlyDropped: true });
      const blocked = await db.formSubmission.findFirstOrThrow({
        where: { email: "another@acme.test" },
      });
      expect(blocked.status).toBe("REJECTED");
      expect(blocked.rejectionCode).toBe("blocked_domain");
    });
  });

  it("does not block a domain twice", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await blockDomain("a@acme.test", "competitor", actor);
      await blockDomain("b@acme.test", "other", actor);
      expect(await listBlockedDomains()).toHaveLength(1);
    });
  });
});

describe("asking for more information", () => {
  it("emails them and leaves the application in the queue", async () => {
    await installShop(ALPHA);
    const { transport, sent } = recordingTransport();
    process.env.MANNON_EMAIL_FROM = "hello@acme.test";
    setEmailTransport(transport);

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);

      await requestMoreInformation(submission.id, "Send us your trade licence.", actor);

      expect(sent.find((email) => email.reason === "needs_info")?.body).toContain(
        "trade licence",
      );
      // An application that leaves the queue while it waits is one nobody
      // comes back to.
      expect(
        (await db.formSubmission.findUniqueOrThrow({ where: { id: submission.id } }))
          .status,
      ).toBe("PENDING");
    });
  });

  it("refuses to send an empty request", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);
      await expect(requestMoreInformation(submission.id, "   ", actor)).rejects.toThrow();
    });
  });
});

describe("the evaluator, on arrival", () => {
  const criteria = (overrides: Partial<ApprovalCriteria> = {}): ApprovalCriteria => ({
    ...DEFAULT_APPROVAL,
    enabled: true,
    criteria: [{ field: "years_in_business", atLeast: 2 }],
    ...overrides,
  });

  it("leaves everything for a person when it is switched off", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);

      // Nothing was even queued: the form has no criteria, so there is nothing
      // for the evaluator to do.
      expect(await db.scheduledJob.count()).toBe(0);

      // And running it anyway decides nothing.
      const result = await decideApplications(async () => admin);
      expect(result).toMatchObject({ approved: 0, rejected: 0, failed: 0 });
      expect(
        (await db.formSubmission.findUniqueOrThrow({ where: { id: submission.id } }))
          .status,
      ).toBe("PENDING");
      expect(admin.calls).toHaveLength(0);
    });
  });

  it("approves an application that meets every criterion", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const form = await liveForm({ approval: criteria() });
      const submission = await apply(form);

      // Queued rather than run inline: a buyer pressing send should not be
      // waiting on the Admin API.
      expect(
        await db.scheduledJob.count({ where: { kind: "forms.decide_applications" } }),
      ).toBe(1);

      const result = await decideApplications(async () => admin);
      expect(result).toMatchObject({ examined: 1, approved: 1, rejected: 0 });

      const decided = await db.formSubmission.findUniqueOrThrow({
        where: { id: submission.id },
      });
      expect(decided.status).toBe("APPROVED");
      expect(decided.decidedAutomatically).toBe(true);
      // Nobody's name is on it, because nobody decided it.
      expect(decided.decidedBy).toBeNull();
    });
  });

  it("leaves one that does not meet them for a person", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const form = await liveForm({ approval: criteria() });
      const submission = await apply(form, { years: "1" });

      const result = await decideApplications(async () => admin);
      expect(result).toMatchObject({ examined: 1, approved: 0 });
      expect(
        (await db.formSubmission.findUniqueOrThrow({ where: { id: submission.id } }))
          .status,
      ).toBe("PENDING");
    });
  });

  it("rejects automatically only when the merchant asked for that", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const form = await liveForm({ approval: criteria({ otherwise: "reject" }) });
      const submission = await apply(form, { years: "1" });

      await decideApplications(async () => admin);
      const decided = await db.formSubmission.findUniqueOrThrow({
        where: { id: submission.id },
      });
      expect(decided.status).toBe("REJECTED");
      expect(decided.decidedAutomatically).toBe(true);
    });
  });

  it("looks at each application once, even if deciding it fails", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();
    admin.graphql = vi.fn(async () => {
      throw new Error("Shopify said no");
    }) as never;

    await inAlpha(async () => {
      const form = await liveForm({ approval: criteria() });
      const submission = await apply(form);

      const first = await decideApplications(async () => admin);
      expect(first).toMatchObject({ failed: 1 });
      // Still in the queue for a person, which is the outcome that matters.
      expect(
        (await db.formSubmission.findUniqueOrThrow({ where: { id: submission.id } }))
          .status,
      ).toBe("PENDING");

      // And not retried forever, blocking everything behind it.
      const second = await decideApplications(async () => admin);
      expect(second).toMatchObject({ examined: 0, failed: 0 });
    });
  });

  it("does nothing for an uninstalled shop", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await liveForm({ approval: criteria() });
      await db.shop.updateMany({ data: { uninstalledAt: NOW } });
      expect(await decideApplications(async () => admin)).toEqual({
        skipped: "uninstalled",
      });
    });
  });
});

describe("the queue", () => {
  it("shows the oldest first, with the evaluator's working", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const form = await liveForm({
        approval: {
          ...DEFAULT_APPROVAL,
          enabled: true,
          criteria: [{ field: "years_in_business", atLeast: 10 }],
        },
      });
      await apply(form);

      const page = await listApplications();
      expect(page.total).toBe(1);
      const row = page.rows[0]!;
      expect(row.company).toBe("Acme Ltd");
      expect(row.contact).toBe("Sam Reed");
      expect(row.verdict.notEvaluated).toBe(false);
      // The reason, not just the verdict.
      expect(row.verdict.reasons[0]).toMatchObject({
        field: "years_in_business",
        met: false,
      });
    });
  });

  it("counts other applications from the same domain, not this one", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const form = await liveForm();
      await apply(form);
      await apply(form, { email: "second@acme.test" });
      await apply(form, { email: "elsewhere@other.test" });

      const page = await listApplications();
      const acme = page.rows.filter((row) => row.email.endsWith("@acme.test"));
      expect(acme.map((row) => row.sameDomainCount)).toEqual([1, 1]);
      expect(
        page.rows.find((row) => row.email.endsWith("@other.test"))!.sameDomainCount,
      ).toBe(0);
    });
  });

  it("flags an applicant who already has an account", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const form = await liveForm();
      await apply(form);
      await db.customer.create({
        data: {
          ...tenant(),
          customerId: "gid://shopify/Customer/1",
          email: "buyer@acme.test",
          countryCode: "SA",
        },
      });

      expect((await listApplications()).rows[0]!.existingCustomer).toBe(true);
    });
  });

  it("drops a decided application out of the queue", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);
      expect((await listApplications()).total).toBe(1);

      await rejectSubmission(
        submission.id,
        { reason: "other" },
        { admin, actor, now: NOW },
      );
      expect((await listApplications()).total).toBe(0);
    });
  });
});

describe("tenant isolation", () => {
  it("keeps one shop's applications out of another's queue", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inAlpha(async () => {
      const form = await liveForm();
      await apply(form);
    });

    expect((await inAlpha(() => listApplications())).total).toBe(1);
    expect((await inBeta(() => listApplications())).total).toBe(0);
  });

  it("will not let one shop approve another's application", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const admin = fakeAdmin();

    const theirs = await inAlpha(async () => {
      const form = await liveForm();
      return apply(form);
    });

    await expect(
      inBeta(() => approveSubmission(theirs.id, {}, { admin, actor, now: NOW })),
    ).rejects.toMatchObject({ status: 404 });
    expect(admin.calls).toHaveLength(0);
  });

  it("blocks a domain for one shop only", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inAlpha(() => blockDomain("a@acme.test", "competitor", actor));

    expect(await inAlpha(() => isDomainBlocked("b@acme.test"))).toBe(true);
    expect(await inBeta(() => isDomainBlocked("b@acme.test"))).toBe(false);
  });

  it("keeps one shop's sent messages out of another's records", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const form = await liveForm();
      const submission = await apply(form);
      await approveSubmission(submission.id, {}, { admin, actor, now: NOW });
    });

    expect(await inBeta(() => db.emailMessage.count())).toBe(0);
    expect(await inAlpha(() => db.emailMessage.count())).toBeGreaterThan(0);
  });
});
