import type { FormSubmission, RegistrationForm } from "@prisma/client";

import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from "~/lib/audit/record.server";
import {
  createCustomer,
  findCustomerByEmail,
  applyTagChange,
} from "~/lib/customers/admin-graphql.server";
import { factsFromNode, upsertCustomer } from "~/lib/customers/sync.server";
import { normalizeTags } from "~/lib/customers/tagging";
import { deliverEmail } from "~/lib/email/deliver.server";
import { readPublish } from "~/lib/forms/appearance";
import {
  domainOf,
  evaluateApproval,
  isRejectionReason,
  readApproval,
  type ApplicationFacts,
  type ApprovalVerdict,
  type RejectionReason,
} from "~/lib/forms/approval";
import { readEmails } from "~/lib/forms/merge-tags";
import { readDefinition, type Answers } from "~/lib/forms/schema";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { publishBuyerTerms } from "~/lib/terms/ledger.server";
import { tenant } from "~/lib/tenant/shop-context.server";

/**
 * Deciding on an application.
 *
 * The three things this owes a merchant: a decision is never silent (every one
 * writes an audit entry and, where a buyer is affected, an email record), a
 * rejection always carries a reason, and an approval can be taken back for ten
 * seconds — which is how long it takes to notice you clicked the wrong row.
 */

/** How long an approval can be undone. */
export const UNDO_WINDOW_MS = 10_000;

export class AlreadyDecidedError extends Error {
  constructor(
    readonly submissionId: string,
    readonly status: string,
  ) {
    super(`Application ${submissionId} was already ${status.toLowerCase()}.`);
    this.name = "AlreadyDecidedError";
  }
}

export class UndoWindowClosedError extends Error {
  constructor(readonly submissionId: string) {
    super(
      `The ten seconds to undo this approval have passed. Reject the buyer if ` +
        `the decision was wrong — that is a decision with a reason, which undo is not.`,
    );
    this.name = "UndoWindowClosedError";
  }
}

export class ReasonRequiredError extends Error {
  constructor() {
    super("A rejection needs a reason. Nobody can answer an applicant without one.");
    this.name = "ReasonRequiredError";
  }
}

/* -------------------------------------------------------------------------- */
/* The facts an application presents                                           */
/* -------------------------------------------------------------------------- */

export interface FactsInput {
  submission: Pick<FormSubmission, "vatStatus" | "answers" | "customerId">;
  form: Pick<RegistrationForm, "fields">;
  uploadedFields: string[];
  existingCustomer: boolean;
  countryCode: string | null;
}

export function factsFor(input: FactsInput): ApplicationFacts {
  const definition = readDefinition(input.form.fields);
  const answers = (input.submission.answers ?? {}) as Answers;

  const yearsField = definition.fields.find(
    (field) => field.kind === "years_in_business",
  );
  const rawYears = yearsField ? answers[yearsField.key] : undefined;
  const years = rawYears === undefined ? null : Number(rawYears);

  return {
    vatStatus: input.submission.vatStatus,
    years: years !== null && Number.isFinite(years) ? years : null,
    countryCode: input.countryCode,
    uploadedFields: input.uploadedFields,
    answers,
    existingCustomer: input.existingCustomer,
  };
}

/* -------------------------------------------------------------------------- */
/* Blocked domains                                                             */
/* -------------------------------------------------------------------------- */

export async function isDomainBlocked(email: string): Promise<boolean> {
  const domain = domainOf(email);
  if (!domain) return false;

  const blocked = await db.blockedDomain.findFirst({ where: { domain } });
  return blocked !== null;
}

export async function blockDomain(email: string, reason: string, actor: AuditActor) {
  const domain = domainOf(email);
  if (!domain) return null;

  const existing = await db.blockedDomain.findFirst({ where: { domain } });
  if (existing) return existing;

  const created = await db.blockedDomain.create({
    data: { ...tenant(), domain, reason, createdBy: actor.id ?? null },
  });

  await recordAudit({
    actor,
    action: "form.domain_blocked",
    summary: `Blocked applications from ${domain}.`,
    subject: { type: "BlockedDomain", id: created.id },
    metadata: { domain, reason },
  });

  return created;
}

