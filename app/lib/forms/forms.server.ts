import type { Prisma, RegistrationForm } from "@prisma/client";

import { db } from "~/db.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import { assertWithinLimit } from "~/lib/billing/gate.server";
import {
  readAppearance,
  readPublish,
  type Appearance,
  type PublishSettings,
} from "~/lib/forms/appearance";
import {
  DEFAULT_APPROVAL,
  readApproval,
  validateApproval,
  type ApprovalCriteria,
  type ApprovalIssue,
} from "~/lib/forms/approval";
import {
  readEmails,
  validateEmails,
  type EmailIssue,
  type EmailTemplates,
} from "~/lib/forms/merge-tags";
import {
  readDefinition,
  validateDefinition,
  type DefinitionIssue,
  type FormDefinition,
} from "~/lib/forms/schema";
import {
  appearanceFromTemplate,
  definitionFromTemplate,
  emailsFromTemplate,
  publishFromTemplate,
  FORM_TEMPLATES,
  type FormTemplate,
} from "~/lib/forms/templates";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { syncShopDomain } from "~/lib/shop/domains.server";
import { tenant } from "~/lib/tenant/shop-context.server";

/** How far back the card's submission and conversion figures look. */
export const STATS_WINDOW_DAYS = 30;

export class FormValidationError extends Error {
  constructor(
    readonly definitionIssues: DefinitionIssue[],
    readonly emailIssues: EmailIssue[],
    readonly approvalIssues: ApprovalIssue[] = [],
  ) {
    super(
      `Form is not valid: ${[
        ...definitionIssues.map((issue) => issue.code),
        ...emailIssues.map((issue) => issue.code),
        ...approvalIssues.map((issue) => issue.code),
      ].join(", ")}`,
    );
    this.name = "FormValidationError";
  }
}

/** A form with its JSON columns already parsed. */
export interface LoadedForm {
  row: RegistrationForm;
  definition: FormDefinition;
  appearance: Appearance;
  emails: EmailTemplates;
  publish: PublishSettings;
  approval: ApprovalCriteria;
}

export function load(row: RegistrationForm): LoadedForm {
  return {
    row,
    definition: readDefinition(row.fields),
    appearance: readAppearance(row.appearance),
    emails: readEmails(row.emails),
    publish: readPublish(row.publish),
    approval: readApproval(row.approval),
  };
}

/** URL- and link-safe slug. */
export function toSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "form"
  );
}

/**
 * A slug nobody else in this shop is using.
 *
 * Duplicating appends "-copy", then "-copy-2" — the checklist's rule, and the
 * only one that does not silently overwrite the form a merchant is copying.
 */
