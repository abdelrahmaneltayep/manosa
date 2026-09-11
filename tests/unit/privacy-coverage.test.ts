import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every table in this app is accounted for, by name, in writing.
 *
 * The promise is in two places: Settings says *"everything it stored about
 * your shop is deleted within 48 hours"*, and Shopify's `customers/redact` is
 * mandatory for every app in the store.
 *
 * The first version of this guard looked for eleven personal-sounding field
 * names and checked only the models that matched. It classified nine of
 * thirty-two as personal, and the buyer's uploaded trade licence was not among
 * them — `FormUpload`'s columns are `fieldKey`, `fileName`, `contentType`,
 * `byteSize`, `content`, and none of those is a word anybody would put on such
 * a list. The guard could be deleted from the purge and every test stayed
 * green. A regex over field names cannot be complete, because the next table's
 * columns have not been named yet.
 *
 * So this is a **total map**: every model in the schema has an entry, and a new
 * one fails the build until somebody writes down what happens to it. That is
 * the only shape of this test that can be trusted, and it is the shape that
 * would have caught `BlockedDomain` — excused in the first version with a
 * sentence about a cascade that does not exist.
 */

const ROOT = process.cwd();
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

const schema = read("prisma/schema.prisma");
const purge = read("app/lib/jobs/handlers/purge-shop-pii.server.ts");
const uninstalled = read("app/lib/webhooks/handlers/app-uninstalled.server.ts");
const redact = read("app/lib/privacy/buyer-data.server.ts");

/** What happens to a table when a shop leaves, and when one buyer asks. */
type Disposition =
  /** Named in the shop purge, and reachable by a single buyer's redaction. */
  | "purged+redacted"
  /** Named in the shop purge. Not a buyer's to ask about on their own. */
  | "purged"
  /** Deleted by a parent the purge names. The FK must say `onDelete: Cascade`. */
  | { cascadesFrom: string }
  /** Handled somewhere else, with the reason and the file that does it. */
  | { elsewhere: string; provedBy: string }
  /** Holds nothing about any person, and says why. */
  | { impersonal: string };

const DISPOSITION: Record<string, Disposition> = {
  // --- People, and what they left behind -----------------------------------
  Customer: "purged+redacted",
  FormSubmission: "purged+redacted",
  FormUpload: "purged+redacted",
  EmailMessage: "purged+redacted",
  Order: "purged+redacted",
  Quote: "purged+redacted",
  AgentConversation: "purged+redacted",

  OrderLine: { cascadesFrom: "Order" },
  Payment: { cascadesFrom: "Order" },
  QuoteLine: { cascadesFrom: "Quote" },
  AgentMessage: { cascadesFrom: "AgentConversation" },
  FormEvent: { cascadesFrom: "RegistrationForm" },

  // --- The merchant's own material, which goes with their shop --------------
  BlockedDomain: "purged",
  MonthlyReview: "purged",
  MerchantBriefing: "purged",
  RuleImportDraft: "purged",
  // Token counts, latencies and a provider request id — deliberately never the
  // prompt or the answer. `actorId` is a staff member, and it goes with the
  // shop like the rest of the merchant's own material.
  AiRun: "purged",
  BrandVoiceSample: "purged",
  StorefrontString: "purged",

  // --- Handled elsewhere, each with the file that does it -------------------
  Session: {
    elsewhere: "deleted the moment the uninstall webhook lands, and again by the purge",
    provedBy: "prismaBase.session.deleteMany",
  },
  Shop: {
    elsewhere:
      "contact fields cleared in place — it is what lets a reinstall restore a setup",
    provedBy: "db.shop.update",
  },
  AuditLog: {
    elsewhere: "redacted in place: what happened stays, every word of who goes",
    provedBy: "db.auditLog.updateMany",
  },

  // --- Nothing about a person ----------------------------------------------
  WebhookDelivery: { impersonal: "a topic, an id and a timestamp from Shopify" },
  ScheduledJob: { impersonal: "a job kind and a run time" },
  PricingRule: { impersonal: "prices and product targets, never a buyer" },
  RuleImport: { impersonal: "counts and a file name" },
  CustomerGroup: { impersonal: "a tier's name and its terms, not its members" },
  CustomerTagRule: { impersonal: "a condition over tags and totals" },
  CustomerSegment: { impersonal: "a saved filter, not the people it matches" },
  RegistrationForm: { impersonal: "the merchant's own form, not an application" },
  OrderLimit: { impersonal: "minimums and maximums per group" },
  AgentGuardrails: { impersonal: "what the agent may say, written by the merchant" },
};

