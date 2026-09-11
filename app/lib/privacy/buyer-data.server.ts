import { db } from "~/db.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Everything this app holds about one buyer, and the one place that knows it.
 *
 * Shopify's three mandatory privacy topics all need the same answer to the
 * same question — *what do you have on this person?* — and answering it in
 * three places is how the third one silently stops matching the first.
 * `tests/unit/privacy-coverage.test.ts` checks this against the schema itself,
 * so a table added later fails the build rather than quietly outliving a
 * deletion request.
 *
 * A buyer is identified two ways and both matter. Shopify sends a customer id
 * for somebody who has an account; an application from the registration form
 * may have no account at all and is only ever findable by the address they
 * typed. Addresses are matched case-insensitively — somebody who applied as
 * `Dana@acme.test` and ordered as `dana@acme.test` is one person, and a
 * deletion that reached half their rows is not a deletion.
 */

export interface BuyerIdentity {
  /** Shopify's customer GID, when they have an account. */
  customerId?: string | null;
  /** What they typed on a form, or what an order carries. */
  email?: string | null;
}

export interface BuyerData {
  customers: unknown[];
  applications: unknown[];
  uploads: unknown[];
  emails: unknown[];
  orders: unknown[];
  quotes: unknown[];
  conversations: unknown[];
}

const EMPTY: BuyerData = {
  customers: [],
  applications: [],
  uploads: [],
  emails: [],
  orders: [],
  quotes: [],
  conversations: [],
};

/** The identifiers we were actually given, as `OR` clauses. */
function clausesFor(identity: BuyerIdentity): {
  both: Record<string, unknown>[];
  byCustomer: Record<string, unknown>[];
  email: string | null;
} {
  const email = identity.email?.trim() || null;
  const byCustomer = identity.customerId ? [{ customerId: identity.customerId }] : [];
  const byEmail = email
    ? [{ email: { equals: email, mode: "insensitive" as const } }]
    : [];

  return { both: [...byCustomer, ...byEmail], byCustomer, email };
}

/**
 * Read everything, for `customers/data_request`.
 *
 * Shopify asks the app; the merchant hands the answer to the person, because
 * the merchant is the controller and the one who has met this buyer. So this
 * returns rows rather than mailing anybody.
 */
export async function buyerData(identity: BuyerIdentity): Promise<BuyerData> {
  shopScope.require("buyerData");
  const { both, byCustomer, email } = clausesFor(identity);
  if (both.length === 0) return EMPTY;

  const [customers, applications] = await Promise.all([
    db.customer.findMany({ where: { OR: both } }),
    db.formSubmission.findMany({ where: { OR: both } }),
  ]);
  const submissionIds = applications.map((row) => row.id);

  const emailWhere: Record<string, unknown>[] = [
    ...(email ? [{ to: { equals: email, mode: "insensitive" as const } }] : []),
    ...(submissionIds.length > 0 ? [{ submissionId: { in: submissionIds } }] : []),
  ];

  const [uploads, emails, orders, quotes, conversations] = await Promise.all([
    submissionIds.length > 0
      ? db.formUpload.findMany({ where: { submissionId: { in: submissionIds } } })
      : Promise.resolve([]),
    emailWhere.length > 0
      ? db.emailMessage.findMany({ where: { OR: emailWhere } })
      : Promise.resolve([]),
    db.order.findMany({
      where: { OR: both },
      include: { lines: true, payments: true },
    }),
    db.quote.findMany({ where: { OR: both }, include: { lines: true } }),
    byCustomer.length > 0
      ? db.agentConversation.findMany({
          where: { OR: byCustomer },
          include: { messages: true },
        })
      : Promise.resolve([]),
  ]);

  return { customers, applications, uploads, emails, orders, quotes, conversations };
}

export interface RedactionCounts {
  /** Audit entries that named this person, redacted in place. */
  audit: number;
  /** Stored AI answers that named them — a monthly review, a briefing. */
  stored: number;
  customers: number;
  applications: number;
  uploads: number;
  emails: number;
  orders: number;
  quotes: number;
  conversations: number;
}

