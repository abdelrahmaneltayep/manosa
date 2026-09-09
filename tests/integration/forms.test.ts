import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { LimitReachedError } from "~/lib/billing/gate.server";
import { DEFAULT_APPEARANCE, DEFAULT_PUBLISH } from "~/lib/forms/appearance";
import {
  archiveForm,
  availableSlug,
  createForm,
  createFromTemplate,
  duplicateForm,
  FORM_TEMPLATES,
  FormValidationError,
  getForm,
  listForms,
  statsFor,
  toSlug,
  updateForm,
} from "~/lib/forms/forms.server";
import type { EmailTemplates } from "~/lib/forms/merge-tags";
import type { FormDefinition } from "~/lib/forms/schema";
import { MIN_FILL_MS, RATE_LIMIT } from "~/lib/forms/spam";
import {
  findPublicForm,
  HONEYPOT_FIELD,
  listSubmissions,
  recordView,
  RENDERED_AT_FIELD,
  submitForm,
} from "~/lib/forms/submissions.server";
import { checkVat } from "~/lib/forms/vies.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const actor = { type: "STAFF" as const, id: "staff-1" };
const NOW = new Date("2026-06-01T12:00:00Z");

const emails = (): EmailTemplates => ({
  confirmation: { subject: "Got it", body: "Hi {{first_name}}" },
  approved: { subject: "Welcome", body: "You are in" },
  rejected: { subject: "Sorry", body: "Not this time" },
  needs_info: { subject: "One more thing", body: "We need {{reason}}" },
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
    { key: "privacy", kind: "privacy", label: "Privacy", required: true, showWhen: null },
  ],
});

const input = (overrides: Record<string, unknown> = {}) => ({
  name: "Wholesale application",
  definition: definition(),
  appearance: { ...DEFAULT_APPEARANCE },
  emails: emails(),
  publish: { ...DEFAULT_PUBLISH },
  ...overrides,
});

const answers = (overrides: Record<string, string> = {}) => ({
  first_name: "Sam",
  email: "buyer@acme.test",
  company: "Acme Ltd",
  privacy: "yes",
  [RENDERED_AT_FIELD]: String(NOW.getTime() - 30_000),
  ...overrides,
});

const headers = (ip = "203.0.113.5") =>
  new Headers({ "x-forwarded-for": ip, "user-agent": "Mozilla/5.0" });

async function installShop(shop: string, planKey = "pro") {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: { ...tenant(), planKey, billingStatus: "ACTIVE", countryCode: "SA" },
    }),
  );
}

async function liveForm(overrides: Record<string, unknown> = {}) {
  const created = await createForm(input(overrides), actor);
  return db.registrationForm.update({
    where: { id: created.id },
    data: { status: "LIVE" },
  });
}

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

/* -------------------------------------------------------------------------- */

