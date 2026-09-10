import type { EmailMessage } from "@prisma/client";

import { db } from "~/db.server";
import {
  canSendEmail,
  configureEmailFromEnv,
  NoSenderConfiguredError,
  sendEmail,
  transportName,
} from "~/lib/email/send.server";
import {
  renderTemplate,
  type EmailKey,
  type EmailTemplates,
} from "~/lib/forms/merge-tags";
import { tenant } from "~/lib/tenant/shop-context.server";

/**
 * Rendering a notification and getting it out of the door.
 *
 * Every message is written down before it is attempted and updated after, so
 * "did they ever hear from us?" has an answer that does not depend on a
 * provider's dashboard. A merchant replying to an applicant who says they got
 * nothing needs to be able to see what was sent, when, and whether it failed.
 *
 * A failed send never fails the action that asked for it. Approving a buyer
 * and then rolling that back because a mail provider had a bad minute would
 * leave the merchant with a decision they made and the app disagreeing.
 */

// Registered here rather than in a startup file nobody would think to look at:
// this is the module that needs a transport, and it is imported wherever mail
// is sent. Without this line the app is permanently in "no sender" mode and
// says so on every screen, which is a quiet failure of exactly the kind the
// rest of this module exists to prevent.
configureEmailFromEnv();

/**
 * Messages that are not about a registration form.
 *
 * Form emails are looked up by key in that form's own templates, because each
 * form has its own wording. A payment reminder belongs to the store, not to a
 * form, so it carries its template with it rather than being added to
 * `EMAIL_KEYS` — which would demand every merchant fill in a reminder template
 * on every registration form before they could save one.
 */
export type TransactionalKey = "payment_reminder" | "quote_sent" | "quote_expiring";

export interface DeliverInput {
  kind: EmailKey | TransactionalKey;
  to: string;
  /** The form's templates, for a form email. Omitted when `template` is given. */
  templates?: EmailTemplates;
  values: Record<string, string | null | undefined>;
  submissionId?: string | null;
  /**
   * The template outright, for a message that belongs to no form.
   */
  template?: { subject: string; body: string } | null;
  /**
   * Replaces the template for this one send. This is what "Edit email before
   * sending" writes — the merchant is answering one applicant, not changing
   * the wording for everybody.
   */
  override?: { subject: string; body: string } | null;
}

export async function deliverEmail(input: DeliverInput): Promise<EmailMessage> {
  const template =
    input.override ?? input.template ?? input.templates?.[input.kind as EmailKey] ?? null;
  const subject = renderTemplate(template?.subject ?? "", input.values);
  const body = renderTemplate(template?.body ?? "", input.values);

  const message = await db.emailMessage.create({
    data: {
      ...tenant(),
      kind: input.kind,
      to: input.to,
      subject,
      body,
      submissionId: input.submissionId ?? null,
      status: "QUEUED",
      transport: transportName(),
    },
  });

  if (!canSendEmail()) {
    // Recorded as failed with the reason, not left QUEUED forever pretending
    // something might still pick it up.
    return db.emailMessage.update({
      where: { id: message.id },
      data: { status: "FAILED", error: new NoSenderConfiguredError().message },
    });
  }

  try {
    await sendEmail({ to: input.to, subject, body, reason: input.kind });
    return db.emailMessage.update({
      where: { id: message.id },
      data: { status: "SENT", sentAt: new Date(), transport: transportName() },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[mannon] could not send the ${input.kind} email: ${detail}`);
    return db.emailMessage.update({
      where: { id: message.id },
      data: { status: "FAILED", error: detail.slice(0, 1000) },
    });
  }
}

/** Messages about one application, newest first. */
export async function emailsFor(submissionId: string) {
  return db.emailMessage.findMany({
    where: { submissionId },
    orderBy: { createdAt: "desc" },
  });
}
