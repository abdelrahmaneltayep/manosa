import { describe, expect, it } from "vitest";

import {
  MAX_REASONS,
  readScreening,
  screeningUser,
  SCREENING_SIGNALS,
  type ScreeningFacts,
} from "~/lib/ai/prompts/screening.server";
import {
  domainsMatch,
  FREE_EMAIL_DOMAINS,
  readReasons,
  websiteDomainIn,
} from "~/lib/forms/screening.server";

/**
 * ✦ Screening: what leaves, and what is believed on the way back.
 *
 * The prompt is about a real business run by a real person. Two properties are
 * asserted here above all others: nothing personal goes into it, and nothing
 * outside a closed vocabulary comes out of it.
 */

const facts: ScreeningFacts = {
  company: "Acme Trading Ltd",
  emailDomain: "acme-trading.test",
  emailDomainIsFree: false,
  websiteDomain: "acme-trading.test",
  websiteMatchesEmail: true,
  vatStatus: "VALID",
  countryCode: "GB",
  yearsInBusiness: 12,
  documentCount: 2,
  documentsScanned: true,
  existingCustomer: false,
  otherPendingFromDomain: 0,
  criteriaMet: true,
  storeCountry: "GB",
};

describe("what the prompt carries", () => {
  it("names the business, and nobody in it", () => {
    const prompt = screeningUser(facts);

    expect(prompt).toContain("Acme Trading Ltd");
    expect(prompt).toContain("acme-trading.test");
    // The applicant's name, address, phone and answers are never assembled into
    // a ScreeningFacts at all — this is the shape that keeps that promise.
    expect(Object.keys(facts)).not.toContain("email");
    expect(Object.keys(facts)).not.toContain("answers");
    expect(Object.keys(facts)).not.toContain("contact");
    expect(Object.keys(facts)).not.toContain("phone");
  });

  it("says 'not known' rather than leaving a fact out", () => {
    const prompt = screeningUser({ ...facts, yearsInBusiness: null, company: null });
    // A missing line reads to a model as a fact it can invent. A stated
    // "not known" is a fact about what the merchant does not have.
    expect(prompt).toContain("Years in business: not known");
    expect(prompt).toContain("Company name: not known");
  });
});

describe("readScreening", () => {
  const answer = (overrides: Record<string, unknown> = {}) => ({
    decision: "recommend",
    reasons: [{ signal: "vat_valid", detail: null }],
    ...overrides,
  });

  const read = (value: unknown) => readScreening(value);

  it("reads a good answer", () => {
    const result = read(answer());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe("recommend");
    expect(result.value.reasons).toEqual([{ signal: "vat_valid", detail: null }]);
  });

  it("keeps the number a reason is about", () => {
    const result = read(
      answer({ reasons: [{ signal: "years_established", detail: 12 }] }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.reasons[0]?.detail).toBe(12);
  });

  it("refuses a verdict it does not know", () => {
    expect(read(answer({ decision: "reject" })).ok).toBe(false);
    expect(read(answer({ decision: "maybe" })).ok).toBe(false);
  });

  it("refuses a signal that is not in the vocabulary", () => {
    // The whole point: a reason the merchant reads is one of ours, translated
    // from a code — never a sentence a model wrote about a real business.
    const result = read(answer({ reasons: [{ signal: "looks_dodgy", detail: null }] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("looks_dodgy");
  });

  it("refuses an answer with no reasons at all", () => {
    expect(read(answer({ reasons: [] })).ok).toBe(false);
  });

  it("refuses an answer that is not an object", () => {
    expect(read("recommend").ok).toBe(false);
    expect(read(null).ok).toBe(false);
    expect(read([{ signal: "vat_valid" }]).ok).toBe(false);
  });

  it("drops a repeated signal rather than counting it twice", () => {
    const result = read(
      answer({
        reasons: [
          { signal: "vat_valid", detail: null },
          { signal: "vat_valid", detail: null },
        ],
      }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.reasons).toHaveLength(1);
  });

  it("trims to three reasons rather than refusing a thorough answer", () => {
    const result = read(
      answer({
        reasons: SCREENING_SIGNALS.slice(0, 6).map((signal) => ({
          signal,
          detail: null,
        })),
      }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.reasons).toHaveLength(MAX_REASONS);
  });

  it("treats a detail that is not a number as no detail", () => {
    const result = read(
      answer({ reasons: [{ signal: "years_established", detail: "twelve" }] }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.reasons[0]?.detail).toBeNull();
  });
});

describe("the website check", () => {
  it("finds a domain in whatever the applicant typed", () => {
    expect(websiteDomainIn({ site: "https://www.acme-trading.test/about" })).toBe(
      "acme-trading.test",
    );
    expect(websiteDomainIn({ site: "acme-trading.test" })).toBe("acme-trading.test");
  });

  it("does not mistake an email address for a website", () => {
    expect(websiteDomainIn({ email: "buyer@acme-trading.test" })).toBeNull();
  });

  it("ignores prose", () => {
    expect(websiteDomainIn({ note: "we have been trading since 2011" })).toBeNull();
    expect(websiteDomainIn({ note: "" })).toBeNull();
  });

  it("matches a subdomain to its parent", () => {
    expect(domainsMatch("shop.acme.test", "acme.test")).toBe(true);
    expect(domainsMatch("acme.test", "shop.acme.test")).toBe(true);
    expect(domainsMatch("acme.test", "acme.test")).toBe(true);
  });

  it("does not match two different businesses", () => {
    expect(domainsMatch("acme.test", "acmetrading.test")).toBe(false);
    expect(domainsMatch("notacme.test", "acme.test")).toBe(false);
  });

  it("knows the free providers, and does not pretend to know them all", () => {
    expect(FREE_EMAIL_DOMAINS.has("gmail.com")).toBe(true);
    expect(FREE_EMAIL_DOMAINS.has("acme-trading.test")).toBe(false);
  });
});

describe("reading stored reasons", () => {
  it("reads what was written", () => {
    expect(readReasons([{ signal: "vat_valid", detail: null }])).toEqual([
      { signal: "vat_valid", detail: null },
    ]);
  });

  it("survives a column holding something else entirely", () => {
    expect(readReasons(null)).toEqual([]);
    expect(readReasons("vat_valid")).toEqual([]);
    expect(readReasons([1, "two", null])).toEqual([]);
  });
});
