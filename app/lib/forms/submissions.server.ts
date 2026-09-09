import type { FormSubmission, Prisma, RegistrationForm } from "@prisma/client";

import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { readPublish } from "~/lib/forms/appearance";
import {
  ALLOWED_UPLOAD_TYPES,
  emailFrom,
  firstOfKind,
  MAX_UPLOAD_BYTES,
  readDefinition,
  validateSubmission,
  visibleFields,
  type Answers,
  type FormDefinition,
  type SubmissionIssue,
} from "~/lib/forms/schema";
import { looksLikeVat } from "~/lib/forms/vat-formats";
import {
  clientIp,
  HONEYPOT_FIELD,
  RATE_WINDOW_MS,
  readRenderedAt,
  RENDERED_AT_FIELD,
  spamVerdict,
  type SpamReason,
} from "~/lib/forms/spam";
import { checkVat, toDbStatus, type CheckVatOptions } from "~/lib/forms/vies.server";
import { shopScope, tenant, withoutShopScope } from "~/lib/tenant/shop-context.server";

/**
 * Taking one application.
 *
 * This runs for a member of the public, on a page with no session, so it is
 * the most exposed surface in the app. Every branch here is about one of three
 * things: not losing a real applicant, not letting a bot through, and not
 * letting a public request reach another shop's data.
 */

export interface SubmissionFile {
  fieldKey: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

export type SubmitResult =
  | { ok: true; submission: FormSubmission }
  /** Caught by a signal a real person would not trip. Answered as success. */
  | { ok: true; silentlyDropped: true; reason: SpamReason }
  | { ok: false; kind: "invalid"; issues: SubmissionIssue[] }
  | { ok: false; kind: "already_applied"; status: string }
  | { ok: false; kind: "rate_limited" }
  | { ok: false; kind: "form_not_live" };

export interface SubmitInput {
  form: RegistrationForm;
  answers: Answers;
  files: SubmissionFile[];
  headers: Headers;
  now?: Date;
  vies?: CheckVatOptions;
}

/**
 * Find a live form by its public id, across shops.
 *
 * The one query in this feature that has to look outside a tenant: a public
 * URL carries no shop. It selects by an unguessable id, returns the shop it
 * belongs to, and every later query runs inside that shop's scope.
 */
export async function findPublicForm(
  publicId: string,
): Promise<{ shop: string; form: RegistrationForm } | null> {
  const form = await withoutShopScope(
    "a public form URL carries no shop; the id is the lookup",
    () => db.registrationForm.findUnique({ where: { publicId } }),
  );

  if (!form || form.archivedAt) return null;
  return { shop: form.shop, form };
}

/** Record that the form was looked at, for the conversion figure. */
export async function recordView(formId: string) {
  await db.formEvent.create({ data: { ...tenant(), formId, kind: "VIEW" } });
}

function uploadIssues(
  definition: FormDefinition,
  answers: Answers,
  files: SubmissionFile[],
): SubmissionIssue[] {
  const issues: SubmissionIssue[] = [];
  const byKey = new Map(files.map((file) => [file.fieldKey, file]));

  for (const field of visibleFields(definition, answers)) {
    if (field.kind !== "file") continue;
    const file = byKey.get(field.key);

    if (!file) {
      if (field.required) issues.push({ key: field.key, code: "required" });
      continue;
    }

    if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
      // The size is in the issue so the page can say "4.2 MB — the limit is
      // 5 MB" rather than "file too large", which tells the applicant nothing
      // about how much they need to shave off.
      issues.push({
        key: field.key,
        code: "too_long",
        detail: String(file.bytes.byteLength),
      });
    }

    if (!ALLOWED_UPLOAD_TYPES.includes(file.contentType)) {
      issues.push({ key: field.key, code: "not_an_option", detail: file.contentType });
    }
  }

  return issues;
}

