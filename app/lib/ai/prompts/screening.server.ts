import { askForJson } from "~/lib/ai/json.server";
import type { AiDeps, AiResult } from "~/lib/ai/run.server";

/**
 * ✦ Screening an application.
 *
 * Checklist §3: "Recommend approve (green + 3 reasons) / Needs a look (red +
 * reasons)", and never blocking the merchant's own decision.
 *
 * Two things make this safe to put next to a decision about a real business:
 *
 * 1. **Every fact is ours, and every reason is a code.** The model is given
 *    facts this app already holds and may answer only in a closed vocabulary of
 *    signal codes. It cannot invent a reason, and every reason it gives renders
 *    in the merchant's language from our own catalogue. A verdict a merchant
 *    cannot audit is one they cannot trust with who gets wholesale prices.
 * 2. **The applicant's own words never leave.** No name, no email address, no
 *    phone number, no free-text answer. The prompt carries the email *domain*,
 *    the company name and derived signals — business facts about a business.
 *
 * What is left for the model is the weighing: an unverified VAT id alongside a
 * matching website and twelve years in business reads differently from the same
 * VAT id on a free email address registered this year. That judgement is the
 * whole reason to ask.
 */

/** Every reason the model may give. It may not invent a fourteenth. */
export const SCREENING_SIGNALS = [
  "vat_valid",
  "vat_invalid",
  "vat_unverified",
  "vat_missing",
  "website_matches_email",
  "website_mismatch",
  "website_missing",
  "free_email_domain",
  "business_email_domain",
  "years_established",
  "years_new",
  "years_unknown",
  "documents_attached",
  "documents_missing",
  "documents_unscanned",
  "existing_customer",
  "duplicate_domain",
  "criteria_met",
  "criteria_failed",
] as const;

export type ScreeningSignal = (typeof SCREENING_SIGNALS)[number];

/** At most this many reasons. Three is the checklist's number, and it is right:
 *  a list of nine signals is a data dump, not a recommendation. */
export const MAX_REASONS = 3;

export type ScreeningDecision = "recommend" | "look";

export interface ScreeningReason {
  signal: ScreeningSignal;
  /** Fills the sentence — a year count, a document count. Never prose. */
  detail: number | null;
}

export interface ScreeningAnswer {
  decision: ScreeningDecision;
  reasons: ScreeningReason[];
}

/**
 * What the model is told. Business facts only.
 *
 * Assembled by `factsForScreening`, which is where the "no personal data"
 * promise is actually kept — `tests/unit/screening.test.ts` asserts it.
 */
export interface ScreeningFacts {
  company: string | null;
  /** The part after the @. Not the address. */
  emailDomain: string | null;
  emailDomainIsFree: boolean;
  /** The domain of a website the applicant gave, if they gave one. */
  websiteDomain: string | null;
  /** Null when they gave no website — which is not the same as a mismatch. */
  websiteMatchesEmail: boolean | null;
  vatStatus: "NONE" | "VALID" | "INVALID" | "UNVERIFIED";
  countryCode: string | null;
  yearsInBusiness: number | null;
  documentCount: number;
  documentsScanned: boolean;
  existingCustomer: boolean;
  /** Other applications waiting from the same email domain. */
  otherPendingFromDomain: number;
  /** The merchant's own criteria, when they have set any. */
  criteriaMet: boolean | null;
  /** The store's own country, for context on where a buyer is. */
  storeCountry: string | null;
}