/**
 * Remove one buyer, for `customers/redact`.
 *
 * Deleted where the row exists only because of them — their application, the
 * files they uploaded, the mail sent to them, their conversations with the
 * agent. **Redacted, not deleted, where the row is the merchant's own business
 * record**: an order is an accounting document a merchant is required to keep,
 * so what goes is the name, the address and the email on it, and what stays is
 * that an order of that value happened on that day.
 *
 * Deleting orders outright would be the more thorough-looking answer and the
 * wrong one: it would tear a hole in the merchant's revenue figures to satisfy
 * a request the law does not make.
 */
export async function redactBuyer(identity: BuyerIdentity): Promise<RedactionCounts> {
  shopScope.require("redactBuyer");
  const { both, byCustomer, email } = clausesFor(identity);
  if (both.length === 0) {
    return {
      audit: 0,
      stored: 0,
      customers: 0,
      applications: 0,
      uploads: 0,
      emails: 0,
      orders: 0,
      quotes: 0,
      conversations: 0,
    };
  }

  const [applications, customerRows] = await Promise.all([
    db.formSubmission.findMany({ where: { OR: both }, select: { id: true } }),
    db.customer.findMany({ where: { OR: both }, select: { id: true } }),
  ]);
  const submissionIds = applications.map((row) => row.id);
  const customerRowIds = customerRows.map((row) => row.id);

  const emailWhere: Record<string, unknown>[] = [
    ...(email ? [{ to: { equals: email, mode: "insensitive" as const } }] : []),
    ...(submissionIds.length > 0 ? [{ submissionId: { in: submissionIds } }] : []),
  ];

  // Uploads first: they are the buyer's own documents, and a file left behind
  // by a failed cascade is the one piece of this that is not recoverable by
  // apology.
  const uploads =
    submissionIds.length > 0
      ? await db.formUpload.deleteMany({ where: { submissionId: { in: submissionIds } } })
      : { count: 0 };

  const emails =
    emailWhere.length > 0
      ? await db.emailMessage.deleteMany({ where: { OR: emailWhere } })
      : { count: 0 };

  const conversations =
    byCustomer.length > 0
      ? await db.agentConversation.deleteMany({ where: { OR: byCustomer } })
      : { count: 0 };

  const [customers, applicationsDeleted, orders, quotes] = await Promise.all([
    db.customer.deleteMany({ where: { OR: both } }),
    db.formSubmission.deleteMany({ where: { OR: both } }),
    // The merchant's own record, with the person taken out of it.
    db.order.updateMany({
      where: { OR: both },
      data: { customerId: null, email: null, company: null },
    }),
    db.quote.updateMany({
      where: { OR: both },
      data: {
        customerId: null,
        email: null,
        company: null,
        // The three free-text fields, which are the buyer's own words and the
        // merchant's notes about them. `requestNote` is literally "what the
        // buyer asked for, in their words" — an address and a phone number
        // turn up in there as often as a product name, and leaving it behind
        // made the rest of this redaction decorative.
        requestNote: null,
        message: null,
        internalNote: null,
      },
    }),
  ]);

  const audit = await redactAudit(identity, { submissionIds, customerRowIds });
  const stored = await redactStoredFacts(identity);

  return {
    audit,
    stored,
    customers: customers.count,
    applications: applicationsDeleted.count,
    uploads: uploads.count,
    emails: emails.count,
    orders: orders.count,
    quotes: quotes.count,
    conversations: conversations.count,
  };
}

/**
 * Take the person out of the audit trail, without taking the trail out.
 *
 * The first version of this left them in it entirely, and the audit log is a
 * page a merchant reads for twelve months. Three different things put a buyer
 * in there and each needs a different answer:
 *
 * - **They were the actor.** A form submission records the applicant as the
 *   actor, with their email as the label and their IP beside it. Nulled.
 * - **The entry is about them.** "Approved Acme Ltd", subject `FormSubmission`
 *   or `Customer`, with their id. The subject is gone, so the entry is about
 *   nothing; deleted.
 * - **Their address is in the words.** A reminder's metadata carries `to`, a
 *   rejection's summary carries the address it went to. Replaced, in place,
 *   with a marker that says a person was removed rather than leaving a
 *   sentence with a hole in it.
 *
 * The counts, the actions and the dates stay throughout: an audit trail with
 * entries silently missing is not one a merchant can rely on, and the whole
 * reason this table exists is that they can.
 */
