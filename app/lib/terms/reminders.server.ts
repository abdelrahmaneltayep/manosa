import type { Order } from "@prisma/client";

import { db } from "~/db.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import { assertFeature } from "~/lib/billing/gate.server";
import { deliverEmail } from "~/lib/email/deliver.server";
import { formatCurrency } from "~/lib/money";
import { balanceOfOrder } from "~/lib/terms/terms.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Payment reminders.
 *
 * The merchant sends them. ✦ Drafting the wording is phase 4.3; until then the
 * template below ships, and it already carries the two numbers a reminder is
 * for — the amount and the date.
 *
 * A buyer can opt in to automatic reminders (`Customer.autoRemind`), which is
 * the checklist's "auto-remind opt-in per buyer". Opt-in rather than opt-out:
 * an app that starts chasing a merchant's customers on its own initiative is
 * an app that costs them a relationship.
 */

/** No second reminder within this many days, however many times it is clicked. */
export const REMINDER_COOLDOWN_DAYS = 3;

const DAY_MS = 86_400_000;

export const REMINDER_TEMPLATE = {
  subject: "Invoice {{order}} is due {{dueDate}}",
  body: [
    "Hello {{company}},",
    "",
    "This is a reminder that {{amount}} is outstanding on order {{order}}, due {{dueDate}}.",
    "",
    "If you have already sent it, thank you — please ignore this message.",
    "",
    "{{shopName}}",
  ].join("\n"),
};

export function canRemind(order: Order, now: Date): boolean {
  if (!order.remindedAt) return true;
  return now.getTime() - order.remindedAt.getTime() >= REMINDER_COOLDOWN_DAYS * DAY_MS;
}

export class ReminderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReminderError";
  }
}

export async function sendReminder(
  orderId: string,
  { actor, now = new Date() }: { actor: AuditActor; now?: Date },
) {
  await assertFeature("net_terms");
  const shop = shopScope.require("sendReminder");

  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Response("Order not found", { status: 404 });

  if (!order.email) {
    throw new ReminderError("This order has no email address to write to.");
  }
  if (!canRemind(order, now)) {
    // Clicking twice must not send twice. A buyer chased three times in an
    // afternoon is a buyer who stops reading.
    throw new ReminderError(
      `A reminder went out recently. You can send another in a few days.`,
    );
  }

  const record = await db.shop.findUnique({ where: { shop } });
  const balance = balanceOfOrder(order);

  const message = await deliverEmail({
    kind: "payment_reminder",
    to: order.email,
    template: REMINDER_TEMPLATE,
    values: {
      order: order.name,
      company: order.company ?? order.email,
      amount: formatCurrency(balance),
      dueDate: order.netTermsDueAt?.toISOString().slice(0, 10) ?? "",
      shopName: record?.name ?? shop,
    },
  });

  // Stamped whatever the provider said: a message that failed still went into
  // `EmailMessage` with its error, and re-sending it in a loop would not help.
  await db.order.update({ where: { id: order.id }, data: { remindedAt: now } });

  await recordAudit({
    actor,
    action: "terms.reminder_sent",
    summary:
      message.status === "SENT"
        ? `Sent a payment reminder for ${order.name}.`
        : `A payment reminder for ${order.name} could not be sent.`,
    subject: { type: "Order", id: order.id },
    metadata: { to: order.email, status: message.status },
  });

  return message;
}
