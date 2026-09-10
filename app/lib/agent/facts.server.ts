import { money, type Money } from "@mannon/pricing-engine";

import { db } from "~/db.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * The numbers the Merchant Agent is allowed to talk about.
 *
 * Checklist §1: "briefing never invents a metric — every number linked to its
 * Analytics source." That is enforced here rather than asked for in a prompt:
 * every fact is computed from the database, carries the page it came from, and
 * the briefing renders **our** number. The model chooses which facts matter and
 * in what order; it never supplies a figure.
 *
 * A fact with nothing to say is simply absent. "All quiet" is what an empty
 * list means, and it is a designed state rather than an apology.
 */

/** Every kind of thing the agent can raise. Closed, so a merchant can mute one. */
export const FACT_KINDS = [
  "applications_waiting",
  "screening_flagged",
  "invoices_overdue",
  "credit_exceeded",
  "quotes_expiring",
  "orders_needing_resync",
  "rules_unused",
  "no_active_rules",
  "buyers_gone_quiet",
  "wholesale_week",
  "form_never_opened",
  "uploads_unscanned",
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

export function isFactKind(value: string): value is FactKind {
  return (FACT_KINDS as readonly string[]).includes(value);
}

/**
 * One thing that is true about this shop right now.
 *
 * `count` and `amount` are the only numbers that ever reach the screen, and
 * both were computed here. `href` is the "linked to its source" half of the
 * checklist's rule — every item is one click from the page that proves it.
 */
export interface AgentFact {
  kind: FactKind;
  count: number;
  amount: Money | null;
  /** Where the merchant goes to see it for themselves. */
  href: string;
  /** Extra context the sentence needs — a rule's name, a buyer's company. */
  subject: string | null;
}

const DAY = 86_400_000;

/** Rules with no uses in this long are worth mentioning once. */
const UNUSED_DAYS = 30;
/** A buyer who used to order every few weeks and has not in this long. */
const QUIET_DAYS = 60;
/** A quote expiring within this window is still worth chasing. */
const EXPIRING_DAYS = 3;
/** The most overdue invoices one briefing reads. Bounded, on the home path. */
export const OVERDUE_SCAN_LIMIT = 500;

/**
 * Everything true about this shop, in one pass.
 *
 * Counts, not rows: a briefing needs "6 applications waiting", and loading six
 * applications to say so would cost a page load every morning for a sentence.
 */
export async function briefingFacts(now = new Date()): Promise<AgentFact[]> {
  shopScope.require("briefingFacts");

  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("briefingFacts") },
  });
  const currencyCode = shop?.currencyCode ?? "USD";

  const [
    applicationsWaiting,
    screeningFlagged,
    withCredit,
    overdue,
    quotesExpiring,
    needingResync,
    unusedRules,
    activeRules,
    quietBuyers,
    weekOrders,
    previousWeekOrders,
    formsNeverOpened,
    unscanned,
  ] = await Promise.all([
    db.formSubmission.count({ where: { status: "PENDING" } }),
    db.formSubmission.count({ where: { status: "PENDING", screening: "LOOK" } }),
    // Buyers over the credit ceiling their group or their own terms set. The
    // ledger already computes this the same way; checklist §5 asks that the
    // agent and checkout say so with the same number.
    db.customer.findMany({
      where: {
        status: "APPROVED",
        deletedInShopifyAt: null,
        OR: [{ creditLimit: { not: null } }, { group: { creditLimit: { not: null } } }],
      },
      select: {
        id: true,
        company: true,
        email: true,
        creditLimit: true,
        customerId: true,
        group: { select: { creditLimit: true } },
      },
      take: 200,
    }),
    db.order.findMany({
      where: {
        paidAt: null,
        cancelledAt: null,
        netTermsDueAt: { lt: now },
      },
      select: {
        totalPrice: true,
        amountPaid: true,
        currencyCode: true,
        customerId: true,
      },
      // Bounded. A shop with ten thousand overdue invoices has a problem this
      // card cannot express, and loading them all to say "10,000" is a page
      // load every morning for a number that is wrong either way.
      take: OVERDUE_SCAN_LIMIT,
    }),
    db.quote.count({
      where: {
        status: "SENT",
        expiresAt: { gte: now, lte: new Date(now.getTime() + EXPIRING_DAYS * DAY) },
      },
    }),
    db.order.count({ where: { needsResync: true } }),
    db.pricingRule.findMany({
      where: {
        status: "ACTIVE",
        archivedAt: null,
        usageCount30d: 0,
        createdAt: { lt: new Date(now.getTime() - UNUSED_DAYS * DAY) },
      },
      select: { name: true },
      orderBy: { createdAt: "asc" },
    }),
    db.pricingRule.count({ where: { status: "ACTIVE", archivedAt: null } }),
    db.customer.findMany({
      where: {
        status: "APPROVED",
        deletedInShopifyAt: null,
        orderCount: { gte: 2 },
        lastOrderAt: { lt: new Date(now.getTime() - QUIET_DAYS * DAY) },
      },
      select: { company: true, email: true },
      orderBy: { lifetimeSpend: "desc" },
      take: 5,
    }),
    db.order.aggregate({
      where: {
        isWholesale: true,
        cancelledAt: null,
        createdAt: { gte: new Date(now.getTime() - 7 * DAY) },
      },
      _count: true,
      _sum: { totalPrice: true },
    }),
    db.order.aggregate({
      where: {
        isWholesale: true,
        cancelledAt: null,
        createdAt: {
          gte: new Date(now.getTime() - 14 * DAY),
          lt: new Date(now.getTime() - 7 * DAY),
        },
      },
      _count: true,
    }),
    db.registrationForm.count({
      where: {
        status: "LIVE",
        archivedAt: null,
        // A live form nobody has opened is usually one nobody has been given
        // the link to. `none` rather than a counter: views are rows, so the
        // question is whether any exist.
        events: { none: { kind: "VIEW" } },
      },
    }),
    db.formUpload.count({
      where: { scannedAt: null, submission: { status: "PENDING" } },
    }),
  ]);

  const facts: AgentFact[] = [];

  const add = (
    kind: FactKind,
    count: number,
    options: { href: string; amount?: Money | null; subject?: string | null } = {
      href: "/app",
    },
  ) => {
    if (count <= 0) return;
    facts.push({
      kind,
      count,
      amount: options.amount ?? null,
      href: options.href,
      subject: options.subject ?? null,
    });
  };

  add("applications_waiting", applicationsWaiting, {
    href: "/app/customers/applications",
  });
  add("screening_flagged", screeningFlagged, {
    href: "/app/customers/applications",
  });

  // Only what is actually still owed, and only in the shop's own currency —
  // adding two currencies together would be a number that means nothing.
  const owed = overdue
    .filter((order) => order.currencyCode === currencyCode)
    .reduce(
      (total, order) => total + Math.max(0, order.totalPrice - order.amountPaid),
      0,
    );
  add("invoices_overdue", overdue.length, {
    href: "/app/orders/terms",
    amount: owed > 0 ? money(owed, currencyCode) : null,
  });

  // Over their ceiling: what they still owe against the limit that applies to
  // them. Their own limit replaces their group's; it never merges with it.
  const owedByCustomer = new Map<string, number>();
  for (const order of overdue) {
    if (!order.customerId) continue;
    if (order.currencyCode !== currencyCode) continue;
    owedByCustomer.set(
      order.customerId,
      (owedByCustomer.get(order.customerId) ?? 0) +
        Math.max(0, order.totalPrice - order.amountPaid),
    );
  }

  const overLimit = withCredit.filter((customer) => {
    const limit = customer.creditLimit ?? customer.group?.creditLimit ?? null;
    if (limit === null) return false;
    return (owedByCustomer.get(customer.customerId) ?? 0) > limit;
  });

  add("credit_exceeded", overLimit.length, {
    href: "/app/orders/terms",
    subject: overLimit[0]?.company ?? overLimit[0]?.email ?? null,
  });

  add("quotes_expiring", quotesExpiring, { href: "/app/orders/quotes" });
  add("orders_needing_resync", needingResync, { href: "/app/orders" });

  add("rules_unused", unusedRules.length, {
    href: "/app/pricing",
    subject: unusedRules[0]?.name ?? null,
  });
  if (activeRules === 0) {
    add("no_active_rules", 1, { href: "/app/pricing" });
  }

  add("buyers_gone_quiet", quietBuyers.length, {
    href: "/app/customers",
    subject: quietBuyers[0]?.company ?? quietBuyers[0]?.email ?? null,
  });

  if (weekOrders._count > 0) {
    facts.push({
      kind: "wholesale_week",
      count: weekOrders._count,
      amount:
        weekOrders._sum.totalPrice !== null
          ? money(weekOrders._sum.totalPrice, currencyCode)
          : null,
      href: "/app/orders",
      // The comparison the merchant will make anyway, made for them — and
      // stated as a count, not a percentage, because a week with one order
      // last time produces "▲ 400%", which is noise.
      subject: String(previousWeekOrders._count),
    });
  }

  add("form_never_opened", formsNeverOpened, { href: "/app/forms" });
  add("uploads_unscanned", unscanned, { href: "/app/customers/applications" });

  return facts;
}
