import { randomBytes } from "node:crypto";

import { formatMoney, money, type Money } from "@mannon/pricing-engine";
import type { Prisma, Quote, QuoteLine } from "@prisma/client";

import { db } from "~/db.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import { assertFeature } from "~/lib/billing/gate.server";
import { createDraftOrder } from "~/lib/quotes/admin-graphql.server";
import { nextRun } from "~/lib/jobs/handlers/expire-quotes.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import { deliverQuoteEmail } from "~/lib/quotes/email.server";
import {
  priceQuote,
  type BuyerForPricing,
  type QuoteLineRequest,
} from "~/lib/quotes/pricing.server";
import {
  DEFAULT_EXPIRY_DAYS,
  expiryFrom,
  hasExpired,
  transition,
  type QuoteAction,
  type QuoteState,
} from "~/lib/quotes/state";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { shopScope, tenant, withoutShopScope } from "~/lib/tenant/shop-context.server";

/**
 * Quotes: storing them, pricing them once, and turning an accepted one into a
 * Shopify draft order.
 *
 * The state machine is `~/lib/quotes/state`; the pricing is
 * `~/lib/quotes/pricing.server`, which asks the engine. Nothing here decides a
 * price or a transition — this module finds the rows and writes the answers
 * down.
 */

export type QuoteWithLines = Quote & { lines: QuoteLine[] };

export const QUOTES_PAGE_SIZE = 25;

/**
 * The token in the accept link.
 *
 * Random, not a cuid. A registration form's public id only reveals a form; a
 * quote's reveals one buyer's negotiated prices and lets somebody act on them,
 * so it is 192 bits of randomness rather than something with a timestamp in it.
 */
function newPublicId(): string {
  return randomBytes(24).toString("base64url");
}

export class QuoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteValidationError";
  }
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

export interface QuoteFilters {
  search: string;
  /** "" for every state, or one QuoteStatus. */
  status: string;
}

export const EMPTY_QUOTE_FILTERS: QuoteFilters = { search: "", status: "" };

