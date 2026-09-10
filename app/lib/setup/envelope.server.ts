import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The setup wizard's hidden field, signed.
 *
 * The plan travels back to the server in a form field, which means the merchant
 * — or anything with their session — can edit it. `readSetupPlan` re-validates
 * the plan itself, so a tampered rule cannot become a bad price. What it cannot
 * check is the **provenance**: which model wrote this, under which prompt, with
 * which request id. Those three go straight into an `AuditLog` row that says a
 * model was involved, and an audit entry dictated by the client is not an audit
 * entry.
 *
 * So the envelope is signed with the app secret when it is issued and verified
 * before it is applied. An unsigned or edited envelope is refused outright —
 * the merchant is asked to run the wizard again, which costs them a minute and
 * costs an attacker the whole path.
 */

export interface WizardEnvelope {
  plan: unknown;
  model: string;
  promptVersion: string;
  requestId: string | null;
}

export class MissingSigningSecretError extends Error {
  constructor() {
    super("SHOPIFY_API_SECRET is not set, so the setup wizard cannot sign a plan.");
    this.name = "MissingSigningSecretError";
  }
}

function secret(): string {
  const value = process.env.SHOPIFY_API_SECRET?.trim();
  // Never invented, never defaulted: with no secret every envelope is refused,
  // which is the only safe reading of "we cannot check this".
  if (!value) throw new MissingSigningSecretError();
  return value;
}

const sign = (body: string) => createHmac("sha256", secret()).update(body).digest("hex");

export function encodeEnvelope(envelope: WizardEnvelope): string {
  const body = JSON.stringify(envelope);
  return JSON.stringify({ body, signature: sign(body) });
}

/**
 * Read an envelope back, or nothing.
 *
 * Nothing is what a caller gets for unreadable JSON, a missing signature, a
 * signature that does not match, and an envelope with no provenance in it. The
 * caller cannot tell those apart, and does not need to: all four mean "run the
 * wizard again".
 */
export function decodeEnvelope(raw: string): WizardEnvelope | null {
  try {
    const outer: unknown = JSON.parse(raw);
    if (typeof outer !== "object" || outer === null) return null;

    const { body, signature } = outer as { body?: unknown; signature?: unknown };
    if (typeof body !== "string" || typeof signature !== "string") return null;

    const expected = Buffer.from(sign(body), "utf8");
    const provided = Buffer.from(signature, "utf8");
    // Length first: `timingSafeEqual` throws on a mismatch, and the length of a
    // signature is not a secret.
    if (expected.length !== provided.length) return null;
    if (!timingSafeEqual(expected, provided)) return null;

    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const envelope = parsed as Partial<WizardEnvelope>;

    // No provenance, no apply: the audit entry has to name what read this.
    if (typeof envelope.model !== "string" || envelope.model === "") return null;

    return {
      plan: envelope.plan,
      model: envelope.model,
      promptVersion: String(envelope.promptVersion ?? ""),
      requestId: typeof envelope.requestId === "string" ? envelope.requestId : null,
    };
  } catch {
    return null;
  }
}