export const SCREENING_SYSTEM = `You help a wholesale merchant triage registration applications for the Mannon Shopify app.

You are given facts the app already holds about one applicant. Decide whether the merchant can approve it without a second look, or whether something deserves their attention first.

Answer with a single JSON object and nothing else:

{
  "decision": "recommend" | "look",
  "reasons": [ { "signal": string, "detail": number | null } ]
}

"signal" must be one of exactly these, and nothing else:

  vat_valid, vat_invalid, vat_unverified, vat_missing,
  website_matches_email, website_mismatch, website_missing,
  free_email_domain, business_email_domain,
  years_established, years_new, years_unknown,
  documents_attached, documents_missing, documents_unscanned,
  existing_customer, duplicate_domain,
  criteria_met, criteria_failed

"detail" carries the number the reason is about, and nothing else: the year count
for years_established and years_new, the document count for documents_attached
and documents_unscanned, the count of other waiting applications for
duplicate_domain. Use null for every other signal.

Rules:
- At most three reasons, most decisive first. Fewer is fine.
- Only give a reason the facts support. Never repeat the same signal twice.
- "look" means a person should read it before approving. It does not mean reject,
  and it is not an accusation — say which signal made you say it.
- An unverified VAT id is not an invalid one. VIES goes down; that is not the
  applicant's doing, and it is weaker evidence than a mismatch would be.
- A free email address is weak evidence on its own. Plenty of real small
  businesses use one. Weigh it with the rest rather than deciding on it.
- Missing information is a reason for "look" only when the merchant's own
  criteria asked for it, or when nothing else vouches for the applicant.
- If the merchant's criteria already passed, say so, and do not overturn them on
  a hunch. If they failed, that is decisive.`;

export function screeningUser(facts: ScreeningFacts): string {
  const line = (label: string, value: string | number | boolean | null) =>
    `${label}: ${value === null ? "not known" : String(value)}`;

  return [
    line("Company name", facts.company),
    line("Email domain", facts.emailDomain),
    line("Email domain is a free provider", facts.emailDomainIsFree),
    line("Website domain given", facts.websiteDomain),
    line("Website domain matches email domain", facts.websiteMatchesEmail),
    line("VAT id status", facts.vatStatus),
    line("Country", facts.countryCode),
    line("Store's own country", facts.storeCountry),
    line("Years in business", facts.yearsInBusiness),
    line("Documents attached", facts.documentCount),
    line("Documents virus-scanned", facts.documentsScanned),
    line("Already a customer of this store", facts.existingCustomer),
    line("Other applications waiting from this domain", facts.otherPendingFromDomain),
    line("Merchant's own criteria", facts.criteriaMet),
  ].join("\n");
}

/* -------------------------------------------------------------------------- */

const SIGNALS: ReadonlySet<string> = new Set(SCREENING_SIGNALS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Narrow the answer, or say what is wrong with it in one sentence. */
export function readScreening(
  value: unknown,
): { ok: true; value: ScreeningAnswer } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "The answer was not a JSON object." };

  const decision = value.decision;
  if (decision !== "recommend" && decision !== "look") {
    return {
      ok: false,
      error: `"decision" was ${JSON.stringify(decision)}; it must be "recommend" or "look".`,
    };
  }

  if (!Array.isArray(value.reasons)) {
    return { ok: false, error: `"reasons" must be an array.` };
  }

  const reasons: ScreeningReason[] = [];
  const seen = new Set<string>();

  for (const raw of value.reasons) {
    if (!isRecord(raw)) return { ok: false, error: `Every reason must be an object.` };

    const signal = raw.signal;
    if (typeof signal !== "string" || !SIGNALS.has(signal)) {
      return {
        ok: false,
        error: `"${String(signal)}" is not one of the allowed signals.`,
      };
    }
    // A repeated signal is one reason padded to look like two.
    if (seen.has(signal)) continue;
    seen.add(signal);

    const detail = raw.detail;
    reasons.push({
      signal: signal as ScreeningSignal,
      detail: typeof detail === "number" && Number.isFinite(detail) ? detail : null,
    });
  }

  if (reasons.length === 0) {
    return { ok: false, error: `Give at least one reason from the list.` };
  }

  // Trimmed rather than refused: the model kept to the vocabulary, it was just
  // more thorough than the screen has room for.
  return { ok: true, value: { decision, reasons: reasons.slice(0, MAX_REASONS) } };
}

export function screenApplication(
  facts: ScreeningFacts,
  deps: AiDeps = {},
): Promise<AiResult<ScreeningAnswer>> {
  return askForJson<ScreeningAnswer>(
    {
      feature: "registration_screening",
      system: SCREENING_SYSTEM,
      user: screeningUser(facts),
      // No actor: the screening job runs on nobody's click.
      actorId: null,
      // The same application should not be recommended on Monday and doubted on
      // Tuesday. brand.md §5.
      temperature: 0,
      validate: readScreening,
    },
    deps,
  );
}