const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(
  ([, name, body]) => ({ name: name!, body: body! }),
);

const call = (model: string) => `db.${model[0]!.toLowerCase()}${model.slice(1)}.`;

describe("every table this app has", () => {
  it("is a table this test knows about", () => {
    // The whole point. A model added later fails here until somebody writes
    // down what happens to it when a shop leaves.
    const unaccounted = models
      .map((model) => model.name)
      .filter((name) => !(name in DISPOSITION));

    expect(unaccounted).toEqual([]);
    expect(models.length).toBeGreaterThan(25);
  });

  it("accounts for nothing that no longer exists", () => {
    const names = new Set(models.map((model) => model.name));
    const stale = Object.keys(DISPOSITION).filter((name) => !names.has(name));
    expect(stale).toEqual([]);
  });
});

describe("the shop purge", () => {
  const named = Object.entries(DISPOSITION).filter(
    ([, how]) => how === "purged" || how === "purged+redacted",
  );

  it("names every table that is not handled another way", () => {
    const missing = named
      .map(([model]) => model)
      .filter((model) => !purge.includes(call(model)));

    expect(missing).toEqual([]);
    expect(named.length).toBeGreaterThan(10);
  });

  it("really does what each excused table claims", () => {
    for (const [model, how] of Object.entries(DISPOSITION)) {
      if (typeof how !== "object" || !("elsewhere" in how)) continue;
      // The excuse names a call; the call has to be in the purge or in the
      // uninstall handler. `BlockedDomain` was excused with a sentence about a
      // cascade that does not exist anywhere in this schema.
      expect(
        purge.includes(how.provedBy) || uninstalled.includes(how.provedBy),
        model,
      ).toBe(true);
    }
  });
});

describe("a single buyer's redaction", () => {
  it("reaches every table a buyer can be traced through", () => {
    const missing = Object.entries(DISPOSITION)
      .filter(([, how]) => how === "purged+redacted")
      .map(([model]) => model)
      .filter((model) => !redact.includes(call(model)));

    expect(missing).toEqual([]);
  });

  it("reaches the audit log, which is a page a merchant reads for a year", () => {
    expect(redact).toContain("db.auditLog.");
  });
});

describe("every cascade this test relies on", () => {
  it("is a real `onDelete: Cascade` in the schema, to a parent that is deleted", () => {
    for (const [model, how] of Object.entries(DISPOSITION)) {
      if (typeof how !== "object" || !("cascadesFrom" in how)) continue;

      const body = models.find((one) => one.name === model)?.body ?? "";
      const relation = new RegExp(
        `${how.cascadesFrom}[?]?\\s+@relation\\([^)]*onDelete:\\s*Cascade`,
      );
      expect(relation.test(body), `${model} → ${how.cascadesFrom}`).toBe(true);

      // And the parent is itself deleted, not merely redacted: a cascade from
      // a row that is only updated deletes nothing.
      const parent = DISPOSITION[how.cascadesFrom];
      const parentDeleted =
        parent === "purged" ||
        parent === "purged+redacted" ||
        (typeof parent === "object" && "impersonal" in parent);
      expect(parentDeleted, `${how.cascadesFrom} is not deleted by the purge`).toBe(true);
      if (typeof parent !== "object") {
        expect(purge).toContain(`${call(how.cascadesFrom)}deleteMany`);
      }
    }
  });
});