export async function availableSlug(base: string, exceptId?: string): Promise<string> {
  const root = toSlug(base);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
    const clash = await db.registrationForm.findFirst({
      where: { slug: candidate, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (!clash) return candidate;
  }

  return `${root}-${Date.now()}`;
}

export interface FormStats {
  views: number;
  submissions: number;
}

/** Views and submissions per form over the stats window. */
export async function statsFor(
  formIds: string[],
  now: Date = new Date(),
): Promise<Map<string, FormStats>> {
  const since = new Date(now.getTime() - STATS_WINDOW_DAYS * 86_400_000);
  const rows = await db.formEvent.groupBy({
    by: ["formId", "kind"],
    where: { formId: { in: formIds }, at: { gte: since } },
    _count: { _all: true },
  });

  const stats = new Map<string, FormStats>();
  for (const id of formIds) stats.set(id, { views: 0, submissions: 0 });

  for (const row of rows) {
    const entry = stats.get(row.formId) ?? { views: 0, submissions: 0 };
    if (row.kind === "VIEW") entry.views = row._count._all;
    else entry.submissions = row._count._all;
    stats.set(row.formId, entry);
  }

  return stats;
}

export async function listForms(): Promise<RegistrationForm[]> {
  return db.registrationForm.findMany({
    where: { archivedAt: null },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
  });
}

export async function getForm(id: string): Promise<LoadedForm | null> {
  const row = await db.registrationForm.findUnique({ where: { id } });
  return row ? load(row) : null;
}

export interface FormInput {
  name: string;
  slug?: string;
  definition: FormDefinition;
  appearance: Appearance;
  emails: EmailTemplates;
  publish: PublishSettings;
  approval?: ApprovalCriteria;
  status?: "DRAFT" | "LIVE";
}

/**
 * Check a form before it is stored.
 *
 * A draft is allowed to be incomplete — that is what a draft is — but going
 * live is refused on any issue. A published form that quietly rejects every
 * submission is worse than one that never published.
 */
export function issuesFor(input: FormInput) {
  return {
    definitionIssues: validateDefinition(input.definition),
    emailIssues: validateEmails(input.emails),
    approvalIssues: validateApproval(input.approval ?? DEFAULT_APPROVAL),
  };
}

function jsonData(input: FormInput) {
  return {
    name: input.name.trim(),
    fields: input.definition as unknown as Prisma.InputJsonValue,
    appearance: input.appearance as unknown as Prisma.InputJsonValue,
    emails: input.emails as unknown as Prisma.InputJsonValue,
    publish: input.publish as unknown as Prisma.InputJsonValue,
    approval: (input.approval ?? DEFAULT_APPROVAL) as unknown as Prisma.InputJsonValue,
  };
}

export async function createForm(
  input: FormInput,
  actor: AuditActor,
  template?: string | null,
): Promise<RegistrationForm> {
  // Free allows one form. Counted here rather than by the caller so the check
  // and the insert cannot drift apart.
  const existing = await db.registrationForm.count({ where: { archivedAt: null } });
  await assertWithinLimit("forms", existing);

  if (input.status === "LIVE") assertPublishable(input);

  const created = await db.registrationForm.create({
    data: {
      ...tenant(),
      ...jsonData(input),
      slug: await availableSlug(input.slug ?? input.name),
      status: input.status ?? "DRAFT",
      template: template ?? null,
      createdBy: actor.id ?? null,
      updatedBy: actor.id ?? null,
    },
  });

  await recordAudit({
    actor,
    action: "form.created",
    summary: `Created the registration form “${created.name}”.`,
    subject: { type: "RegistrationForm", id: created.id },
    metadata: { slug: created.slug, template: template ?? null },
  });

  return created;
}

function assertPublishable(input: FormInput) {
  const { definitionIssues, emailIssues, approvalIssues } = issuesFor(input);
  if (
    definitionIssues.length > 0 ||
    emailIssues.length > 0 ||
    approvalIssues.length > 0
  ) {
    throw new FormValidationError(definitionIssues, emailIssues, approvalIssues);
  }
}

export async function updateForm(
  id: string,
  input: FormInput,
  actor: AuditActor,
  admin?: AdminGraphql,
): Promise<RegistrationForm> {
  const current = await db.registrationForm.findUnique({ where: { id } });
  if (!current) throw new Response("Form not found", { status: 404 });

  const status = input.status ?? current.status;
  if (status === "LIVE") assertPublishable(input);

  // Going live is the moment the storefront domain starts to matter: the theme
  // block frames the form, and frame-ancestors has to name that origin.
  if (status === "LIVE" && current.status !== "LIVE" && admin) {
    await syncShopDomain(admin);
  }

  const updated = await db.registrationForm.update({
    where: { id },
    data: {
      ...jsonData(input),
      ...(input.slug ? { slug: await availableSlug(input.slug, id) } : {}),
      status,
      updatedBy: actor.id ?? null,
    },
  });

  await recordAudit({
    actor,
    action: current.status !== status ? `form.${status.toLowerCase()}` : "form.updated",
    summary:
      current.status === status
        ? `Updated the registration form “${updated.name}”.`
        : status === "LIVE"
          ? `Published “${updated.name}”. It is now accepting applications.`
          : `Unpublished “${updated.name}”. It no longer accepts applications.`,
    subject: { type: "RegistrationForm", id },
    metadata: { slug: updated.slug, status },
  });

  return updated;
}

/** Duplicate a form. The copy is always a draft. */
export async function duplicateForm(
  id: string,
  actor: AuditActor,
  copySuffix: string,
): Promise<RegistrationForm> {
  const current = await db.registrationForm.findUnique({ where: { id } });
  if (!current) throw new Response("Form not found", { status: 404 });

  const existing = await db.registrationForm.count({ where: { archivedAt: null } });
  await assertWithinLimit("forms", existing);

  const copy = await db.registrationForm.create({
    data: {
      ...tenant(),
      name: `${current.name} ${copySuffix}`,
      slug: await availableSlug(`${current.slug}-copy`),
      // Never live: two identical forms both accepting applications is a
      // merchant's copy quietly competing with their original.
      status: "DRAFT",
      fields: current.fields as Prisma.InputJsonValue,
      appearance: current.appearance as Prisma.InputJsonValue,
      emails: current.emails as Prisma.InputJsonValue,
      publish: current.publish as Prisma.InputJsonValue,
      approval: (current.approval ?? DEFAULT_APPROVAL) as Prisma.InputJsonValue,
      template: current.template,
      createdBy: actor.id ?? null,
      updatedBy: actor.id ?? null,
    },
  });

  await recordAudit({
    actor,
    action: "form.duplicated",
    summary: `Duplicated “${current.name}” as a draft.`,
    subject: { type: "RegistrationForm", id: copy.id },
    metadata: { from: id, slug: copy.slug },
  });

  return copy;
}

/**
 * Soft delete.
 *
 * The submissions stay: applications a merchant already received are theirs,
 * and deleting a form should not delete the customers it brought in.
 */
export async function archiveForm(id: string, actor: AuditActor) {
  const current = await db.registrationForm.findUnique({ where: { id } });
  if (!current) throw new Response("Form not found", { status: 404 });

  const archived = await db.registrationForm.update({
    where: { id },
    data: { archivedAt: new Date(), status: "DRAFT" },
  });

  await recordAudit({
    actor,
    action: "form.archived",
    summary: `Archived “${current.name}”. It stops accepting applications; the ones it already received are kept.`,
    subject: { type: "RegistrationForm", id },
  });

  return archived;
}

/** Build a form from one of the three starters. */
export async function createFromTemplate(
  template: FormTemplate,
  t: (key: string) => string,
  actor: AuditActor,
): Promise<RegistrationForm> {
  return createForm(
    {
      name: t(template.i18nKey),
      slug: template.slug,
      definition: definitionFromTemplate(template, t),
      appearance: appearanceFromTemplate(),
      emails: emailsFromTemplate(t),
      publish: publishFromTemplate(),
      status: "DRAFT",
    },
    actor,
    template.key,
  );
}

export { FORM_TEMPLATES };
