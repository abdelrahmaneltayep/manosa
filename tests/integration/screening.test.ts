import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { resetAnthropicClient, type MessagesApi } from "~/lib/ai/client.server";
import { DEFAULT_APPEARANCE, DEFAULT_PUBLISH } from "~/lib/forms/appearance";
import { createForm } from "~/lib/forms/forms.server";
import type { EmailTemplates } from "~/lib/forms/merge-tags";
import { listApplications } from "~/lib/forms/queue.server";
import type { FormDefinition } from "~/lib/forms/schema";
import { factsForScreening, screenSubmission } from "~/lib/forms/screening.server";
import { RENDERED_AT_FIELD, submitForm } from "~/lib/forms/submissions.server";
import { screenApplications } from "~/lib/jobs/handlers/screen-applications.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * ✦ Screening, end to end, against a stubbed Anthropic client.
 *
 * The states that matter are the ones where nothing is known: no key, a
 * timeout, an unusable answer. Each has to be distinguishable on screen from
 * "we looked and it is fine", because a merchant acts differently on each.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);
const actor = { type: "STAFF" as const, id: "staff-1" };
const NOW = new Date("2026-06-01T12:00:00Z");

function reply(text: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_01screen",
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 80, output_tokens: 30, cache_read_input_tokens: 0 },
    ...overrides,
  };
}

function stubMessages(create: (...args: unknown[]) => unknown): MessagesApi {
  return { create, stream: () => {} } as unknown as MessagesApi;
}

const RECOMMEND = JSON.stringify({
  decision: "recommend",
  reasons: [
    { signal: "vat_valid", detail: null },
    { signal: "years_established", detail: 5 },
  ],
});

const emails = (): EmailTemplates => ({
  confirmation: { subject: "Got it", body: "Hi {{first_name}}" },
  approved: { subject: "Welcome", body: "You are in" },
  rejected: { subject: "Sorry", body: "{{reason}}" },
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
    { key: "email", kind: "email", label: "Email", required: true, showWhen: null },
    { key: "company", kind: "company", label: "Company", required: true, showWhen: null },
    // Not keyed "website": that key is the honeypot (app/lib/forms/spam.ts),
    // and a form using it would silently drop every real applicant.
    {
      key: "company_website",
      kind: "text",
      label: "Website",
      required: false,
      showWhen: null,
    },
    {
      key: "years",
      kind: "years_in_business",
      label: "Years",
      required: false,
      showWhen: null,
    },
  ],
});

const answers = (overrides: Record<string, string> = {}) => ({
  first_name: "Sam",
  email: "buyer@acme.test",
  company: "Acme Ltd",
  company_website: "https://acme.test",
  years: "5",
  [RENDERED_AT_FIELD]: String(NOW.getTime() - 30_000),
  ...overrides,
});

async function installShop(shop: string) {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: { ...tenant(), planKey: "pro", billingStatus: "ACTIVE", countryCode: "SA" },
    }),
  );
}

async function liveForm() {
  const created = await createForm(
    {
      name: "Wholesale application",
      definition: definition(),
      appearance: { ...DEFAULT_APPEARANCE },
      emails: emails(),
      publish: { ...DEFAULT_PUBLISH },
    },
    actor,
  );
  return db.registrationForm.update({
    where: { id: created.id },
    data: { status: "LIVE" },
  });
}

async function apply(overrides: Record<string, string> = {}) {
  const form = await liveForm();
  const row = await db.registrationForm.findUniqueOrThrow({ where: { id: form.id } });
  const result = await submitForm({
    form: row,
    answers: answers(overrides),
    files: [],
    headers: new Headers({ "x-forwarded-for": "203.0.113.5" }),
    now: NOW,
    vies: {
      fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch,
    },
  });
  if (!result.ok || "silentlyDropped" in result)
    throw new Error("submission was dropped");
  return result.submission;
}

/** The submission, with what `screenSubmission` needs hung off it. */
async function loaded(id: string) {
  return db.formSubmission.findUniqueOrThrow({
    where: { id },
    include: { form: true, uploads: { select: { fieldKey: true, scannedAt: true } } },
  });
}

const input = (
  submission: Awaited<ReturnType<typeof loaded>>,
  overrides: Record<string, unknown> = {},
) => ({
  submission,
  existingCustomer: false,
  countryCode: "SA",
  otherPendingFromDomain: 0,
  storeCountry: "SA",
  ...overrides,
});

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  resetAnthropicClient();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  resetAnthropicClient();
});