export const REDACTED = "[removed]";

async function redactAudit(
  identity: BuyerIdentity,
  ids: { submissionIds: string[]; customerRowIds: string[] },
): Promise<number> {
  const shop = shopScope.require("redactAudit");
  const email = identity.email?.trim() || null;
  const subjectIds = [
    ...ids.submissionIds,
    ...ids.customerRowIds,
    ...(identity.customerId ? [identity.customerId] : []),
  ];

  // About them, and about nothing else now.
  const aboutThem =
    subjectIds.length > 0
      ? await db.auditLog.deleteMany({
          where: {
            subjectType: { in: ["FormSubmission", "Customer"] },
            subjectId: { in: subjectIds },
          },
        })
      : { count: 0 };

  // They were the actor, on an entry that is about something else.
  const asActor = await db.auditLog.updateMany({
    where: {
      OR: [
        ...(identity.customerId ? [{ actorId: identity.customerId }] : []),
        ...(email
          ? [{ actorLabel: { equals: email, mode: "insensitive" as const } }]
          : []),
      ],
    },
    data: { actorId: null, actorLabel: REDACTED, ip: null },
  });

  // Their address, written into somebody else's sentence.
  let inWords = 0;
  if (email) {
    const mentions = await db.auditLog.findMany({
      where: { summary: { contains: email, mode: "insensitive" } },
      select: { id: true, summary: true },
    });

    for (const entry of mentions) {
      await db.auditLog.update({
        where: { id: entry.id },
        data: {
          summary: entry.summary.replace(
            new RegExp(escapeForRegExp(email), "gi"),
            REDACTED,
          ),
        },
      });
      inWords += 1;
    }

    // And in the structured part beside it, which no text scan would reach.
    // Raw SQL because Prisma cannot rewrite inside a `Json` column: this is a
    // whole-document replace of the address wherever it appears in it.
    inWords += await db.$executeRaw`
      UPDATE "AuditLog"
      SET "metadata" = REPLACE("metadata"::text, ${email}, ${REDACTED})::jsonb
      WHERE "shop" = ${shop}
        AND "metadata"::text ILIKE ${"%" + email + "%"}
    `;
  }

  return aboutThem.count + asActor.count + inWords;
}

/** A literal address, safe to put inside a pattern. */
const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Take them out of the answers Claude already wrote.
 *
 * A monthly review is kept **for ever**, by design, so a merchant can compare
 * this March with last March — and its `facts.slots` carries the shop's top
 * buyer by name (`review.server.ts` writes `topBuyer.label`, which is the
 * company on their orders). For a sole trader that company name *is* the
 * person. The daily briefing can carry the address the same way, because the
 * fact assembler passes `company ?? email` as the subject.
 *
 * Neither is a row that exists because of this buyer, so neither is deleted:
 * a merchant's year of reviews should not develop holes because somebody
 * asked to be forgotten. The name comes out and the figures stay.
 *
 * A whole-document replace, in SQL, because the name can be anywhere inside a
 * `Json` column and Prisma cannot rewrite inside one.
 */
async function redactStoredFacts(identity: BuyerIdentity): Promise<number> {
  const shop = shopScope.require("redactStoredFacts");
  const needles = [identity.customerId, identity.email?.trim()].filter(
    (one): one is string => typeof one === "string" && one.length > 0,
  );
  if (needles.length === 0) return 0;

  let changed = 0;
  for (const needle of needles) {
    const like = `%${needle}%`;
    changed += await db.$executeRaw`
      UPDATE "MonthlyReview"
      SET "facts" = REPLACE("facts"::text, ${needle}, ${REDACTED})::jsonb
      WHERE "shop" = ${shop} AND "facts"::text ILIKE ${like}
    `;
    changed += await db.$executeRaw`
      UPDATE "MerchantBriefing"
      SET "items" = REPLACE("items"::text, ${needle}, ${REDACTED})::jsonb
      WHERE "shop" = ${shop} AND "items"::text ILIKE ${like}
    `;
  }

  return changed;
}
