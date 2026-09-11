import { askForJson } from "~/lib/ai/json.server";
import type { AiDeps, AiResult } from "~/lib/ai/run.server";
import { MERGE_TAGS, unknownTags } from "~/lib/forms/merge-tags";

/**
 * ✦ Drafting the message to an applicant.
 *
 * Checklist §3: "✦ drafts the rejection email in brand voice", and the approval
 * email is "editable before send". Both land in the same panel the merchant
 * already edits — this only fills it in.
 *
 * The one rule that matters: **nothing is sent from here.** This returns a
 * subject and a body. A person reads them, changes them, and presses send —
 * which is also the only thing that records an audit entry. `brand.md` §5, in
 * its own words: "Claude drafts, you send. It never acts on its own."
 *
 * The applicant's name and address are not in the prompt. The draft uses merge
 * tags, which the send path fills in — so the model writes to "{{first_name}}"
 * and never learns who that is.
 */

export type EmailIntent = "approve" | "reject";

export interface EmailDraftFacts {
  intent: EmailIntent;
  /** The merchant's own template, as the voice to match. */
  template: { subject: string; body: string };
  shopName: string;
  formName: string;
  /** For an approval: the tier they are joining. */
  groupName: string | null;
  /** For a rejection: the code the merchant picked, and anything they typed. */
  reason: string | null;
  note: string | null;
  /** Locale of the merchant's admin, so the draft comes back in their language. */
  locale: string;
  /**
   * The merchant's own writing, from Settings → ✦ Agent controls.
   *
   * Optional because a shop with none still drafts — in a plain, neutral tone,
   * which is what the Settings card says happens without them.
   */
  voiceSamples?: { label: string; body: string }[];
}

export interface EmailDraft {
  subject: string;
  body: string;
}

export const EMAIL_DRAFT_SYSTEM = `You draft one email for a wholesale merchant to send to someone who applied for a trade account. The merchant reads it, edits it, and sends it. You never send anything.

Answer with a single JSON object and nothing else:

{ "subject": string, "body": string }

You may use these merge tags, and no others. They are filled in when the email is sent:

  {{first_name}}, {{last_name}}, {{company}}, {{email}}, {{shop_name}}, {{form_name}}, {{group_name}}, {{reason}}

Rules:
- Match the voice of the merchant's existing template. It is their business; you are writing as them.
- Plain text. No markdown, no HTML, no signature block the merchant did not ask for.
- Address the applicant with {{first_name}} rather than a name you invented.
- Never invent a fact: no discount figures, no delivery times, no account details, no dates, no promises about a future application unless the merchant's note says so.
- A rejection is short, plain and human. Say the decision, give the reason, and stop. No blame, no false hope, no "unfortunately at this time we are unable to" padding.
- If no reason is named below, write the rejection around the {{reason}} merge tag: the merchant chooses the reason after reading your draft, and the tag is filled in when they send. Put it in a sentence that reads correctly whichever reason they pick.
- An approval says what happens next in one or two sentences, and nothing it cannot know.
- Never mention that this email was drafted by an AI.
- Write in the language named as the merchant's, matching their template.`;

export function emailDraftUser(facts: EmailDraftFacts): string {
  return [
    `Email to draft: ${facts.intent === "approve" ? "approval" : "rejection"}`,
    `Merchant's language: ${facts.locale}`,
    `Store name: ${facts.shopName}`,
    `Application form: ${facts.formName}`,
    facts.groupName ? `Tier they are joining: ${facts.groupName}` : null,
    facts.reason ? `Reason the merchant chose: ${facts.reason}` : null,
    facts.note ? `What the merchant added: ${facts.note}` : null,
    "",
    "The merchant's existing template, which is the voice to match:",
    `Subject: ${facts.template.subject}`,
    facts.template.body,
    // The merchant's own messages, from Settings → ✦ Agent controls. The card
    // there says "Claude will match your tone", which was true of nothing
    // until this line: the samples were stored, shown and read by no prompt.
    ...(facts.voiceSamples && facts.voiceSamples.length > 0
      ? [
          "",
          "Messages this merchant has actually sent buyers. Match how they write — the greeting, the sign-off, how formal they are. Never copy their content.",
          ...facts.voiceSamples.map(
            (sample) => `--- ${sample.label} ---\n${sample.body}`,
          ),
        ]
      : []),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Bounds a draft. A model that runs away should not fill a send box. */
export const MAX_SUBJECT = 200;
export const MAX_BODY = 4_000;

export function readEmailDraft(
  value: unknown,
): { ok: true; value: EmailDraft } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "The answer was not a JSON object." };

  const subject = typeof value.subject === "string" ? value.subject.trim() : "";
  const body = typeof value.body === "string" ? value.body.trim() : "";

  if (!subject) return { ok: false, error: `"subject" must be a non-empty string.` };
  if (!body) return { ok: false, error: `"body" must be a non-empty string.` };
  if (subject.length > MAX_SUBJECT) {
    return { ok: false, error: `The subject must be under ${MAX_SUBJECT} characters.` };
  }
  if (body.length > MAX_BODY) {
    return { ok: false, error: `The body must be under ${MAX_BODY} characters.` };
  }

  // An invented tag renders as literal braces in a real buyer's inbox. The
  // send path refuses to save one, so it is refused here rather than shown to
  // the merchant as something they can send.
  const unknown = [...unknownTags(subject), ...unknownTags(body)];
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `These are not merge tags: ${unknown.join(", ")}. Use only ${MERGE_TAGS.join(", ")}.`,
    };
  }

  return { ok: true, value: { subject, body } };
}

/** Draft one email. Never sends, never writes, never throws. */
export function draftEmail(
  facts: EmailDraftFacts,
  deps: AiDeps = {},
): Promise<AiResult<EmailDraft>> {
  return askForJson<EmailDraft>(
    {
      feature: "email_draft",
      system: EMAIL_DRAFT_SYSTEM,
      user: emailDraftUser(facts),
      validate: readEmailDraft,
      maxTokens: 2_000,
    },
    deps,
  );
}