export async function unblockDomain(id: string, actor: AuditActor) {
  const existing = await db.blockedDomain.findUnique({ where: { id } });
  if (!existing) throw new Response("Not found", { status: 404 });

  await db.blockedDomain.delete({ where: { id } });

  await recordAudit({
    actor,
    action: "form.domain_unblocked",
    summary: `Unblocked applications from ${existing.domain}.`,
    metadata: { domain: existing.domain },
  });
}

export async function listBlockedDomains() {
  return db.blockedDomain.findMany({ orderBy: { createdAt: "desc" } });
}

/* -------------------------------------------------------------------------- */
/* Approving                                                                   */
/* -------------------------------------------------------------------------- */

export interface DecisionContext {
  admin: AdminGraphql;
  actor: AuditActor;
  now?: Date;
}

export interface ApproveOptions {
  /** Tier the buyer joins. Defaults to the form's own setting. */
  groupId?: string | null;
  /** Skip the email — for a merchant who would rather write their own. */
  notify?: boolean;
  /** Replaces the template for this send only. */
  email?: { subject: string; body: string } | null;
  /** Set when the evaluator decided, not a person. */
  automatic?: boolean;
}

async function loadForDecision(id: string) {
  const submission = await db.formSubmission.findUnique({
    where: { id },
    include: { form: true, uploads: { select: { fieldKey: true } } },
  });
  if (!submission) throw new Response("Application not found", { status: 404 });
  return submission;
}

/**
 * Approve an application.
 *
 * Finds the buyer in Shopify by email before creating one: a wholesale
 * applicant is very often already a retail customer of the same store, and a
 * second account would split their order history in half.
 */
export async function approveSubmission(
  id: string,
  options: ApproveOptions,
  { admin, actor, now = new Date() }: DecisionContext,
) {
  const submission = await loadForDecision(id);
  if (submission.status !== "PENDING") {
    throw new AlreadyDecidedError(id, submission.status);
  }

  const publish = readPublish(submission.form.publish);
  const groupId = options.groupId === undefined ? publish.autoGroupId : options.groupId;
  const group = groupId
    ? await db.customerGroup.findUnique({ where: { id: groupId } })
    : null;
  if (groupId && !group) throw new Response("Group not found", { status: 404 });

  const answers = (submission.answers ?? {}) as Answers;
  const definition = readDefinition(submission.form.fields);
  const firstName = answerOfKind(definition, answers, "text", 0);
  const lastName = answerOfKind(definition, answers, "text", 1);
  const phone = answerOfKind(definition, answers, "phone", 0);

  const tags = normalizeTags([...publish.autoTags, ...(group ? [group.tag] : [])]);

  const existing = await findCustomerByEmail(admin, submission.email);
  let customerId: string;
  let createdCustomer = false;

  if (existing) {
    customerId = existing.id;
    // Additive, so a loyalty app's tags on an existing retail customer survive
    // being approved for wholesale.
    if (tags.length > 0)
      await applyTagChange(admin, customerId, { add: tags, remove: [] });
    await upsertCustomer({
      ...factsFromNode(existing),
      tags: normalizeTags([...(existing.tags ?? []), ...tags]),
    });
  } else {
    const created = await createCustomer(admin, {
      email: submission.email,
      firstName,
      lastName,
      phone,
      tags,
      note: submission.company ? `Wholesale applicant — ${submission.company}` : null,
    });
    customerId = created.id;
    createdCustomer = true;
    await upsertCustomer(factsFromNode(created));
  }

  const mirrored = await db.customer.update({
    where: { shop_customerId: { shop: tenant().shop, customerId } },
    data: {
      groupId: group?.id ?? null,
      status: "APPROVED",
      company: submission.company ?? undefined,
    },
  });

  // Checkout has to be told, or the admin shows a wholesale price the till
  // does not honour.
  // Their tier's net terms take effect the moment they are approved into it,
  // so the terms go out with the tags rather than waiting for the next edit.
  await publishBuyerTerms(admin, { ...mirrored, group: group ?? null });

  const decided = await db.formSubmission.update({
    where: { id },
    data: {
      status: "APPROVED",
      customerId,
      decidedAt: now,
      decidedBy: options.automatic ? null : (actor.id ?? null),
      decidedAutomatically: options.automatic === true,
      undoableUntil: new Date(now.getTime() + UNDO_WINDOW_MS),
    },
  });

  await recordAudit({
    actor: options.automatic ? SYSTEM_ACTOR : actor,
    action: "form.approved",
    summary: options.automatic
      ? `Auto-approved ${submission.company ?? submission.email}: every criterion was met.`
      : `Approved ${submission.company ?? submission.email}${group ? ` into the “${group.name}” group` : ""}.`,
    subject: { type: "FormSubmission", id },
    metadata: {
      customerId,
      createdCustomer,
      groupId: group?.id ?? null,
      tags,
      automatic: options.automatic === true,
    },
  });

  if (options.notify !== false) {
    await deliverEmail({
      kind: "approved",
      to: submission.email,
      templates: readEmails(submission.form.emails),
      values: {
        first_name: firstName,
        last_name: lastName,
        company: submission.company,
        email: submission.email,
        form_name: submission.form.name,
        group_name: group?.name ?? null,
      },
      override: options.email ?? null,
      submissionId: id,
    });
  }

  return { submission: decided, customerId, createdCustomer };
}

