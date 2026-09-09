import { describe, expect, it } from "vitest";

import {
  DEFAULT_APPROVAL,
  domainOf,
  evaluateApproval,
  isRejectionReason,
  meets,
  readApproval,
  validateApproval,
  type ApplicationFacts,
  type ApprovalCriteria,
  type Criterion,
} from "~/lib/forms/approval";

const facts = (overrides: Partial<ApplicationFacts> = {}): ApplicationFacts => ({
  vatStatus: "VALID",
  years: 5,
  countryCode: "SA",
  uploadedFields: ["licence"],
  answers: { business_type: "Distributor" },
  existingCustomer: false,
  ...overrides,
});

const criteria = (list: Criterion[], overrides: Partial<ApprovalCriteria> = {}) => ({
  ...DEFAULT_APPROVAL,
  enabled: true,
  criteria: list,
  ...overrides,
});

describe("one criterion at a time", () => {
  it("accepts only a VAT number VIES confirmed", () => {
    const criterion: Criterion = { field: "vat_valid" };
    expect(meets(criterion, facts()).met).toBe(true);
    expect(meets(criterion, facts({ vatStatus: "INVALID" })).met).toBe(false);
    // Unverified is the honest answer when VIES was unreachable. Approving on
    // it would turn somebody else's outage into a wholesale account.
    expect(meets(criterion, facts({ vatStatus: "UNVERIFIED" })).met).toBe(false);
    expect(meets(criterion, facts({ vatStatus: "NONE" })).met).toBe(false);
  });

  it("compares years, and refuses when they did not say", () => {
    const criterion: Criterion = { field: "years_in_business", atLeast: 2 };
    expect(meets(criterion, facts({ years: 2 })).met).toBe(true);
    expect(meets(criterion, facts({ years: 1 })).met).toBe(false);
    expect(meets(criterion, facts({ years: null })).met).toBe(false);
  });

  it("matches a country, ignoring case", () => {
    const inList: Criterion = { field: "country", op: "in", values: ["sa", "AE"] };
    expect(meets(inList, facts()).met).toBe(true);
    expect(meets(inList, facts({ countryCode: "EG" })).met).toBe(false);
  });

  it("fails closed when we do not know where they are", () => {
    // An unknown country is not "not in the list": we do not know, so a
    // criterion about location cannot be satisfied either way, and failing
    // closed sends it to a person.
    const notIn: Criterion = { field: "country", op: "not_in", values: ["SA"] };
    expect(meets(notIn, facts({ countryCode: null })).met).toBe(false);
    expect(meets(notIn, facts({ countryCode: "EG" })).met).toBe(true);
  });

  it("checks for a file, by field or at all", () => {
    expect(meets({ field: "has_upload", key: "licence" }, facts()).met).toBe(true);
    expect(meets({ field: "has_upload", key: "tax_cert" }, facts()).met).toBe(false);
    expect(meets({ field: "has_upload", key: null }, facts()).met).toBe(true);
    expect(
      meets({ field: "has_upload", key: null }, facts({ uploadedFields: [] })).met,
    ).toBe(false);
  });

  it("compares an answer without caring about case", () => {
    const criterion: Criterion = {
      field: "answer",
      key: "business_type",
      equals: "distributor",
    };
    expect(meets(criterion, facts()).met).toBe(true);
    expect(meets(criterion, facts({ answers: { business_type: "Retailer" } })).met).toBe(
      false,
    );
    expect(meets(criterion, facts({ answers: {} })).met).toBe(false);
  });
});

