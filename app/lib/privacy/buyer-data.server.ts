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
      customers: 0,
      applications: 0,
      uploads: 0,
      emails: 0,
      orders: 0,
      quotes: 0,
      conversations: 0,
    };
  }

  const applications = await db.formSubmission.findMany({
    where: { OR: both },
    select: { id: true },
  });
  const submissionIds = applications.map((row) => row.id);

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
      data: { customerId: null, email: null, company: null },
    }),
  ]);

  return {
    customers: customers.count,
    applications: applicationsDeleted.count,
    uploads: uploads.count,
    emails: emails.count,
    orders: orders.count,
    quotes: quotes.count,
    conversations: conversations.count,
  };
}