export async function submitForm(input: SubmitInput): Promise<SubmitResult> {
  const now = input.now ?? new Date();
  const definition = readDefinition(input.form.fields);
  const publish = readPublish(input.form.publish);

  if (input.form.status !== "LIVE") return { ok: false, kind: "form_not_live" };

  const ip = clientIp(input.headers);

  if (publish.spamProtection) {
    const recentFromIp = ip
      ? await db.formSubmission.count({
          where: { ip, createdAt: { gte: new Date(now.getTime() - RATE_WINDOW_MS) } },
        })
      : 0;

    const verdict = spamVerdict({
      honeypot: input.answers[HONEYPOT_FIELD] ?? null,
      renderedAt: readRenderedAt(input.answers[RENDERED_AT_FIELD]),
      now,
      recentFromIp,
    });

    if (verdict.spam) {
      await storeSpam(input, definition, ip, verdict.reason!, now);

      // A rate-limited person is told, because they are probably a person who
      // hit submit twice. A honeypot or a three-second fill is a bot, and
      // telling a bot which signal caught it is free tuning for the next run.
      return verdict.reason === "rate_limit"
        ? { ok: false, kind: "rate_limited" }
        : { ok: true, silentlyDropped: true, reason: verdict.reason! };
    }
  }

  const issues = [
    ...validateSubmission(definition, input.answers, { checkVatFormat: looksLikeVat }),
    ...uploadIssues(definition, input.answers, input.files),
  ];
  if (issues.length > 0) return { ok: false, kind: "invalid", issues };

  const email = emailFrom(definition, input.answers);
  if (!email) return { ok: false, kind: "invalid", issues: [] };

  const existing = await db.formSubmission.findFirst({
    where: { formId: input.form.id, email, status: { not: "SPAM" } },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return { ok: false, kind: "already_applied", status: existing.status };

  const vatValue = firstOfKind(definition, "vat", input.answers);
  const vat = vatValue ? await checkVat(vatValue, input.vies) : null;

  const submission = await db.formSubmission.create({
    data: {
      ...tenant(),
      formId: input.form.id,
      email,
      company: firstOfKind(definition, "company", input.answers),
      answers: sanitisedAnswers(definition, input.answers) as Prisma.InputJsonValue,
      status: "PENDING",
      vatNumber: vat?.normalized ?? null,
      vatStatus: vat ? toDbStatus(vat) : "NONE",
      vatNote: vat?.note ?? null,
      ip,
      userAgent: input.headers.get("user-agent")?.slice(0, 500) ?? null,
      uploads: {
        create: input.files.map((file) => ({
          ...tenant(),
          fieldKey: file.fieldKey,
          fileName: file.fileName.slice(0, 255),
          contentType: file.contentType,
          byteSize: file.bytes.byteLength,
          content: Buffer.from(file.bytes),
          // Deliberately null: nothing has scanned this. The admin says
          // "not scanned" rather than implying it is clean.
          scannedAt: null,
        })),
      },
    },
  });

  await db.formEvent.create({
    data: { ...tenant(), formId: input.form.id, kind: "SUBMIT" },
  });

  await recordAudit({
    actor: { type: "BUYER", label: email },
    action: "form.submitted",
    summary: `${submission.company ?? email} applied through “${input.form.name}”.`,
    subject: { type: "FormSubmission", id: submission.id },
    metadata: {
      formId: input.form.id,
      vatStatus: submission.vatStatus,
      uploads: input.files.length,
    },
    ip,
  });

  return { ok: true, submission };
}

/**
 * Keep only answers to fields the form actually has.
 *
 * A public form post can carry anything; storing it verbatim means whatever a
 * stranger sends is what a merchant later reads on a review screen.
 */
function sanitisedAnswers(definition: FormDefinition, answers: Answers): Answers {
  const out: Answers = {};
  for (const field of definition.fields) {
    const value = answers[field.key];
    if (typeof value === "string" && value.trim()) out[field.key] = value.trim();
  }
  return out;
}

async function storeSpam(
  input: SubmitInput,
  definition: FormDefinition,
  ip: string | null,
  reason: SpamReason,
  now: Date,
) {
  // Stored, not discarded: a real buyer caught by a rule is a lost customer,
  // and the merchant has to be able to find them and say so.
  await db.formSubmission.create({
    data: {
      ...tenant(),
      formId: input.form.id,
      email: emailFrom(definition, input.answers) ?? "",
      company: firstOfKind(definition, "company", input.answers),
      answers: sanitisedAnswers(definition, input.answers) as Prisma.InputJsonValue,
      status: "SPAM",
      spamReason: reason,
      ip,
      userAgent: input.headers.get("user-agent")?.slice(0, 500) ?? null,
      createdAt: now,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Reading them back in the admin                                              */
/* -------------------------------------------------------------------------- */

export const SUBMISSIONS_PAGE_SIZE = 50;

export interface SubmissionFilters {
  formId?: string;
  status?: "PENDING" | "APPROVED" | "REJECTED" | "SPAM";
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listSubmissions(filters: SubmissionFilters = {}) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize ?? SUBMISSIONS_PAGE_SIZE;

  const where: Prisma.FormSubmissionWhereInput = {
    ...(filters.formId ? { formId: filters.formId } : {}),
    // Spam is only ever shown when asked for by name; it is not "everything
    // else" that a merchant scrolls past.
    status: filters.status ?? { not: "SPAM" },
    ...(filters.search
      ? {
          OR: [
            { email: { contains: filters.search, mode: "insensitive" } },
            { company: { contains: filters.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.formSubmission.findMany({
      where,
      include: {
        form: true,
        uploads: {
          select: { id: true, fileName: true, byteSize: true, scannedAt: true },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.formSubmission.count({ where }),
  ]);

  return { rows, total, page, pageSize };
}

/** One upload's bytes, for the admin's download link. */
export async function getUpload(id: string) {
  return db.formUpload.findUnique({ where: { id } });
}

/** Used by the tests and by the public page to enter a form's tenant. */
export const inShopScope = shopScope.run.bind(shopScope);

export { HONEYPOT_FIELD, RENDERED_AT_FIELD, SYSTEM_ACTOR };