describe("evaluating an application", () => {
  it("does nothing at all when it is switched off", () => {
    const verdict = evaluateApproval(
      criteria([{ field: "vat_valid" }], { enabled: false }),
      facts(),
    );
    expect(verdict).toEqual({ decision: "review", reasons: [], notEvaluated: true });
  });

  it("does nothing when it is on with nothing to check", () => {
    // "I switched it on" must not read as "I approved everybody".
    const verdict = evaluateApproval(criteria([]), facts());
    expect(verdict.decision).toBe("review");
    expect(verdict.notEvaluated).toBe(true);
  });

  it("approves when every criterion holds", () => {
    const verdict = evaluateApproval(
      criteria([
        { field: "vat_valid" },
        { field: "years_in_business", atLeast: 2 },
        { field: "country", op: "in", values: ["SA"] },
      ]),
      facts(),
    );
    expect(verdict.decision).toBe("approve");
    expect(verdict.reasons.every((reason) => reason.met)).toBe(true);
  });

  it("needs every criterion, not any of them", () => {
    // Each line a merchant adds narrows the rule. An "any of" would widen it,
    // which is the opposite of what adding a line reads like.
    const verdict = evaluateApproval(
      criteria([{ field: "vat_valid" }, { field: "years_in_business", atLeast: 10 }]),
      facts(),
    );
    expect(verdict.decision).toBe("review");
    expect(verdict.reasons.map((reason) => reason.met)).toEqual([true, false]);
  });

  it("sends it to a person by default when it does not qualify", () => {
    expect(
      evaluateApproval(criteria([{ field: "vat_valid" }]), facts({ vatStatus: "NONE" }))
        .decision,
    ).toBe("review");
  });

  it("can reject automatically, when the merchant asked for that", () => {
    expect(
      evaluateApproval(
        criteria([{ field: "vat_valid" }], { otherwise: "reject" }),
        facts({ vatStatus: "INVALID" }),
      ).decision,
    ).toBe("reject");
  });

  it("returns the reasons in the order they were written", () => {
    const verdict = evaluateApproval(
      criteria([
        { field: "years_in_business", atLeast: 2 },
        { field: "vat_valid" },
        { field: "existing_customer" },
      ]),
      facts(),
    );
    expect(verdict.reasons.map((reason) => reason.field)).toEqual([
      "years_in_business",
      "vat_valid",
      "existing_customer",
    ]);
  });

  it("gives the same verdict twice", () => {
    const list = criteria([{ field: "vat_valid" }]);
    expect(evaluateApproval(list, facts())).toEqual(evaluateApproval(list, facts()));
  });

  it("does not mutate what it is given", () => {
    const list = criteria([{ field: "vat_valid" }]);
    const buyer = facts();
    const snapshot = JSON.stringify({ list, buyer });
    evaluateApproval(list, buyer);
    expect(JSON.stringify({ list, buyer })).toBe(snapshot);
  });
});

describe("reading stored criteria", () => {
  it("reads every criterion kind back", () => {
    const read = readApproval({
      enabled: true,
      otherwise: "reject",
      criteria: [
        { field: "vat_valid" },
        { field: "years_in_business", atLeast: 3 },
        { field: "country", op: "not_in", values: ["EG"] },
        { field: "has_upload", key: "licence" },
        { field: "answer", key: "type", equals: "Distributor" },
        { field: "existing_customer" },
      ],
    });

    expect(read.enabled).toBe(true);
    expect(read.otherwise).toBe("reject");
    expect(read.criteria).toHaveLength(6);
  });

  it("stops deciding altogether when it could not read a criterion", () => {
    // Dropping a criterion makes the rule *wider*, and a wider auto-approval
    // rule approves people the merchant never meant to.
    const read = readApproval({
      enabled: true,
      criteria: [{ field: "vat_valid" }, { field: "made_up" }],
    });

    expect(read.criteria).toHaveLength(1);
    expect(read.enabled).toBe(false);
  });

  it("survives nonsense", () => {
    expect(readApproval(null)).toEqual(DEFAULT_APPROVAL);
    expect(readApproval("nope")).toEqual(DEFAULT_APPROVAL);
    expect(readApproval({ criteria: "no" }).criteria).toEqual([]);
  });

  it("defaults to off and to review", () => {
    const read = readApproval({ criteria: [{ field: "vat_valid" }] });
    expect(read.enabled).toBe(false);
    expect(read.otherwise).toBe("review");
  });

  it("refuses a country criterion with no countries", () => {
    const read = readApproval({
      enabled: true,
      criteria: [{ field: "country", op: "not_in", values: [] }],
    });
    // "Not in nothing" matches everybody, so it is dropped — and dropping it
    // switches the whole thing off.
    expect(read.criteria).toEqual([]);
    expect(read.enabled).toBe(false);
  });
});

describe("validating criteria", () => {
  it("flags being switched on with nothing to check", () => {
    expect(validateApproval(criteria([]))[0]?.code).toBe("no_criteria");
  });

  it("flags a negative number of years and an empty country list", () => {
    const issues = validateApproval(
      criteria([
        { field: "years_in_business", atLeast: -1 },
        { field: "country", op: "in", values: [] },
        { field: "answer", key: "  ", equals: "x" },
      ]),
    );
    expect(issues.map((issue) => issue.code)).toEqual([
      "years_negative",
      "no_countries",
      "no_key",
    ]);
  });

  it("is happy with a complete rule", () => {
    expect(validateApproval(criteria([{ field: "vat_valid" }]))).toEqual([]);
  });
});

describe("odds and ends", () => {
  it("knows a rejection reason from anything else", () => {
    expect(isRejectionReason("competitor")).toBe(true);
    expect(isRejectionReason("because")).toBe(false);
    expect(isRejectionReason(null)).toBe(false);
  });

  it("takes the domain from an address", () => {
    expect(domainOf("buyer@Acme.Test")).toBe("acme.test");
    expect(domainOf("buyer+tag@sub.acme.test")).toBe("sub.acme.test");
    expect(domainOf("not-an-address")).toBeNull();
    expect(domainOf("trailing@")).toBeNull();
  });
});
