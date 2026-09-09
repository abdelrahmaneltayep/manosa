/**
 * Sending mail.
 *
 * There is no provider wired up yet, and this module is deliberate about that
 * rather than quietly doing nothing. A "test send" button that reports success
 * and sends nothing is worse than one that says no sender is configured: the
 * merchant publishes the form, and finds out from an applicant who never got a
 * confirmation.
 *
 * The transport is a seam. When the approval pipeline (2.3) picks a provider,
 * it sets one here and everything that already calls `sendEmail` starts
 * working, unchanged.
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  /** Plain text. The templates are plain text on purpose — see ADR 0012. */
  body: string;
  /** For the log, so a send can be traced to what asked for it. */
  reason: string;
}

export interface EmailTransport {
  name: string;
  send: (email: OutgoingEmail, from: string) => Promise<void>;
}

export class NoSenderConfiguredError extends Error {
  readonly kind = "no-sender" as const;

  constructor() {
    super(
      "No email sender is configured. Set MANNON_EMAIL_FROM and register a " +
        "transport before anything relies on mail going out.",
    );
    this.name = "NoSenderConfiguredError";
  }
}

let transport: EmailTransport | null = null;

/** Register the provider. Called once at startup, when there is one. */
export function setEmailTransport(next: EmailTransport | null) {
  transport = next;
}

export function emailSender(): string | null {
  return process.env.MANNON_EMAIL_FROM?.trim() || null;
}

/** True when mail would actually leave the building. */
export function canSendEmail(): boolean {
  return transport !== null && emailSender() !== null;
}

export async function sendEmail(email: OutgoingEmail): Promise<void> {
  const from = emailSender();
  if (!transport || !from) throw new NoSenderConfiguredError();

  await transport.send(email, from);
}
