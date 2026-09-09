import { describe, expect, it } from "vitest";

import {
  clampWidth,
  isSafeRedirect,
  MAX_WIDTH,
  MIN_WIDTH,
  readAppearance,
  readPublish,
} from "~/lib/forms/appearance";
import { checkContrast, contrastRatio, parseHex } from "~/lib/forms/contrast";
import {
  renderTemplate,
  tagsIn,
  unknownTags,
  validateEmails,
  readEmails,
  type EmailTemplates,
} from "~/lib/forms/merge-tags";
import {
  emailFrom,
  readDefinition,
  validateDefinition,
  validateSubmission,
  visibleFields,
  type FormDefinition,
  type FormField,
} from "~/lib/forms/schema";
import {
  MIN_FILL_MS,
  RATE_LIMIT,
  readRenderedAt,
  spamVerdict,
  clientIp,
} from "~/lib/forms/spam";
import {
  looksLikeVat,
  parseVat,
  vatExampleFor,
  viesCovers,
} from "~/lib/forms/vat-formats";

const field = (
  overrides: Partial<FormField> & Pick<FormField, "key" | "kind">,
): FormField => ({
  label: overrides.key,
  required: false,
  showWhen: null,
  ...overrides,
});

const definition = (fields: FormField[]): FormDefinition => ({ v: 1, fields });

const base = () =>
  definition([
    field({ key: "email", kind: "email", required: true }),
    field({ key: "company", kind: "company", required: true }),
  ]);

/* -------------------------------------------------------------------------- */

describe("validating a form definition", () => {
  it("accepts a workable form", () => {
    expect(validateDefinition(base())).toEqual([]);
  });

  it("insists on an email field", () => {
    // Without one an application cannot be answered, de-duplicated, or turned
    // into a customer.
    const issues = validateDefinition(
      definition([field({ key: "company", kind: "company" })]),
    );
    expect(issues.map((issue) => issue.code)).toContain("no_email_field");
  });

  it("catches duplicate, reserved and unusable keys", () => {
    const issues = validateDefinition(
      definition([
        field({ key: "email", kind: "email" }),
        field({ key: "email", kind: "text" }),
        field({ key: "website", kind: "text" }),
        field({ key: "Not A Key", kind: "text" }),
      ]),
    );
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain("duplicate_key");
    // "website" is the honeypot; a real field with that name would be dropped
    // as spam on every submission.
    expect(codes).toContain("reserved_key");
    expect(codes).toContain("invalid_key");
  });

  it("catches a choice field with nothing to choose", () => {
    const issues = validateDefinition(
      definition([
        field({ key: "email", kind: "email" }),
        field({ key: "type", kind: "select", options: [] }),
      ]),
    );
    expect(issues.map((issue) => issue.code)).toContain("select_without_options");
  });

  it("refuses a field that depends on itself", () => {
    const issues = validateDefinition(
      definition([
        field({ key: "email", kind: "email" }),
        field({ key: "a", kind: "text", showWhen: { field: "a", equals: "x" } }),
      ]),
    );
    expect(issues.map((issue) => issue.code)).toContain("condition_self");
  });

  it("refuses a field that depends on one that is not there", () => {
    const issues = validateDefinition(
      definition([
        field({ key: "email", kind: "email" }),
        field({ key: "a", kind: "text", showWhen: { field: "ghost", equals: "x" } }),
      ]),
    );
    expect(issues.map((issue) => issue.code)).toContain("condition_unknown_field");
  });

  it("catches a two-field condition loop", () => {
    // Very easy to build one field at a time, and the result is a form where
    // neither field can ever appear.
    const issues = validateDefinition(
      definition([
        field({ key: "email", kind: "email" }),
        field({ key: "a", kind: "text", showWhen: { field: "b", equals: "yes" } }),
        field({ key: "b", kind: "text", showWhen: { field: "a", equals: "yes" } }),
      ]),
    );
    expect(issues.filter((issue) => issue.code === "condition_cycle")).not.toHaveLength(
      0,
    );
  });

  it("catches a longer loop", () => {
    const issues = validateDefinition(
      definition([
        field({ key: "email", kind: "email" }),
        field({ key: "a", kind: "text", showWhen: { field: "b", equals: "y" } }),
        field({ key: "b", kind: "text", showWhen: { field: "c", equals: "y" } }),
        field({ key: "c", kind: "text", showWhen: { field: "a", equals: "y" } }),
      ]),
    );
    expect(issues.some((issue) => issue.code === "condition_cycle")).toBe(true);
  });

  it("allows a chain that does not loop", () => {
    expect(
      validateDefinition(
        definition([
          field({ key: "email", kind: "email" }),
          field({ key: "country", kind: "select", options: ["KSA", "UAE"] }),
          field({
            key: "licence",
            kind: "file",
            showWhen: { field: "country", equals: "KSA" },
          }),
        ]),
      ),
    ).toEqual([]);
  });
});

