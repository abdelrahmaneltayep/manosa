/**
 * Sending mail.
 *
 * The transport is a seam with two implementations and a hard rule: if no
 * provider is configured, nothing pretends to have sent anything. A button
 * that reports success and sends nothing is worse than one that says there is
 * no sender — the merchant publishes the form and finds out from an applicant
 * who never got a confirmation.
 *
 * Configured by environment, so a deployment chooses without a code change:
 *
 *   MANNON_EMAIL_FROM      the From address. Required for anything to send.
 *   MANNON_EMAIL_TRANSPORT "resend" | "log". Defaults to "resend" when an API
 *                          key is present, otherwise nothing is configured.
 *   MANNON_RESEND_API_KEY  the key, for the resend transport.
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

/* -------------------------------------------------------------------------- */
/* The transports                                                              */
/* -------------------------------------------------------------------------- */

/** How long we wait on a provider before giving up on one message. */
export const SEND_TIMEOUT_MS = 10_000;

/**
 * Resend's HTTP API. Chosen because it is one POST with no SDK — a mail
 * provider is not worth a dependency in a codebase this careful about them.
 */
export function resendTransport(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = SEND_TIMEOUT_MS,
): EmailTransport {
  return {
    name: "resend",
    async send(email, from) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: [email.to],
            subject: email.subject,
            text: email.body,
          }),
        });

        if (!response.ok) {
          // The provider's own words, so a merchant looking at a failed
          // message sees why rather than "failed".
          const detail = await response.text().catch(() => "");
          throw new Error(`resend returned ${response.status}: ${detail.slice(0, 300)}`);
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Writes the message to the log instead of sending it.
 *
 * For development. It is a real transport rather than a silent no-op, so a
 * message it "sends" is recorded as sent by this transport and nobody has to
 * guess later whether a buyer was actually emailed.
 */
export function logTransport(): EmailTransport {
  return {
    name: "log",
    async send(email, from) {
      console.info(
        `[mannon:email] ${from} → ${email.to} · ${email.subject} (${email.reason})`,
      );
    },
  };
}

/** Build the transport this deployment is configured for, if any. */
export function transportFromEnv(fetchImpl: typeof fetch = fetch): EmailTransport | null {
  const choice = process.env.MANNON_EMAIL_TRANSPORT?.trim().toLowerCase();
  const apiKey = process.env.MANNON_RESEND_API_KEY?.trim();

  if (choice === "log") return logTransport();
  if (choice === "resend" || (!choice && apiKey)) {
    return apiKey ? resendTransport(apiKey, fetchImpl) : null;
  }
  return null;
}

/**
 * Register the configured transport. Called once at startup.
 *
 * Idempotent: calling it again with the same environment is a no-op, so a
 * module reload in dev does not stack transports.
 */
export function configureEmailFromEnv(fetchImpl: typeof fetch = fetch) {
  setEmailTransport(transportFromEnv(fetchImpl));
}

/** The transport currently registered, for the record on a sent message. */
export function transportName(): string | null {
  return transport?.name ?? null;
}