/**
 * Take an approval back.
 *
 * Removes what the approval added — the tags, the group, the wholesale status
 * — and returns the application to the queue. It does **not** delete the
 * Shopify customer: deleting a customer account is destructive and
 * irreversible, and a stray account nobody has used costs the merchant
 * nothing. The audit entry says one was left behind.
 */
export async function undoApproval(
  id: string,
  { admin, actor, now = new Date() }: DecisionContext,
) {
  const submission = await loadForDecision(id);

  if (submission.status !== "APPROVED") {
    throw new AlreadyDecidedError(id, submission.status);
  }
  if (!submission.undoableUntil || submission.undoableUntil <= now) {
    throw new UndoWindowClosedError(id);
  }

  const publish = readPublish(submission.form.publish);
  const mirrored = submission.customerId
    ? await db.customer.findFirst({
        where: { customerId: submission.customerId },
        include: { group: true },
      })
    : null;

  const remove = normalizeTags([
    ...publish.autoTags,
    ...(mirrored?.group ? [mirrored.group.tag] : []),
  ]);

  if (submission.customerId && remove.length > 0) {
    await applyTagChange(admin, submission.customerId, { add: [], remove });
  }

  if (mirrored) {
    const tags = mirrored.tags.filter(
      (tag) => !remove.some((gone) => gone.toLowerCase() === tag.toLowerCase()),
    );
    const reverted = await db.customer.update({
      where: { id: mirrored.id },
      data: { tags, groupId: null, status: "PENDING" },
    });
    // Undoing an approval takes back the group, and with it the group's terms.
    await publishBuyerTerms(admin, { ...reverted, group: null });
  }

  const restored = await db.formSubmission.update({
    where: { id },
    data: {
      status: "PENDING",
      decidedAt: null,
      decidedBy: null,
      decidedAutomatically: false,
      undoableUntil: null,
      customerId: null,
    },
  });

  await recordAudit({
    actor,
    action: "form.approval_undone",
    summary: mirrored
      ? `Undid the approval of ${submission.company ?? submission.email}. Their Shopify customer account was left in place.`
      : `Undid the approval of ${submission.company ?? submission.email}.`,
    subject: { type: "FormSubmission", id },
    metadata: { customerId: submission.customerId, removedTags: remove },
  });

  return restored;
}

/* -------------------------------------------------------------------------- */
/* Rejecting, and asking for more                                              */
/* -------------------------------------------------------------------------- */

export interface RejectOptions {
  reason: RejectionReason;
  note?: string;
  /** Also refuse future applications from this email's domain. */
  blockDomain?: boolean;
  notify?: boolean;
  /** Replaces the template for this send only. */
  email?: { subject: string; body: string } | null;
  automatic?: boolean;
}