describe("which fields a buyer sees", () => {
  const conditional = definition([
    field({ key: "email", kind: "email", required: true }),
    field({ key: "country", kind: "select", options: ["KSA", "UAE"] }),
    field({
      key: "licence",
      kind: "file",
      required: true,
      showWhen: { field: "country", equals: "KSA" },
    }),
  ]);

  it("hides a field whose condition does not hold", () => {
    expect(
      visibleFields(conditional, { country: "UAE" }).map((entry) => entry.key),
    ).toEqual(["email", "country"]);
  });

  it("shows it when the condition holds, ignoring case and spacing", () => {
    expect(
      visibleFields(conditional, { country: " ksa " }).map((entry) => entry.key),
    ).toContain("licence");
  });

  it("hides a field whose parent is itself hidden", () => {
    const nested = definition([
      field({ key: "email", kind: "email" }),
      field({ key: "a", kind: "text" }),
      field({ key: "b", kind: "text", showWhen: { field: "a", equals: "yes" } }),
      field({ key: "c", kind: "text", showWhen: { field: "b", equals: "yes" } }),
    ]);
    // b is hidden, so c cannot be reached even though c's own answer matches.
    expect(visibleFields(nested, { b: "yes", c: "yes" }).map((e) => e.key)).toEqual([
      "email",
      "a",
    ]);
  });

  it("does not require a field its own condition excludes", () => {
    // This is what makes the no-JavaScript path work rather than merely
    // render: every field is on the page, and the server only asks for the
    // ones that apply.
    expect(validateSubmission(conditional, { email: "a@b.co", country: "UAE" })).toEqual(
      [],
    );
    expect(
      validateSubmission(conditional, { email: "a@b.co", country: "KSA" }).map(
        (i) => i.key,
      ),
    ).toEqual([]);
  });
});

describe("validating a submission", () => {
  it("asks for what is required and nothing else", () => {
    const issues = validateSubmission(base(), {});
    expect(issues.map((issue) => issue.key).sort()).toEqual(["company", "email"]);
  });

  it("checks email shape without being clever about it", () => {
    const check = (value: string) =>
      validateSubmission(base(), { email: value, company: "Acme" }).length;

    expect(check("buyer@acme.test")).toBe(0);
    expect(check("buyer+tag@sub.acme.co.uk")).toBe(0);
    expect(check("buyer@acme")).toBe(1);
    expect(check("not an email")).toBe(1);
  });

  it("accepts international phone shapes", () => {
    const phone = definition([
      field({ key: "email", kind: "email" }),
      field({ key: "phone", kind: "phone" }),
    ]);
    const check = (value: string) => validateSubmission(phone, { phone: value }).length;

    expect(check("+966 50 000 0000")).toBe(0);
    // A bracketed area code is how a large part of the world writes a number.
    expect(check("(020) 7946-0958")).toBe(0);
    expect(check("hello")).toBe(1);
    // Matching the shape is not enough: this has no digits in it.
    expect(check("(((((((")).toBe(1);
  });

  it("wants a whole, non-negative number of years", () => {
    const years = definition([
      field({ key: "email", kind: "email" }),
      field({ key: "years", kind: "years_in_business" }),
    ]);

    expect(validateSubmission(years, { years: "0" })).toEqual([]);
    expect(validateSubmission(years, { years: "-1" })).toHaveLength(1);
    expect(validateSubmission(years, { years: "2.5" })).toHaveLength(1);
  });

  it("only accepts an option that is actually offered", () => {
    const select = definition([
      field({ key: "email", kind: "email" }),
      field({ key: "type", kind: "select", options: ["Retailer", "Distributor"] }),
    ]);

    expect(validateSubmission(select, { type: "retailer" })).toEqual([]);
    expect(validateSubmission(select, { type: "Wholesaler" })).toHaveLength(1);
  });

  it("requires the privacy box to actually be ticked", () => {
    const privacy = definition([
      field({ key: "email", kind: "email" }),
      field({ key: "privacy", kind: "privacy", required: true }),
    ]);

    expect(validateSubmission(privacy, { privacy: "yes" })).toEqual([]);
    expect(validateSubmission(privacy, {})[0]?.code).toBe("privacy_required");
    // A browser sends nothing for an unticked box, but a hand-made post can
    // send "false", which must not read as consent.
    expect(validateSubmission(privacy, { privacy: "false" })[0]?.code).toBe(
      "privacy_required",
    );
  });

  it("bounds a free-text answer", () => {
    const issues = validateSubmission(base(), {
      email: "a@b.co",
      company: "x".repeat(5000),
    });
    expect(issues[0]?.code).toBe("too_long");
  });

  it("pulls the application's email out of the answers, lowercased", () => {
    expect(emailFrom(base(), { email: " Buyer@Acme.Test " })).toBe("buyer@acme.test");
    expect(emailFrom(base(), {})).toBeNull();
  });
});

