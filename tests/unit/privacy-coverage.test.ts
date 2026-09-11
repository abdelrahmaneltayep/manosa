import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every table holding a person's data is named somewhere that deletes it.
 *
 * The promise is in two places: Settings says *"everything it stored about
 * your shop is deleted within 48 hours"*, and Shopify's `customers/redact` is
 * mandatory for every app in the store. Both were kept by a hand-written list
 * of tables — and at 6.6 that list had two entries while the schema had
 * thirty-two, so a buyer's name, address, phone number, VAT number, the
 * answers they typed into a form and the files they uploaded all survived an
 * uninstall indefinitely.
 *
 * A list is a registration step. This reads the schema and fails the build when
 * a model carrying personal data is not named in the purge, which is the only
 * version of this that stays true.
 */

const ROOT = process.cwd();
const schema = readFileSync(resolve(ROOT, "prisma/schema.prisma"), "utf8");
const purge = readFileSync(
  resolve(ROOT, "app/lib/jobs/handlers/purge-shop-pii.server.ts"),
  "utf8",
);
const redact = readFileSync(
  resolve(ROOT, "app/lib/privacy/buyer-data.server.ts"),
  "utf8",
);

/** Field names that make a row personal data rather than a number. */
const PERSONAL = [
  "email",
  "firstName",
  "lastName",
  "phone",
  "company",
  "address1",
  "address2",
  "vatNumber",
  "ip",
  "answers",
  "to",
];

const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(
  ([, name, body]) => ({ name: name!, body: body! }),
);

/** A field line, not a comment and not a relation. */
const carriesPersonalData = (body: string) =>
  body
    .split("\n")
    .filter((line) => !line.trim().startsWith("///") && !line.trim().startsWith("//"))
    .some((line) =>
      PERSONAL.some((field) => new RegExp(`^\\s*${field}\\s+\\S`).test(line)),
    );

/**
 * Models whose personal data is somebody else's to delete, with the reason.
 *
 * Each one is a decision, not an oversight — which is why they are written
 * down here rather than left out of the regex.
 */
const ELSEWHERE: Record<string, string> = {
  // Deleted by `app/uninstalled` the moment it lands, before this job runs,
  // and re-checked by the purge with a raw DELETE.
  Session: "deleted by the uninstall webhook",
  // The merchant's own row. Cleared in place rather than deleted: it is what
  // lets a reinstall restore their setup, and it holds nothing once the
  // contact fields are null.
  Shop: "contact fields cleared in place",
  // Redacted rather than deleted: who did what is removed, that it happened
  // stays, because an audit trail with holes in it is not one.
  AuditLog: "redacted in place",
  // Cascades from AgentConversation, which the purge names.
  AgentMessage: "cascades from AgentConversation",
  // Cascades from Order, which the purge names.
  OrderLine: "cascades from Order",
  Payment: "cascades from Order",
  QuoteLine: "cascades from Quote",
  // An email domain the merchant chose to block. Not a person: it is the
  // merchant's own decision, and it is deleted with the shop's rows anyway
  // when they uninstall — see the shop-scoped cascade in the schema.
  BlockedDomain: "a merchant's own setting, not a person",
};

describe("the tables holding a person's data", () => {
  const personal = models.filter((model) => carriesPersonalData(model.body));

  it("finds some, rather than quietly matching nothing", () => {
    // A regex that stops matching is a guard that stops guarding.
    expect(personal.length).toBeGreaterThan(5);
    expect(personal.map((model) => model.name)).toContain("Customer");
    expect(personal.map((model) => model.name)).toContain("FormSubmission");
  });

  it("are each named by the shop purge, or excused in writing", () => {
    const missing = personal
      .filter((model) => !(model.name in ELSEWHERE))
      .filter((model) => {
        const call = `db.${model.name[0]!.toLowerCase()}${model.name.slice(1)}.`;
        return !purge.includes(call);
      })
      .map((model) => model.name);

    expect(missing).toEqual([]);
  });

  it("are each reachable by a single buyer's deletion, or excused in writing", () => {
    // `customers/redact` is about one person, so a table keyed only to the
    // shop is not part of it — but every table that can be traced to a buyer
    // has to be.
    const perBuyer = personal.filter(
      (model) =>
        !(model.name in ELSEWHERE) &&
        /^\s*(customerId|email|submissionId)\s+\S/m.test(model.body),
    );

    const missing = perBuyer
      .filter((model) => {
        const call = `db.${model.name[0]!.toLowerCase()}${model.name.slice(1)}.`;
        return !redact.includes(call);
      })
      .map((model) => model.name);

    expect(missing).toEqual([]);
  });

  it("excuses nothing that does not exist", () => {
    // An excuse for a table that was renamed or dropped is an excuse that has
    // stopped meaning anything.
    const names = new Set(models.map((model) => model.name));
    for (const excused of Object.keys(ELSEWHERE)) {
      expect(names, excused).toContain(excused);
    }
  });
});
