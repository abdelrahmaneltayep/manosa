import { dueDateFor } from "@mannon/net-terms";
import { parseMoney, type Money } from "@mannon/pricing-engine";
import type { Order } from "@prisma/client";

import { db } from "~/db.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import { assertFeature } from "~/lib/billing/gate.server";
import { publishBuyerFacts } from "~/lib/pricing/buyer-facts.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import {
  balanceOfOrder,
  ledgerFor,
  publishableTerms,
  type BuyerWithGroup,
} from "~/lib/terms/terms.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";

/**
 * The outstanding ledger: putting orders on terms, and recording what comes in.
 */

/**
 * Put an order on terms.
 *
 * Called when an order arrives from a buyer who has terms. The days are copied
 * onto the order rather than read from the buyer later, because the checklist
 * is explicit: "terms changed mid-outstanding-invoice → applies to new orders
 * only". An invoice has to keep the agreement it was raised under.
 */
export async function applyTermsToOrder(
  order: Order,
  days: number,
): Promise<Order | null> {
  // Already settled, or already on terms — nothing to do, and re-stamping would
  // move a due date the buyer has already been told about.
  if (order.netTermsDueAt || order.paidAt) return null;

  return db.order.update({
    where: { id: order.id },
    data: { netTermsDays: days, netTermsDueAt: dueDateFor(order.processedAt, days) },
  });
}

export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

/**
 * Record money received against an order.
 *
 * Never edits a previous payment: a correction is another row, with a negative
 * amount if it has to be. A ledger a merchant cannot explain line by line is
 * one they will not trust with a debt collection.
 */
export async function recordPayment(
  orderId: string,
  input: { amount: number; receivedAt: Date; reference: string | null },
  { actor }: { actor: AuditActor },
) {
  await assertFeature("net_terms");

  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Response("Order not found", { status: 404 });

  if (!Number.isSafeInteger(input.amount) || input.amount === 0) {
    throw new PaymentError("A payment needs an amount.");
  }

  const balance = balanceOfOrder(order);
  if (input.amount > balance.amount) {
    // Overpaying is almost always a typo — two digits, or the wrong invoice —
    // and a ledger that accepts it quietly is one that stops reconciling.
    throw new PaymentError(
      `That is more than the ${order.name} balance. Record at most the outstanding amount.`,
    );
  }

  const paid = order.amountPaid + input.amount;
  const settled = paid >= order.totalPrice - order.refundedAmount;

  const [payment, updated] = await db.$transaction([
    db.payment.create({
      data: {
        ...tenant(),
        orderId: order.id,
        amount: input.amount,
        currencyCode: order.currencyCode,
        receivedAt: input.receivedAt,
        reference: input.reference,
        createdBy: actor.id ?? null,
      },
    }),
    db.order.update({
      where: { id: order.id },
      data: {
        amountPaid: paid,
        // Only stamped when the whole balance is in: a part payment is not a
        // paid invoice, and treating it as one would drop it off the ledger.
        paidAt: settled ? input.receivedAt : null,
      },
    }),
  ]);

  await recordAudit({
    actor,
    action: settled ? "terms.invoice_settled" : "terms.payment_recorded",
    summary: settled
      ? `Recorded the final payment on ${order.name}. It is settled.`
      : `Recorded a part payment on ${order.name}.`,
    subject: { type: "Order", id: order.id },
    metadata: {
      amount: input.amount,
      currencyCode: order.currencyCode,
      balanceAfter: balanceOfOrder(updated).amount,
    },
  });

  return { payment, order: updated };
}

/** Every payment against one order, oldest first — the audit trail. */
export async function paymentsFor(orderId: string) {
  return db.payment.findMany({ where: { orderId }, orderBy: { receivedAt: "asc" } });
}

/**
 * Republish one buyer's terms so checkout agrees with the ledger.
 *
 * Runs whenever what checkout would decide differently changes: their terms,
 * their credit limit, a payment, a new invoice. Until it runs, a buyer who has
 * just paid off their balance is still refused at checkout — the same class of
 * disagreement between admin and cart that this app exists to prevent.
 */
export async function publishBuyerTerms(admin: AdminGraphql, buyer: BuyerWithGroup) {
  const shop = shopScope.require("publishBuyerTerms");
  const record = await db.shop.findUnique({ where: { shop } });
  const currencyCode = record?.currencyCode ?? "USD";

  const ledger = await ledgerFor(buyer, { currencyCode });

  return publishBuyerFacts(admin, buyer.customerId, {
    tags: buyer.tags,
    groupIds: buyer.groupId ? [buyer.groupId] : [],
    terms: publishableTerms(
      ledger.terms,
      ledger.summary,
      record?.termsOverdueBlocks ?? true,
    ),
  });
}

/** What one order still owes. Re-exported so callers need one import. */
export function balanceOf(order: Order): Money {
  return balanceOfOrder(order);
}

/**
 * A typed decimal as minor units, or null when it is not an amount.
 *
 * `parseMoney` knows each currency's exponent, so "12.50" is 1250 in USD and
 * rejected in JPY. A helper that assumed two decimal places would be wrong in
 * every Gulf currency, which is half this app's market.
 */
export function parseAmount(value: string, currencyCode: string): number | null {
  const text = value.trim();
  if (!text) return null;
  try {
    return parseMoney(text, currencyCode).amount;
  } catch {
    return null;
  }
}