describe("reading a stored definition", () => {
  it("survives nonsense without throwing", () => {
    expect(readDefinition(null).fields).toEqual([]);
    expect(readDefinition("nope").fields).toEqual([]);
    expect(readDefinition({ fields: "no" }).fields).toEqual([]);
  });

  it("drops a field of a kind it does not know", () => {
    const read = readDefinition({
      v: 1,
      fields: [
        { key: "email", kind: "email", label: "Email", required: true },
        { key: "mystery", kind: "hologram", label: "?" },
      ],
    });
    expect(read.fields.map((entry) => entry.key)).toEqual(["email"]);
  });
});

/* -------------------------------------------------------------------------- */

describe("merge tags", () => {
  it("finds the tags a template uses", () => {
    expect(tagsIn("Hi {{first_name}}, from {{ shop_name }}")).toEqual([
      "first_name",
      "shop_name",
    ]);
  });

  it("flags a tag that will never fill in", () => {
    // "Hi {{firstname}}," goes out to a real buyer as written.
    expect(unknownTags("Hi {{firstname}}")).toEqual(["firstname"]);
    expect(unknownTags("Hi {{first_name}}")).toEqual([]);
  });

  it("renders a missing value as nothing, not as braces", () => {
    expect(renderTemplate("Hi {{first_name}},", {})).toBe("Hi ,");
    expect(renderTemplate("Hi {{first_name}},", { first_name: "Sam" })).toBe("Hi Sam,");
  });

  it("checks every email template", () => {
    const templates: EmailTemplates = {
      confirmation: { subject: "Got it", body: "Hi {{first_name}}" },
      approved: { subject: "", body: "Welcome" },
      rejected: { subject: "No", body: "" },
      needs_info: { subject: "More", body: "Hi {{firstname}}" },
    };
    const codes = validateEmails(templates).map(
      (issue) => `${issue.email}:${issue.code}`,
    );

    expect(codes).toContain("approved:no_subject");
    expect(codes).toContain("rejected:no_body");
    expect(codes).toContain("needs_info:unknown_tag");
  });

  it("reads a malformed stored value as empty templates", () => {
    const read = readEmails({ confirmation: { subject: 42 } });
    expect(read.confirmation).toEqual({ subject: "", body: "" });
    expect(read.needs_info).toEqual({ subject: "", body: "" });
  });
});

/* -------------------------------------------------------------------------- */