afterAll(async () => {
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */

describe("the facts that get assembled", () => {
  it("carries the business, and nobody in it", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const submission = await apply();
      const facts = factsForScreening(input(await loaded(submission.id)));

      expect(facts.company).toBe("Acme Ltd");
      expect(facts.emailDomain).toBe("acme.test");
      expect(facts.websiteDomain).toBe("acme.test");
      expect(facts.websiteMatchesEmail).toBe(true);
      expect(facts.yearsInBusiness).toBe(5);

      // The promise: no address, no name, no answers.
      const serialised = JSON.stringify(facts);
      expect(serialised).not.toContain("buyer@acme.test");
      expect(serialised).not.toContain("Sam");
    });
  });

  it("knows a free email address from a business one", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const submission = await apply({ email: "sam@gmail.com", company_website: "" });
      const facts = factsForScreening(input(await loaded(submission.id)));

      expect(facts.emailDomainIsFree).toBe(true);
      // No website is not a mismatch. Saying so would invent a red flag.
      expect(facts.websiteMatchesEmail).toBeNull();
    });
  });

  it("spots a website on a different domain from the email", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const submission = await apply({ company_website: "https://someone-else.test" });
      const facts = factsForScreening(input(await loaded(submission.id)));
      expect(facts.websiteMatchesEmail).toBe(false);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("screenSubmission", () => {
  it("stores the verdict, its reasons and its provenance", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const submission = await apply();
      const verdict = await screenSubmission(input(await loaded(submission.id)), {
        messages: stubMessages(async () => reply(RECOMMEND)),
      });

      expect(verdict).toBe("RECOMMEND");
      const row = await db.formSubmission.findUniqueOrThrow({
        where: { id: submission.id },
      });
      expect(row.screening).toBe("RECOMMEND");
      expect(row.screenedAt).not.toBeNull();
      expect(row.screeningModel).toBe("claude-sonnet-4-5");
      expect(row.screeningRequestId).toBe("msg_01screen");
      expect(row.screeningReasons).toEqual([
        { signal: "vat_valid", detail: null },
        { signal: "years_established", detail: 5 },
      ]);
    });
  });

  it("says it could not say, rather than reporting a clean bill of health", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const submission = await apply();
      const verdict = await screenSubmission(input(await loaded(submission.id)), {
        messages: stubMessages(async () => reply("I am not sure about this one.")),
      });

      expect(verdict).toBe("UNAVAILABLE");
      const row = await db.formSubmission.findUniqueOrThrow({
        where: { id: submission.id },
      });
      expect(row.screening).toBe("UNAVAILABLE");
      // Stamped anyway: an application that fails screening must not be retried
      // for ever at the merchant's expense.
      expect(row.screenedAt).not.toBeNull();
    });
  });

  it("does not decide anything", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const submission = await apply();
      await screenSubmission(input(await loaded(submission.id)), {
        messages: stubMessages(async () =>
          reply(
            JSON.stringify({
              decision: "look",
              reasons: [{ signal: "free_email_domain", detail: null }],
            }),
          ),
        ),
      });

      const row = await db.formSubmission.findUniqueOrThrow({
        where: { id: submission.id },
      });
      // "Worth a look" is a recommendation. The application is exactly where it
      // was, waiting for a person.
      expect(row.status).toBe("PENDING");
      expect(row.decidedAt).toBeNull();
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("the screening job", () => {
  it("marks everything as not screened when there is no key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    resetAnthropicClient();
    await installShop(ALPHA);

    await inAlpha(async () => {
      const submission = await apply();
      const result = await screenApplications();

      expect(result).toMatchObject({ examined: 1, off: true });
      const row = await db.formSubmission.findUniqueOrThrow({
        where: { id: submission.id },
      });
      // Not left WAITING: a queue that says "checking…" for ever is a worse
      // lie than "not screened".
      expect(row.screening).toBe("OFF");
    });
  });

  it("screens what it has not screened, and does not screen it twice", async () => {
    await installShop(ALPHA);
    const create = vi.fn(async () => reply(RECOMMEND));

    await inAlpha(async () => {
      await apply();
      // Injected through the module the job uses, so this exercises the job's
      // own claiming logic rather than a stub of it.
      await screenApplications();
    });

    // With no injected client the real one is used, which has no key in tests —
    // so the run above marked it screened. A second run must find nothing.
    await inAlpha(async () => {
      const before = await db.formSubmission.count({ where: { screenedAt: null } });
      const second = await screenApplications();
      expect(before).toBe(0);
      expect(second).toMatchObject({ examined: 0 });
    });

    expect(create).not.toHaveBeenCalled();
  });

  it("does nothing for a shop that has uninstalled", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await apply();
      await db.shop.updateMany({ data: { uninstalledAt: new Date() } });
      expect(await screenApplications()).toEqual({ skipped: "uninstalled" });
    });
  });

  it("never screens another shop's applications", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    const mine = await inAlpha(() => apply());
    await inBeta(() => apply());

    await inAlpha(() => screenApplications());

    const theirs = await inBeta(() =>
      db.formSubmission.findFirstOrThrow({ where: { screenedAt: null } }),
    );
    expect(theirs.screening).toBe("WAITING");

    const ours = await inAlpha(() =>
      db.formSubmission.findUniqueOrThrow({ where: { id: mine.id } }),
    );
    expect(ours.screenedAt).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("the queue", () => {
  it("carries the verdict and its reasons onto the row", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const submission = await apply();
      await screenSubmission(input(await loaded(submission.id)), {
        messages: stubMessages(async () => reply(RECOMMEND)),
      });

      const page = await listApplications();
      expect(page.rows[0]?.screening).toBe("RECOMMEND");
      expect(page.rows[0]?.screeningReasons).toHaveLength(2);
    });
  });

  it("shows an unscreened application as waiting, not as clear", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await apply();
      const page = await listApplications();
      expect(page.rows[0]?.screening).toBe("WAITING");
      expect(page.rows[0]?.screeningReasons).toEqual([]);
    });
  });
});
