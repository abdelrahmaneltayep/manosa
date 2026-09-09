/**
 * The auto-approval evaluator.
 *
 * Pure and deterministic, like the pricing and tagging engines. It decides
 * nothing on its own account: it takes the facts of one application and the
 * merchant's criteria and returns a recommendation with its reasons.
 *
 * The reasons are the point. A merchant who is handed "approve" with no
 * working shown cannot tell a good rule from a rule that happens to be letting
 * everyone through, and approving the wrong buyer means selling at wholesale
 * to somebody who resells against you.
 */

export const CRITERION_FIELDS = [
  "vat_valid",
  "years_in_business",
  "country",
  "has_upload",
  "answer",
  "existing_customer",
] as const;
export type CriterionField = (typeof CRITERION_FIELDS)[number];

export type Criterion =
  /** VIES confirmed the number. Unverified does not satisfy this. */
  | { field: "vat_valid" }
  | { field: "years_in_business"; atLeast: number }
  | { field: "country"; op: "in" | "not_in"; values: string[] }
  /** A file was attached to this field, or to any field when key is null. */
  | { field: "has_upload"; key: string | null }
  | { field: "answer"; key: string; equals: string }
  /** They already buy from this store under the same email. */
  | { field: "existing_customer" };

export interface ApprovalCriteria {
  /** Off by default: deciding on its own is something a merchant switches on. */
  enabled: boolean;
  /** Every one must hold. "Any" is not offered — see the note below. */
  criteria: Criterion[];
  /**
   * What happens when the criteria do not hold. "review" sends it to the
   * queue; "reject" turns it down. Rejecting automatically is deliberately
   * possible and deliberately not the default.
   */
  otherwise: "review" | "reject";
}

export const DEFAULT_APPROVAL: ApprovalCriteria = {
  enabled: false,
  criteria: [],
  otherwise: "review",
};

/**
 * Only "all of" is offered, not "any of".
 *
 * An auto-approval rule that fires when *any* condition holds is a rule that
 * grows more permissive every time the merchant adds a line to it, which is
 * the opposite of what adding a line reads like. Every criterion narrows.
 */

export interface ApplicationFacts {
  /** From the VIES check. Only "valid" satisfies a vat_valid criterion. */
  vatStatus: "NONE" | "VALID" | "INVALID" | "UNVERIFIED";
  /** Years in business, when the form asked and the applicant answered. */
  years: number | null;
  /** ISO 3166-1 alpha-2, uppercased, or null. */
  countryCode: string | null;
  /** Field keys that arrived with a file. */
  uploadedFields: string[];
  /** Every answer, keyed by field key. */
  answers: Record<string, string>;
  /** Shopify already has a customer with this email. */
  existingCustomer: boolean;
}

export type Decision = "approve" | "review" | "reject";

export interface ReasonCode {
  /** Which criterion this is about. */
  field: CriterionField;
  met: boolean;
  /** Filled into the sentence shown to the merchant. */
  detail?: string;
}

