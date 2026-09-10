import type { FormSubmission, RegistrationForm } from "@prisma/client";

import { db } from "~/db.server";
import type { AiDeps } from "~/lib/ai/run.server";
import {
  screenApplication,
  type ScreeningFacts,
  type ScreeningReason,
} from "~/lib/ai/prompts/screening.server";
import { domainOf, evaluateApproval, readApproval } from "~/lib/forms/approval";
import { factsFor } from "~/lib/forms/decisions.server";
import { readDefinition, type Answers } from "~/lib/forms/schema";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Assembling the facts, and writing down what Claude made of them.
 *
 * The privacy promise lives here: `factsForScreening` is the only thing that
 * builds a screening prompt, and it carries no name, no email address, no phone
 * number and no free-text answer. What goes out is a company name, an email
 * *domain*, and signals this app derived — facts about a business.
 *
 * Nothing here decides anything. The verdict is a recommendation stored beside
 * the application; both buttons stay live in every state, including this one
 * failing.
 */

/**
 * Domains that say nothing about a business.
 *
 * Deliberately short and deliberately boring. It is a weak signal — plenty of
 * real trade buyers use one — so the model is told to weigh it rather than
 * decide on it, and the list only needs the addresses people actually use.
 */
export const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mail.com",
  "gmx.com",
  "gmx.de",
  "proton.me",
  "protonmail.com",
  "yandex.ru",
  "qq.com",
  "163.com",
]);

/**
 * The domain of a website the applicant typed, if they typed one.
 *
 * **Nothing is fetched.** The checklist's "checking website & VAT" is done by
 * comparing what they wrote to the domain they email from — a real signal that
 * costs no outbound request. Fetching an address a stranger supplied, from our
 * server, is a request we would be making on their behalf to somewhere we have
 * never heard of; see `docs/adr/0020`.
 */
export function websiteDomainIn(answers: Answers): string | null {
  for (const value of Object.values(answers)) {
    const domain = domainOfUrl(value);
    if (domain) return domain;
  }
  return null;
}

function domainOfUrl(value: string): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed === "" || trimmed.includes(" ")) return null;
  if (!/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(trimmed)) return null;
  // An email address is not a website, and would match the pattern above.
  if (trimmed.includes("@")) return null;

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Two domains match when one is the other, or a subdomain of it. */
export function domainsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export interface ScreeningInput {
  submission: FormSubmission & {
    form: RegistrationForm;
    uploads: { fieldKey: string; scannedAt: Date | null }[];
  };
  existingCustomer: boolean;
  countryCode: string | null;
  otherPendingFromDomain: number;
  storeCountry: string | null;
}

export function factsForScreening(input: ScreeningInput): ScreeningFacts {
  const { submission } = input;
  const answers = (submission.answers ?? {}) as Answers;
  const emailDomain = domainOf(submission.email);
  const websiteDomain = websiteDomainIn(answers);

  const criteria = readApproval(submission.form.approval);
  const verdict = evaluateApproval(
    criteria,
    factsFor({
      submission,
      form: submission.form,
      uploadedFields: submission.uploads.map((upload) => upload.fieldKey),
      existingCustomer: input.existingCustomer,
      countryCode: input.countryCode,
    }),
  );

  const definition = readDefinition(submission.form.fields);
  const yearsField = definition.fields.find(
    (field) => field.kind === "years_in_business",
  );
  const rawYears = yearsField ? Number(answers[yearsField.key]) : Number.NaN;

  return {
    company: submission.company,
    emailDomain,
    emailDomainIsFree: emailDomain !== null && FREE_EMAIL_DOMAINS.has(emailDomain),
    websiteDomain,
    websiteMatchesEmail:
      websiteDomain && emailDomain ? domainsMatch(websiteDomain, emailDomain) : null,
    vatStatus: submission.vatStatus,
    countryCode: input.countryCode,
    yearsInBusiness: Number.isFinite(rawYears) ? rawYears : null,
    documentCount: submission.uploads.length,
    documentsScanned:
      submission.uploads.length > 0 &&
      submission.uploads.every((upload) => upload.scannedAt !== null),
    existingCustomer: input.existingCustomer,
    otherPendingFromDomain: input.otherPendingFromDomain,
    criteriaMet: verdict.notEvaluated ? null : verdict.decision === "approve",
    storeCountry: input.storeCountry,
  };
}

/* -------------------------------------------------------------------------- */

/** Reasons as stored. Codes and numbers — never a sentence, so it translates. */
export function readReasons(value: unknown): ScreeningReason[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as { signal?: unknown; detail?: unknown };
    if (typeof raw.signal !== "string") return [];
    return [
      {
        signal: raw.signal as ScreeningReason["signal"],
        detail: typeof raw.detail === "number" ? raw.detail : null,
      },
    ];
  });
}

/**
 * Screen one application and write the verdict down.
 *
 * Never throws for a model failure: `UNAVAILABLE` is a state the queue renders,
 * and it means "we could not say", which is a different thing from a clean bill
 * of health. Returns the verdict it stored.
 */
export async function screenSubmission(
  input: ScreeningInput,
  deps: AiDeps = {},
): Promise<"RECOMMEND" | "LOOK" | "UNAVAILABLE"> {
  shopScope.require("screenSubmission");

  const result = await screenApplication(factsForScreening(input), deps);
  const now = new Date();

  if (!result.ok) {
    await db.formSubmission.update({
      where: { id: input.submission.id },
      data: { screening: "UNAVAILABLE", screenedAt: now, screeningReasons: [] },
    });
    return "UNAVAILABLE";
  }

  const screening = result.value.decision === "recommend" ? "RECOMMEND" : "LOOK";

  await db.formSubmission.update({
    where: { id: input.submission.id },
    data: {
      screening,
      screenedAt: now,
      screeningReasons: result.value.reasons,
      screeningModel: result.model,
      screeningPromptVersion: result.promptVersion,
      screeningRequestId: result.requestId,
    },
  });

  return screening;
}