export async function listQuotes(
  filters: QuoteFilters,
  { page = 1, pageSize = QUOTES_PAGE_SIZE } = {},
) {
  const where: Prisma.QuoteWhereInput = {};
  const and: Prisma.QuoteWhereInput[] = [];

  const search = filters.search.trim();
  if (search) {
    and.push({
      OR: [
        { number: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { company: { contains: search, mode: "insensitive" } },
      ],
    });
  }
  if (filters.status) {
    and.push({ status: filters.status as QuoteState });
  }
  if (and.length > 0) where.AND = and;

  const [rows, total, totalUnfiltered] = await Promise.all([
    db.quote.findMany({
      where,
      include: { lines: { orderBy: { position: "asc" } } },
      // New requests first — they are what a merchant opens this page to find —
      // then the rest by age.
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      skip: Math.max(0, (page - 1) * pageSize),
      take: pageSize,
    }),
    db.quote.count({ where }),
    db.quote.count(),
  ]);

  return { rows, total, totalUnfiltered, page, pageSize };
}

export async function getQuote(id: string): Promise<QuoteWithLines | null> {
  return db.quote.findUnique({
    where: { id },
    include: { lines: { orderBy: { position: "asc" } } },
  });
}

/**
 * Find a quote by the token in its link, across shops.
 *
 * The one query here that has to look outside a tenant: a public URL carries no
 * shop. It selects by an unguessable id, returns the shop it belongs to, and
 * every later query runs inside that shop's scope.
 */
export async function findPublicQuote(
  publicId: string,
): Promise<{ shop: string; quote: QuoteWithLines } | null> {
  const quote = await withoutShopScope(
    "a quote accept link carries no shop; the token is the lookup",
    () =>
      db.quote.findUnique({
        where: { publicId },
        include: { lines: { orderBy: { position: "asc" } } },
      }),
  );

  return quote ? { shop: quote.shop, quote } : null;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/** The next "Q-1001", from a counter on the shop rather than a row count. */
async function nextNumber(): Promise<string> {
  const shop = shopScope.require("quoteNumber");
  const updated = await db.shop.update({
    where: { shop },
    data: { quoteCounter: { increment: 1 } },
    select: { quoteCounter: true },
  });
  return `Q-${updated.quoteCounter}`;
}

export interface NewQuote {
  customerId: string | null;
  email: string | null;
  company: string | null;
  requestNote: string | null;
  source?: "MERCHANT" | "STOREFRONT" | "BUYER_AGENT";
}

/**
 * Record a request. Nothing is priced yet — that is `draftQuote`.
 *
 * Kept separate because a request from the storefront or the agent arrives
 * without a merchant present, and pricing it automatically would be this app
 * quoting on their behalf. The merchant prices it, which is also where the
 * margin check will land in 4.x.
 */
export async function createQuote(
  input: NewQuote,
  { actor }: { actor: AuditActor },
): Promise<QuoteWithLines> {
  await assertFeature("draft_orders");

  const shop = shopScope.require("createQuote");
  const record = await db.shop.findUnique({ where: { shop } });

  const quote = await db.quote.create({
    data: {
      ...tenant(),
      publicId: newPublicId(),
      number: await nextNumber(),
      customerId: input.customerId,
      email: input.email,
      company: input.company,
      requestNote: input.requestNote,
      source: input.source ?? "MERCHANT",
      currencyCode: record?.currencyCode ?? "USD",
      createdBy: actor.id ?? null,
    },
    include: { lines: true },
  });

  await recordAudit({
    actor,
    action: "quote.created",
    summary: `Started quote ${quote.number}${input.company ? ` for ${input.company}` : ""}.`,
    subject: { type: "Quote", id: quote.id },
    metadata: { source: quote.source },
  });

  return quote;
}

/**
 * Price a quote and lock what the engine said.
 *
 * The prices are written onto the lines here and never recomputed. A buyer
 * quoted on Monday who accepts on Thursday pays Monday's price — that promise
 * is this function, and the accept path deliberately does no pricing at all.
 */
export async function draftQuote(
  id: string,
  input: {
    lines: QuoteLineRequest[];
    message?: string | null;
    internalNote?: string | null;
    /** Per-line overrides in minor units, keyed by variant id. */
    overrides?: Record<string, number>;
  },
  { actor, now = new Date() }: { actor: AuditActor; now?: Date },
): Promise<QuoteWithLines> {
  await assertFeature("draft_orders");

  const quote = await db.quote.findUnique({ where: { id } });
  if (!quote) throw new Response("Quote not found", { status: 404 });

  const status = transition(quote.status as QuoteState, "draft");

  if (input.lines.length === 0) {
    throw new QuoteValidationError("A quote needs at least one line.");
  }
  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new QuoteValidationError(
        `${line.title || "A line"} needs a whole quantity of at least 1.`,
      );
    }
  }

  const buyer = await buyerFor(quote.customerId);
  const priced = await priceQuote(input.lines, buyer, {
    now,
    currencyCode: quote.currencyCode,
  });

  // A merchant's own number beats the engine's, but only when they typed one:
  // an override is a deliberate act and is recorded as such.
  const overrides = input.overrides ?? {};
  const lines = priced.lines.map((line, position) => {
    const override = overrides[line.variantId];
    const overridden = override !== undefined && override >= 0;
    return {
      ...tenant(),
      quoteId: id,
      variantId: line.variantId,
      productId: line.productId ?? null,
      title: line.title,
      sku: line.sku ?? null,
      quantity: line.quantity,
      unitPrice: overridden ? override : line.unitPrice.amount,
      listPrice: line.listPrice.amount,
      appliedRuleIds: overridden ? [] : line.appliedRuleIds,
      ruleSummary: overridden ? null : line.ruleSummary,
      position,
    };
  });

  const subtotal = lines.reduce(
    (total, line) => total + line.unitPrice * line.quantity,
    0,
  );

  const saved = await db.$transaction(async (tx) => {
    await tx.quoteLine.deleteMany({ where: { quoteId: id } });
    await tx.quoteLine.createMany({ data: lines });
    return tx.quote.update({
      where: { id },
      data: {
        status,
        subtotal,
        lockedAt: now,
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.internalNote !== undefined ? { internalNote: input.internalNote } : {}),
      },
      include: { lines: { orderBy: { position: "asc" } } },
    });
  });

  await recordAudit({
    actor,
    action: "quote.drafted",
    summary:
      `Priced ${saved.number} at ${formatMoney(money(subtotal, saved.currencyCode))} ` +
      `${saved.currencyCode}. These prices are locked until it is re-drafted.`,
    subject: { type: "Quote", id },
    metadata: {
      lineCount: lines.length,
      subtotal,
      overridden: Object.keys(overrides).length,
      unreadableRules: priced.unreadableRules,
    },
  });

  return saved;
}