export interface ApprovalVerdict {
  decision: Decision;
  /** One entry per criterion, in the order the merchant wrote them. */
  reasons: ReasonCode[];
  /** True when the evaluator was switched off, so nothing was evaluated. */
  notEvaluated: boolean;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function meets(criterion: Criterion, facts: ApplicationFacts): ReasonCode {
  switch (criterion.field) {
    case "vat_valid":
      // Unverified is not valid. It is the honest answer when VIES was
      // unreachable, and auto-approving on it would make an outage into a
      // wholesale account.
      return { field: "vat_valid", met: facts.vatStatus === "VALID" };

    case "years_in_business":
      return {
        field: "years_in_business",
        met: facts.years !== null && facts.years >= criterion.atLeast,
        detail: String(criterion.atLeast),
      };

    case "country": {
      const listed =
        facts.countryCode !== null &&
        criterion.values.some((value) => same(value, facts.countryCode!));
      return {
        field: "country",
        // An unknown country is not "not in the list": we do not know where
        // they are, so a criterion about location cannot be satisfied either
        // way. Failing closed sends it to a person.
        met:
          facts.countryCode === null ? false : criterion.op === "in" ? listed : !listed,
        detail: criterion.values.join(", "),
      };
    }

    case "has_upload":
      return {
        field: "has_upload",
        met: criterion.key
          ? facts.uploadedFields.includes(criterion.key)
          : facts.uploadedFields.length > 0,
        detail: criterion.key ?? undefined,
      };

    case "answer": {
      const answer = facts.answers[criterion.key];
      return {
        field: "answer",
        met: answer !== undefined && same(answer, criterion.equals),
        detail: `${criterion.key}=${criterion.equals}`,
      };
    }

    case "existing_customer":
      return { field: "existing_customer", met: facts.existingCustomer };
  }
}

export function evaluateApproval(
  criteria: ApprovalCriteria,
  facts: ApplicationFacts,
): ApprovalVerdict {
  if (!criteria.enabled) {
    return { decision: "review", reasons: [], notEvaluated: true };
  }

  // No criteria means nothing has been asked for. Approving on that would turn
  // "I switched it on" into "I approved everybody", which is not what switching
  // something on reads like.
  if (criteria.criteria.length === 0) {
    return { decision: "review", reasons: [], notEvaluated: true };
  }

  const reasons = criteria.criteria.map((criterion) => meets(criterion, facts));
  const allMet = reasons.every((reason) => reason.met);

  return {
    decision: allMet ? "approve" : criteria.otherwise,
    reasons,
    notEvaluated: false,
  };
}

/* -------------------------------------------------------------------------- */

export type ApprovalIssueCode =
  "no_criteria" | "years_negative" | "no_countries" | "no_key";

export interface ApprovalIssue {
  code: ApprovalIssueCode;
  detail?: string;
}

export function validateApproval(criteria: ApprovalCriteria): ApprovalIssue[] {
  const issues: ApprovalIssue[] = [];

  if (criteria.enabled && criteria.criteria.length === 0) {
    issues.push({ code: "no_criteria" });
  }

  for (const criterion of criteria.criteria) {
    if (criterion.field === "years_in_business" && criterion.atLeast < 0) {
      issues.push({ code: "years_negative" });
    }
    if (criterion.field === "country" && criterion.values.length === 0) {
      issues.push({ code: "no_countries" });
    }
    if (criterion.field === "answer" && !criterion.key.trim()) {
      issues.push({ code: "no_key" });
    }
  }

  return issues;
}

/** Never throws: a stored value we cannot read must not decide anything. */
export function readApproval(value: unknown): ApprovalCriteria {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_APPROVAL };

  const node = value as Partial<ApprovalCriteria>;
  const criteria: Criterion[] = [];

  for (const raw of Array.isArray(node.criteria) ? node.criteria : []) {
    const criterion = readCriterion(raw);
    if (criterion) criteria.push(criterion);
  }

  // A criterion we could not read is dropped, and dropping one makes the rule
  // *wider*. So a ruleset that lost anything stops deciding altogether.
  const lost = Array.isArray(node.criteria) && criteria.length !== node.criteria.length;

  return {
    enabled: node.enabled === true && !lost,
    criteria,
    otherwise: node.otherwise === "reject" ? "reject" : "review",
  };
}

function readCriterion(raw: unknown): Criterion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const node = raw as Record<string, unknown>;

  switch (node.field) {
    case "vat_valid":
      return { field: "vat_valid" };
    case "existing_customer":
      return { field: "existing_customer" };
    case "years_in_business": {
      const atLeast = Number(node.atLeast);
      return Number.isFinite(atLeast) ? { field: "years_in_business", atLeast } : null;
    }
    case "country": {
      if (node.op !== "in" && node.op !== "not_in") return null;
      if (!Array.isArray(node.values)) return null;
      const values = node.values.filter((v): v is string => typeof v === "string");
      return values.length > 0 ? { field: "country", op: node.op, values } : null;
    }
    case "has_upload":
      return {
        field: "has_upload",
        key: typeof node.key === "string" && node.key.trim() ? node.key : null,
      };
    case "answer":
      if (typeof node.key !== "string" || typeof node.equals !== "string") return null;
      if (!node.key.trim()) return null;
      return { field: "answer", key: node.key, equals: node.equals };
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */

/** Why an application was turned down. The reviewer picks one. */
export const REJECTION_REASONS = [
  "not_a_business",
  "no_verification",
  "outside_area",
  "competitor",
  "duplicate",
  "other",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export function isRejectionReason(value: unknown): value is RejectionReason {
  return (
    typeof value === "string" && (REJECTION_REASONS as readonly string[]).includes(value)
  );
}

/** The domain part of an email address, lowercased. Null if there isn't one. */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain || null;
}