export async function rejectSubmission(
  id: string,
  options: RejectOptions,
  { actor, now = new Date() }: Omit<DecisionContext, "admin"> & { admin?: AdminGraphql },
) {
  const submission = await loadForDecision(id);
  if (submission.status !== "PENDING") {
    throw new AlreadyDecidedError(id, submission.status);
  }
  if (!isRejectionReason(options.reason)) throw new ReasonRequiredError();

  const decided = await db.formSubmission.update({
    where: { id },
    data: {
      status: "REJECTED",
      decidedAt: now,
      decidedBy: options.automatic ? null : (actor.id ?? null),
      decidedAutomatically: options.automatic === true,
      rejectionCode: options.reason,
      decisionNote: options.note?.trim() || null,
    },
  });

  if (options.blockDomain) {
    await blockDomain(submission.email, options.reason, actor);
  }

  await recordAudit({
    actor: options.automatic ? SYSTEM_ACTOR : actor,
    action: "form.rejected",
    summary: `Rejected ${submission.company ?? submission.email} (${options.reason}).`,
    subject: { type: "FormSubmission", id },
    metadata: {
      reason: options.reason,
      blockedDomain: options.blockDomain === true,
      automatic: options.automatic === true,
    },
  });

  if (options.notify !== false) {
    const answers = (submission.answers ?? {}) as Answers;
    const definition = readDefinition(submission.form.fields);

    await deliverEmail({
      kind: "rejected",
      to: submission.email,
      templates: readEmails(submission.form.emails),
      values: {
        first_name: answerOfKind(definition, answers, "text", 0),
        company: submission.company,
        email: submission.email,
        form_name: submission.form.name,
        // Whatever the reviewer typed, not the internal code — "competitor" is
        // not a sentence to send anyone.
        reason: options.note?.trim() ?? "",
      },
      override: options.email ?? null,
      submissionId: id,
    });
  }

  return decided;
}

/** Ask the applicant for more, and leave the application in the queue. */
export async function requestMoreInformation(
  id: string,
  note: string,
  actor: AuditActor,
) {
  const submission = await loadForDecision(id);
  if (submission.status !== "PENDING") {
    throw new AlreadyDecidedError(id, submission.status);
  }
  if (!note.trim()) throw new ReasonRequiredError();

  const answers = (submission.answers ?? {}) as Answers;
  const definition = readDefinition(submission.form.fields);

  await deliverEmail({
    kind: "needs_info",
    to: submission.email,
    templates: readEmails(submission.form.emails),
    values: {
      first_name: answerOfKind(definition, answers, "text", 0),
      company: submission.company,
      email: submission.email,
      form_name: submission.form.name,
      reason: note.trim(),
    },
    submissionId: id,
  });

  await recordAudit({
    actor,
    action: "form.info_requested",
    summary: `Asked ${submission.company ?? submission.email} for more information.`,
    subject: { type: "FormSubmission", id },
  });

  // Deliberately still PENDING: the merchant is waiting on a reply, and an
  // application that leaves the queue while it waits is one nobody comes back
  // to.
  return db.formSubmission.update({
    where: { id },
    data: { decisionNote: note.trim() },
  });
}

/* -------------------------------------------------------------------------- */
/* The evaluator, on arrival                                                   */
/* -------------------------------------------------------------------------- */

export interface ArrivalOutcome {
  verdict: ApprovalVerdict;
  /** What actually happened. "review" means it is in the queue. */
  applied: "approve" | "reject" | "review";
}

/**
 * Run the merchant's criteria against a new application.
 *
 * Called right after a submission is stored. It is separate from `submitForm`
 * on purpose: a buyer waiting on a form should not be waiting on the Admin
 * API, and a failure here must leave a perfectly good application in the queue
 * rather than losing it.
 */
export async function decideOnArrival(
  submissionId: string,
  context: DecisionContext,
): Promise<ArrivalOutcome> {
  const submission = await loadForDecision(submissionId);
  const criteria = readApproval(submission.form.approval);

  const mirrored = await db.customer.findFirst({
    where: { email: submission.email },
    select: { countryCode: true, customerId: true },
  });

  const verdict = evaluateApproval(
    criteria,
    factsFor({
      submission,
      form: submission.form,
      uploadedFields: submission.uploads.map((upload) => upload.fieldKey),
      existingCustomer: mirrored !== null,
      countryCode: mirrored?.countryCode ?? null,
    }),
  );

  if (verdict.decision === "approve") {
    await approveSubmission(submissionId, { automatic: true }, context);
    return { verdict, applied: "approve" };
  }

  if (verdict.decision === "reject") {
    await rejectSubmission(
      submissionId,
      { reason: "no_verification", automatic: true },
      context,
    );
    return { verdict, applied: "reject" };
  }

  return { verdict, applied: "review" };
}

/* -------------------------------------------------------------------------- */

/** The nth answer to a field of a given kind — how a name is recovered. */
function answerOfKind(
  definition: ReturnType<typeof readDefinition>,
  answers: Answers,
  kind: "text" | "phone",
  index: number,
): string | null {
  const fields = definition.fields.filter((field) => field.kind === kind);
  const field = fields[index];
  const value = field ? (answers[field.key] ?? "").trim() : "";
  return value || null;
}