/** The buyer's pricing facts, or a guest when the request has no account. */
async function buyerFor(customerId: string | null): Promise<BuyerForPricing> {
  if (!customerId) return { customerId: null, tags: [], groupIds: [] };

  const buyer = await db.customer.findFirst({ where: { customerId } });
  return {
    customerId,
    tags: buyer?.tags ?? [],
    groupIds: buyer?.groupId ? [buyer.groupId] : [],
  };
}

/**
 * Send it to the buyer.
 *
 * The expiry days are copied onto the quote here rather than read from settings
 * later, so a merchant who changes the default next week does not move a date
 * this buyer has already been given.
 */
export async function sendQuote(
  id: string,
  { actor, now = new Date() }: { actor: AuditActor; now?: Date },
): Promise<QuoteWithLines> {
  await assertFeature("draft_orders");

  const shop = shopScope.require("sendQuote");
  const quote = await db.quote.findUnique({ where: { id }, include: { lines: true } });
  if (!quote) throw new Response("Quote not found", { status: 404 });

  const status = transition(quote.status as QuoteState, "send");

  if (!quote.email) {
    throw new QuoteValidationError("This quote has no email address to send to.");
  }
  if (quote.lines.length === 0) {
    throw new QuoteValidationError("Price the quote before sending it.");
  }

  const record = await db.shop.findUnique({ where: { shop } });
  const expiryDays = record?.quoteExpiryDays ?? DEFAULT_EXPIRY_DAYS;

  const saved = await db.quote.update({
    where: { id },
    data: {
      status,
      sentAt: now,
      expiryDays,
      expiresAt: expiryFrom(now, expiryDays),
      // A resend starts the warning over.
      remindedAt: null,
    },
    include: { lines: { orderBy: { position: "asc" } } },
  });

  // Keep the expiry job alive while this quote is out. Nothing else schedules
  // it, so an unsent store never runs one and a sent quote always has one due.
  await enqueueJob({
    kind: "quotes.expire",
    runAt: nextRun(now),
    replacePending: true,
  });

  // The email carries the link, and is recorded whether or not it went — a
  // merchant whose provider is down still needs to know what was attempted.
  const message = await deliverQuoteEmail(saved, "quote_sent", record?.name ?? shop);

  await recordAudit({
    actor,
    action: "quote.sent",
    summary:
      message.status === "SENT"
        ? `Sent ${saved.number} to ${saved.email}. It stands until ${saved.expiresAt?.toISOString().slice(0, 10)}.`
        : `${saved.number} was marked sent, but the email to ${saved.email} could not be delivered.`,
    subject: { type: "Quote", id },
    metadata: { expiresAt: saved.expiresAt?.toISOString(), emailStatus: message.status },
  });

  return saved;
}

/**
 * The buyer accepts.
 *
 * **Nothing is priced here.** The lines already carry what the engine said at
 * draft time, and that is what goes to Shopify. Re-running the engine now would
 * charge the buyer today's price for a quote they were given last week, which
 * is exactly the failure this whole table prevents.
 */