describe("contrast", () => {
  it("reads both hex shapes", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("1c1d2b")).toEqual({ r: 28, g: 29, b: 43 });
    expect(parseHex("chartreuse")).toBeNull();
  });

  it("computes the known extremes", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("fails the grey the checklist calls out", () => {
    // "this grey fails on white — fix" is the actual copy in the spec.
    const verdict = checkContrast("#999999", "#ffffff");
    expect(verdict.passesAA).toBe(false);
    expect(verdict.ratio).toBeLessThan(4.5);
  });

  it("passes a dark text on white", () => {
    expect(checkContrast("#1c1d2b", "#ffffff").passesAA).toBe(true);
  });

  it("allows a lower ratio for large text", () => {
    const colours = ["#767676", "#ffffff"] as const;
    expect(checkContrast(colours[0], colours[1], false).passesAA).toBe(true);
    expect(checkContrast("#949494", "#ffffff", false).passesAA).toBe(false);
    expect(checkContrast("#949494", "#ffffff", true).passesAA).toBe(true);
  });

  it("says so rather than guessing when a colour is unreadable", () => {
    expect(checkContrast("nope", "#fff").unreadable).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe("appearance", () => {
  it("clamps the width rather than trusting it", () => {
    expect(clampWidth(4)).toBe(MIN_WIDTH);
    expect(clampWidth(99999)).toBe(MAX_WIDTH);
    expect(clampWidth("700")).toBe(700);
    expect(clampWidth("wide")).toBe(640);
  });

  it("falls back to the defaults on an unreadable stored value", () => {
    const read = readAppearance({ layout: "diagonal", width: -5, background: "red" });
    expect(read.layout).toBe("default");
    expect(read.width).toBe(MIN_WIDTH);
    expect(read.background).toBe("#ffffff");
  });

  it("refuses a redirect that is not a plain web link", () => {
    expect(isSafeRedirect("")).toBe(true);
    expect(isSafeRedirect("https://acme.test/thanks")).toBe(true);
    expect(isSafeRedirect("javascript:alert(1)")).toBe(false);
    // Credentials in a redirect are a phishing link the merchant published
    // without knowing it.
    expect(isSafeRedirect("https://user:pass@evil.test")).toBe(false);
    expect(isSafeRedirect("not a url")).toBe(false);
  });

  it("leaves spam protection on unless it is explicitly turned off", () => {
    expect(readPublish({}).spamProtection).toBe(true);
    expect(readPublish({ spamProtection: false }).spamProtection).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("VAT numbers", () => {
  it("normalises spacing and case", () => {
    expect(parseVat(" de 123 456 789 ").normalized).toBe("DE123456789");
    expect(parseVat("de123456789").country).toBe("DE");
  });

  it("checks the shape for a country it knows", () => {
    expect(looksLikeVat("DE123456789")).toBe(true);
    expect(looksLikeVat("DE12345")).toBe(false);
    expect(looksLikeVat("SA300000000000003")).toBe(true);
  });

  it("accepts a number from a country it does not know", () => {
    // Our table is not the whole world, and refusing an applicant because
    // their country is missing from it would be our bug charged to them.
    expect(looksLikeVat("ZZ998877665")).toBe(true);
  });

  it("knows which countries VIES can answer for", () => {
    expect(viesCovers("DE123456789")).toBe(true);
    // A Saudi TRN is real; asking VIES would turn it into an invalid number.
    expect(viesCovers("SA300000000000003")).toBe(false);
    expect(viesCovers("ZZ12345")).toBe(false);
  });

  it("gives the example for the store's country", () => {
    expect(vatExampleFor("sa")).toBe("SA300000000000003");
    expect(vatExampleFor("ZZ")).toBeNull();
    expect(vatExampleFor(null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("spam signals", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("lets a person through", () => {
    expect(
      spamVerdict({ honeypot: "", renderedAt: ago(20_000), now, recentFromIp: 1 }),
    ).toEqual({ spam: false, reason: null });
  });

  it("catches a filled-in honeypot", () => {
    expect(
      spamVerdict({
        honeypot: "http://spam",
        renderedAt: ago(20_000),
        now,
        recentFromIp: 0,
      }).reason,
    ).toBe("honeypot");
  });

  it("catches a form filled in faster than a person can", () => {
    expect(
      spamVerdict({
        honeypot: "",
        renderedAt: ago(MIN_FILL_MS - 1),
        now,
        recentFromIp: 0,
      }).reason,
    ).toBe("too_fast");
  });

  it("treats a timestamp from the future as too fast, not as trusted", () => {
    expect(
      spamVerdict({
        honeypot: "",
        renderedAt: new Date(now.getTime() + 60_000),
        now,
        recentFromIp: 0,
      }).reason,
    ).toBe("too_fast");
  });

  it("does not judge a submission with no timestamp on its speed", () => {
    expect(
      spamVerdict({ honeypot: "", renderedAt: null, now, recentFromIp: 0 }).spam,
    ).toBe(false);
  });

  it("rate limits one address", () => {
    expect(
      spamVerdict({
        honeypot: "",
        renderedAt: ago(20_000),
        now,
        recentFromIp: RATE_LIMIT,
      }).reason,
    ).toBe("rate_limit");
  });

  it("reads a render timestamp defensively", () => {
    expect(readRenderedAt(null)).toBeNull();
    expect(readRenderedAt("nonsense")).toBeNull();
    expect(readRenderedAt("0")).toBeNull();
    expect(readRenderedAt(String(now.getTime()))?.getTime()).toBe(now.getTime());
  });

  it("takes the client from the first forwarded address", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
    expect(clientIp(headers)).toBe("203.0.113.5");
    expect(clientIp(new Headers())).toBeNull();
  });
});