describe("form CRUD", () => {
  it("creates from each of the three templates", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      for (const template of Object.values(FORM_TEMPLATES)) {
        const created = await createFromTemplate(template, (key) => key, actor);
        expect(created.template).toBe(template.key);
        expect(created.status).toBe("DRAFT");
      }
      expect(await db.registrationForm.count()).toBe(3);
    });
  });

  it("gives each template a distinct slug", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      for (const template of Object.values(FORM_TEMPLATES)) {
        await createFromTemplate(template, (key) => key, actor);
      }
      const slugs = (await listForms()).map((row) => row.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
    });
  });

  it("makes a slug from any name", () => {
    expect(toSlug("  Wholesale — KSA! ")).toBe("wholesale-ksa");
    expect(toSlug("!!!")).toBe("form");
  });

  it("does not let two forms share a slug", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await createForm(input({ slug: "apply" }), actor);
      const second = await createForm(input({ slug: "apply" }), actor);
      expect(second.slug).toBe("apply-2");
      expect(await availableSlug("apply")).toBe("apply-3");
    });
  });

  it("duplicates as a draft, never live", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const live = await liveForm();
      const copy = await duplicateForm(live.id, actor, "(copy)");

      // Two identical forms both accepting applications is a merchant's copy
      // quietly competing with their original.
      expect(copy.status).toBe("DRAFT");
      expect(copy.name).toBe("Wholesale application (copy)");
      expect(copy.slug).toMatch(/-copy/);
      expect(copy.publicId).not.toBe(live.publicId);
    });
  });

  it("refuses to publish a form that cannot work", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      // No email field: nobody could ever answer an application from it, and
      // no application could be de-duplicated or turned into a customer.
      const broken = input({
        definition: {
          v: 1,
          fields: [
            {
              key: "company",
              kind: "company",
              label: "Company",
              required: true,
              showWhen: null,
            },
          ],
        },
      });
      const created = await createForm(broken, actor);

      await expect(
        updateForm(created.id, { ...broken, status: "LIVE" } as never, actor),
      ).rejects.toThrow(FormValidationError);

      // Still a draft, and still not accepting anything.
      const after = await db.registrationForm.findUnique({ where: { id: created.id } });
      expect(after?.status).toBe("DRAFT");
    });
  });

  it("refuses to publish a form whose emails carry a tag that never fills in", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const broken = input({
        emails: {
          ...emails(),
          confirmation: { subject: "Hi", body: "Hi {{firstname}}" },
        },
      });
      const created = await createForm(broken, actor);

      await expect(
        updateForm(created.id, { ...broken, status: "LIVE" } as never, actor),
      ).rejects.toThrow(FormValidationError);
    });
  });

  it("lets a draft stay unfinished", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const created = await createForm(input(), actor);
      const saved = await updateForm(
        created.id,
        input({ emails: { ...emails(), approved: { subject: "", body: "" } } }) as never,
        actor,
      );
      expect(saved.status).toBe("DRAFT");
    });
  });

  it("counts a form against the plan's quota", async () => {
    await installShop(ALPHA, "free");
    await inAlpha(async () => {
      await createForm(input(), actor);
      await expect(createForm(input(), actor)).rejects.toThrow(LimitReachedError);
    });
  });

  it("keeps the applications when a form is archived", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const form = await liveForm();
      await submitForm({
        form,
        answers: answers(),
        files: [],
        headers: headers(),
        now: NOW,
      });

      await archiveForm(form.id, actor);

      // The customers a form brought in are the merchant's, not the form's.
      expect(await db.formSubmission.count()).toBe(1);
      expect(await listForms()).toHaveLength(0);
    });
  });

  it("counts views and submissions over the window", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const form = await liveForm();
      await recordView(form.id);
      await recordView(form.id);
      await submitForm({
        form,
        answers: answers(),
        files: [],
        headers: headers(),
        now: NOW,
      });

      const stats = await statsFor([form.id]);
      expect(stats.get(form.id)).toEqual({ views: 2, submissions: 1 });
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("taking an application", () => {
  it("stores a valid one and records the view event", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const form = await liveForm();
      const result = await submitForm({
        form,
        answers: answers(),
        files: [],
        headers: headers(),
        now: NOW,
      });

      expect(result.ok).toBe(true);
      const row = await db.formSubmission.findFirst();
      expect(row?.email).toBe("buyer@acme.test");
      expect(row?.company).toBe("Acme Ltd");
      expect(row?.status).toBe("PENDING");
      expect(await db.formEvent.count({ where: { kind: "SUBMIT" } })).toBe(1);
    });
  });

  it("refuses a form that is not live", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const draft = await createForm(input(), actor);
      const result = await submitForm({
        form: draft,
        answers: answers(),
        files: [],
        headers: headers(),
        now: NOW,
      });
      expect(result).toEqual({ ok: false, kind: "form_not_live" });
      expect(await db.formSubmission.count()).toBe(0);
    });
  });

  it("reports what is wrong rather than dropping the application", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const form = await liveForm();
      const result = await submitForm({
        form,
        answers: answers({ email: "not-an-email", privacy: "" }),
        files: [],
        headers: headers(),
        now: NOW,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("invalid");
      if (result.kind !== "invalid") return;
      expect(result.issues.map((issue) => issue.key).sort()).toEqual([
        "email",
        "privacy",
      ]);
    });
  });

  it("tells a second application from the same address that it already has one", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const form = await liveForm();
      await submitForm({
        form,
        answers: answers(),
        files: [],
        headers: headers(),
        now: NOW,
      });

      const again = await submitForm({
        form,
        answers: answers({ [RENDERED_AT_FIELD]: String(NOW.getTime() - 30_000) }),
        files: [],
        headers: headers("203.0.113.9"),
        now: NOW,
      });

      expect(again).toEqual({ ok: false, kind: "already_applied", status: "PENDING" });
      expect(await db.formSubmission.count()).toBe(1);
    });
  });

  it("keeps only answers to fields the form actually has", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const form = await liveForm();
      await submitForm({
        form,
        answers: answers({ smuggled: "<script>alert(1)</script>" }),
        files: [],
        headers: headers(),
        now: NOW,
      });

      const row = await db.formSubmission.findFirst();
      // A public post can carry anything; storing it verbatim means whatever a
      // stranger sends is what a merchant later reads on a review screen.
      expect(Object.keys(row!.answers as object).sort()).toEqual([
        "company",
        "email",
        "first_name",
        "privacy",
      ]);
    });
  });

  it("stores an uploaded file, and never claims it was scanned", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const withFile = {
        ...definition(),
        fields: [
          ...definition().fields,
          {
            key: "licence",
            kind: "file" as const,
            label: "Licence",
            required: true,
            showWhen: null,
          },
        ],
      };
      const form = await liveForm({ definition: withFile });

      const result = await submitForm({
        form,
        answers: answers(),
        files: [
          {
            fieldKey: "licence",
            fileName: "licence.pdf",
            contentType: "application/pdf",
            bytes: new Uint8Array([1, 2, 3, 4]),
          },
        ],
        headers: headers(),
        now: NOW,
      });

      expect(result.ok).toBe(true);
      const upload = await db.formUpload.findFirst();
      expect(upload?.byteSize).toBe(4);
      // Nothing has scanned it. Saying so beats implying it is clean.
      expect(upload?.scannedAt).toBeNull();
    });
  });

  it("rejects a file of the wrong type or size, with the size in the issue", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const withFile = {
        ...definition(),
        fields: [
          ...definition().fields,
          {
            key: "licence",
            kind: "file" as const,
            label: "Licence",
            required: true,
            showWhen: null,
          },
        ],
      };
      const form = await liveForm({ definition: withFile });

      const tooBig = await submitForm({
        form,
        answers: answers(),
        files: [
          {
            fieldKey: "licence",
            fileName: "huge.pdf",
            contentType: "application/pdf",
            bytes: new Uint8Array(6 * 1024 * 1024),
          },
        ],
        headers: headers(),
        now: NOW,
      });

      expect(tooBig.ok).toBe(false);
      if (tooBig.ok || tooBig.kind !== "invalid") return;
      // The applicant needs to know by how much.
      expect(Number(tooBig.issues[0]!.detail)).toBe(6 * 1024 * 1024);

      const wrongType = await submitForm({
        form,
        answers: answers({ email: "other@acme.test" }),
        files: [
          {
            fieldKey: "licence",
            fileName: "sheet.xlsx",
            contentType: "application/vnd.ms-excel",
            bytes: new Uint8Array([1]),
          },
        ],
        headers: headers(),
        now: NOW,
      });
      expect(wrongType.ok).toBe(false);
      expect(await db.formUpload.count()).toBe(0);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("spam protection", () => {
  it("silently drops a filled honeypot, but keeps the record", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const form = await liveForm();
      const result = await submitForm({
        form,
        answers: answers({ [HONEYPOT_FIELD]: "http://spam.test" }),
        files: [],
        headers: headers(),
        now: NOW,
      });

      // Told it succeeded: naming the signal that caught it is free tuning
      // for the next run.
      expect(result).toMatchObject({
        ok: true,
        silentlyDropped: true,
        reason: "honeypot",
      });

      const row = await db.formSubmission.findFirst();
      // Kept, not discarded: a real buyer wrongly caught is a lost customer,
      // and the merchant has to be able to find them.
      expect(row?.status).toBe("SPAM");
      expect(row?.spamReason).toBe("honeypot");
    });
  });

  it("catches a form filled in impossibly fast", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const form = await liveForm();
      const result = await submitForm({
        form,
        answers: answers({
          [RENDERED_AT_FIELD]: String(NOW.getTime() - (MIN_FILL_MS - 500)),
        }),
        files: [],
        headers: headers(),
        now: NOW,
      });

      expect(result).toMatchObject({ silentlyDropped: true, reason: "too_fast" });
    });
  });

  it("tells a rate-limited person, because they are probably a person", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const form = await liveForm();

      for (let index = 0; index < RATE_LIMIT; index += 1) {
        await submitForm({
          form,
          answers: answers({ email: `buyer${index}@acme.test` }),
          files: [],
          headers: headers(),
          now: NOW,
        });
      }

      const blocked = await submitForm({
        form,
        answers: answers({ email: "one-more@acme.test" }),
        files: [],
        headers: headers(),
        now: NOW,
      });

      expect(blocked).toEqual({ ok: false, kind: "rate_limited" });
    });
  });

  it("counts the rate limit per address, not per store", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const form = await liveForm();

      for (let index = 0; index < RATE_LIMIT; index += 1) {
        await submitForm({
          form,
          answers: answers({ email: `buyer${index}@acme.test` }),
          files: [],
          headers: headers("203.0.113.5"),
          now: NOW,
        });
      }

      const elsewhere = await submitForm({
        form,
        answers: answers({ email: "elsewhere@acme.test" }),
        files: [],
        headers: headers("198.51.100.7"),
        now: NOW,
      });

      expect(elsewhere.ok).toBe(true);
    });
  });

  it("can be turned off, and then lets a fast submission through", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const form = await liveForm({
        publish: { ...DEFAULT_PUBLISH, spamProtection: false },
      });

      const result = await submitForm({
        form,
        answers: answers({ [RENDERED_AT_FIELD]: String(NOW.getTime()) }),
        files: [],
        headers: headers(),
        now: NOW,
      });

      expect(result.ok).toBe(true);
      expect((await db.formSubmission.findFirst())?.status).toBe("PENDING");
    });
  });

  it("keeps spam out of the queue unless it is asked for by name", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const form = await liveForm();
      await submitForm({
        form,
        answers: answers({ [HONEYPOT_FIELD]: "x" }),
        files: [],
        headers: headers(),
        now: NOW,
      });
      await submitForm({
        form,
        answers: answers({ email: "real@acme.test" }),
        files: [],
        headers: headers("198.51.100.1"),
        now: NOW,
      });

      expect((await listSubmissions()).total).toBe(1);
      expect((await listSubmissions({ status: "SPAM" })).total).toBe(1);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("VIES", () => {
  const vatForm = () => ({
    ...definition(),
    fields: [
      ...definition().fields,
      { key: "vat", kind: "vat" as const, label: "VAT", required: false, showWhen: null },
    ],
  });

  it("records a number VIES confirms", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ isValid: true, name: "ACME GMBH" }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;

    const check = await checkVat("DE123456789", { fetchImpl });
    expect(check).toMatchObject({ status: "valid", note: null, name: "ACME GMBH" });
  });

  it("records a number VIES rejects", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ isValid: false }), { status: 200 }),
    ) as unknown as typeof fetch;

    expect((await checkVat("DE123456789", { fetchImpl })).status).toBe("invalid");
  });

  it("accepts the applicant when VIES is down", async () => {
    // The rule this whole module exists for: a wholesale buyer who cannot
    // apply because Belgium's tax server is offline is a customer lost to
    // someone else's downtime.
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const check = await checkVat("DE123456789", { fetchImpl, retries: 1 });
    expect(check).toMatchObject({ status: "unverified", note: "vies_unreachable" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a member-state error alongside a 200 as unreachable", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ userError: "MS_UNAVAILABLE" }), { status: 200 }),
    ) as unknown as typeof fetch;

    expect((await checkVat("DE123456789", { fetchImpl, retries: 0 })).note).toBe(
      "vies_unreachable",
    );
  });

  it("gives up rather than hanging when VIES does not answer", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;

    const check = await checkVat("DE123456789", {
      fetchImpl,
      timeoutMs: 20,
      retries: 0,
    });
    expect(check.note).toBe("vies_unreachable");
  });

  it("never asks VIES about a country it does not cover", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    // A Saudi TRN is a real registration; VIES would answer "no" about it.
    const check = await checkVat("SA300000000000003", { fetchImpl });

    expect(check).toMatchObject({ status: "unverified", note: "outside_eu" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("flags a number whose shape is wrong without calling out", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect((await checkVat("DE1", { fetchImpl })).note).toBe("format");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stores the outcome on the application", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const form = await liveForm({ definition: vatForm() });
      const fetchImpl = vi.fn(async () => {
        throw new Error("down");
      }) as unknown as typeof fetch;

      await submitForm({
        form,
        answers: answers({ vat: "DE 123 456 789" }),
        files: [],
        headers: headers(),
        now: NOW,
        vies: { fetchImpl, retries: 0 },
      });

      const row = await db.formSubmission.findFirst();
      expect(row?.vatNumber).toBe("DE123456789");
      // Unverified is not invalid, and the reviewer is told which it is.
      expect(row?.vatStatus).toBe("UNVERIFIED");
      expect(row?.vatNote).toBe("vies_unreachable");
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("tenant isolation", () => {
  it("finds a public form across shops, and only by its unguessable id", async () => {
    await installShop(ALPHA);
    const form = await inAlpha(() => liveForm());

    const found = await findPublicForm(form.publicId);
    expect(found?.shop).toBe(ALPHA);
    expect(await findPublicForm("not-a-real-id")).toBeNull();
  });

  it("does not offer an archived form publicly", async () => {
    await installShop(ALPHA);
    const form = await inAlpha(async () => {
      const live = await liveForm();
      await archiveForm(live.id, actor);
      return live;
    });

    expect(await findPublicForm(form.publicId)).toBeNull();
  });

  it("reads another shop's form as not found", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const mine = await inAlpha(() => createForm(input(), actor));

    expect(await inBeta(() => getForm(mine.id))).toBeNull();
    await expect(inBeta(() => archiveForm(mine.id, actor))).rejects.toMatchObject({
      status: 404,
    });
  });

  it("keeps one shop's applications out of another's list", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    const alphaForm = await inAlpha(() => liveForm());
    const betaForm = await inBeta(() => liveForm());

    await inAlpha(() =>
      submitForm({
        form: alphaForm,
        answers: answers(),
        files: [],
        headers: headers(),
        now: NOW,
      }),
    );
    await inBeta(() =>
      submitForm({
        form: betaForm,
        answers: answers({ email: "other@acme.test" }),
        files: [],
        headers: headers("198.51.100.2"),
        now: NOW,
      }),
    );

    expect((await inAlpha(() => listSubmissions())).total).toBe(1);
    expect((await inAlpha(() => listSubmissions())).rows[0]!.email).toBe(
      "buyer@acme.test",
    );
    expect((await inBeta(() => listSubmissions())).rows[0]!.email).toBe(
      "other@acme.test",
    );
  });

  it("writes an application into the shop that owns the form, not the caller's", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const alphaForm = await inAlpha(() => liveForm());

    const found = await findPublicForm(alphaForm.publicId);
    await shopScope.run(found!.shop, () =>
      submitForm({
        form: found!.form,
        answers: answers(),
        files: [],
        headers: headers(),
        now: NOW,
      }),
    );

    expect(await inAlpha(() => db.formSubmission.count())).toBe(1);
    expect(await inBeta(() => db.formSubmission.count())).toBe(0);
  });
});