export async function acceptQuote(
  id: string,
  {
    admin,
    actor,
    now = new Date(),
  }: { admin: AdminGraphql; actor: AuditActor; now?: Date },
): Promise<QuoteWithLines> {
  const quote = await db.quote.findUnique({
    where: { id },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  if (!quote) throw new Response("Quote not found", { status: 404 });

  // Checked before the state machine so an expired quote says "expired" rather
  // than "a sent quote cannot be accepted".
  if (hasExpired(quote as { status: QuoteState; expiresAt: Date | null }, now)) {
    await expireQuote(id, { now });
    throw new QuoteValidationError("This quote has expired.");
  }

  const status = transition(quote.status as QuoteState, "accept");

  const draft = await createDraftOrder(admin, {
    customerId: quote.customerId,
    email: quote.email,
    note: `Accepted from Mannon quote ${quote.number}.`,
    tags: ["mannon-quote", quote.number],
    lines: quote.lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      currencyCode: quote.currencyCode,
      unitPriceDecimal: formatMoney(money(line.unitPrice, quote.currencyCode)),
    })),
  });

  const saved = await db.quote.update({
    where: { id },
    data: {
      status,
      acceptedAt: now,
      draftOrderId: draft.id || null,
      draftOrderName: draft.name || null,
    },
    include: { lines: { orderBy: { position: "asc" } } },
  });

  await recordAudit({
    actor,
    action: "quote.accepted",
    summary:
      `${saved.number} was accepted and became draft order ${draft.name || "in Shopify"}, ` +
      `at the prices quoted.`,
    subject: { type: "Quote", id },
    metadata: { draftOrderId: draft.id, subtotal: saved.subtotal },
  });

  return saved;
}

export async function declineQuote(
  id: string,
  action: Extract<QuoteAction, "decline" | "withdraw">,
  { actor, now = new Date() }: { actor: AuditActor; now?: Date },
): Promise<QuoteWithLines> {
  const quote = await db.quote.findUnique({ where: { id } });
  if (!quote) throw new Response("Quote not found", { status: 404 });

  const status = transition(quote.status as QuoteState, action);

  const saved = await db.quote.update({
    where: { id },
    data: { status, declinedAt: now },
    include: { lines: { orderBy: { position: "asc" } } },
  });

  await recordAudit({
    actor,
    action: action === "decline" ? "quote.declined" : "quote.withdrawn",
    summary:
      action === "decline"
        ? `${saved.number} was declined by the buyer.`
        : `${saved.number} was withdrawn.`,
    subject: { type: "Quote", id },
  });

  return saved;
}

/** Reopen a declined or expired quote for re-pricing. */
export async function reopenQuote(
  id: string,
  { actor }: { actor: AuditActor },
): Promise<QuoteWithLines> {
  await assertFeature("draft_orders");

  const quote = await db.quote.findUnique({ where: { id } });
  if (!quote) throw new Response("Quote not found", { status: 404 });

  const status = transition(quote.status as QuoteState, "reopen");

  const saved = await db.quote.update({
    where: { id },
    data: { status, declinedAt: null, sentAt: null, expiresAt: null, remindedAt: null },
    include: { lines: { orderBy: { position: "asc" } } },
  });

  await recordAudit({
    actor,
    action: "quote.reopened",
    summary: `${saved.number} was reopened. Re-price it before sending — the old prices still stand until you do.`,
    subject: { type: "Quote", id },
  });

  return saved;
}

/** Mark it expired. Used by the job and by a buyer arriving too late. */
export async function expireQuote(id: string, { now = new Date() } = {}) {
  return db.quote
    .updateMany({
      where: { id, status: "SENT" },
      data: { status: "EXPIRED" },
    })
    .then((result) => ({ expired: result.count > 0, at: now }));
}

/** What one line still costs the buyer. */
export function lineTotal(line: QuoteLine, currencyCode: string): Money {
  return money(line.unitPrice * line.quantity, currencyCode);
}
