import { describe, expect, it } from "vitest";

import {
  emailDraftUser,
  MAX_BODY,
  MAX_SUBJECT,
  readEmailDraft,
  type EmailDraftFacts,
} from "~/lib/ai/prompts/email-draft.server";

/**
 * ✦ Drafting an email to a real person, under the merchant's name.
 *
 * Two things this must never do: put a made-up merge tag in a message a buyer
 * will read as literal braces, and learn who the buyer is. The draft addresses
 * {{first_name}}; the send path fills it in.
 */

const facts: EmailDraftFacts = {
  intent: "reject",
  template: { subject: "About your application", body: "Hi {{first_name}}, ..." },
  shopName: "acme.myshopify.com",
  formName: "Trade account",
  groupName: null,
  reason: null,
  note: null,
  locale: "en",
};

describe("what the prompt carries", () => {
  it("carries the merchant's own template as the voice to match", () => {
    const prompt = emailDraftUser(facts);
    expect(prompt).toContain("About your application");
    expect(prompt).toContain("the voice to match");
  });

  it("does not carry the applicant", () => {
    const prompt = emailDraftUser(facts);
    // There is nowhere in EmailDraftFacts to put them, which is the point.
    expect(Object.keys(facts)).not.toContain("email");
    expect(Object.keys(facts)).not.toContain("applicant");
    expect(prompt).not.toContain("@");
  });

  it("names the tier on an approval, because the buyer will ask", () => {
    const prompt = emailDraftUser({
      ...facts,
      intent: "approve",
      groupName: "Gold",
    });
    expect(prompt).toContain("Tier they are joining: Gold");
  });

  it("leaves out a line the merchant did not fill in", () => {
    expect(emailDraftUser(facts)).not.toContain("Reason the merchant chose");
  });
});

describe("readEmailDraft", () => {
  const draft = (overrides: Record<string, unknown> = {}) => ({
    subject: "About your trade account",
    body: "Hi {{first_name}}, thanks for applying. {{reason}}",
    ...overrides,
  });

  it("reads a good draft", () => {
    const result = readEmailDraft(draft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subject).toBe("About your trade account");
  });

  it("refuses a merge tag this app cannot fill", () => {
    // "{{discount_code}}" reaches a real inbox as literal braces.
    const result = readEmailDraft(draft({ body: "Hi {{customer_name}}, ..." }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("customer_name");
  });

  it("refuses an invented tag in the subject too", () => {
    expect(readEmailDraft(draft({ subject: "Hello {{company_name}}" })).ok).toBe(false);
  });

  it("refuses an empty subject or body", () => {
    expect(readEmailDraft(draft({ subject: "  " })).ok).toBe(false);
    expect(readEmailDraft(draft({ body: "" })).ok).toBe(false);
  });

  it("refuses a draft that will not fit in a send box", () => {
    expect(readEmailDraft(draft({ subject: "x".repeat(MAX_SUBJECT + 1) })).ok).toBe(
      false,
    );
    expect(readEmailDraft(draft({ body: "x".repeat(MAX_BODY + 1) })).ok).toBe(false);
  });

  it("refuses an answer that is not an object", () => {
    expect(readEmailDraft("Dear applicant").ok).toBe(false);
    expect(readEmailDraft(null).ok).toBe(false);
  });

  it("trims the whitespace a model leaves around a body", () => {
    const result = readEmailDraft(draft({ body: "\n\nHi {{first_name}}.\n\n" }));
    if (!result.ok) throw new Error(result.error);
    expect(result.value.body).toBe("Hi {{first_name}}.");
  });
});
