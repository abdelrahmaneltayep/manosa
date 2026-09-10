import type { AgentConversation } from "@prisma/client";

import type { TestCartLineView, TestTurnView, TestView } from "~/components/agent/types";
import { db } from "~/db.server";
import type { Translate } from "~/i18n/translate";
import { IDLE_MINUTES } from "~/lib/agent/buyer/conversation.server";
import {
  approvedBuyer,
  refusalLabel,
  testBuyers,
} from "~/lib/agent/buyer/view-model.server";
import type { TurnCart } from "~/lib/agent/buyer/turn.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * The merchant's own rehearsal thread.
 *
 * A rehearsal is an ordinary conversation with `testMode` set: same tools,
 * same rules, same prices, and every write skipped. Kept in the log like any
 * other so the merchant can read back what they were shown — labelled, so it
 * can never be mistaken for a buyer's.
 */

/** The open rehearsal with this buyer, if there is one. */
export async function currentRehearsal(
  customerId: string,
  now = new Date(),
): Promise<AgentConversation | null> {
  shopScope.require("buyer agent rehearsal");

  return db.agentConversation.findFirst({
    where: {
      customerId,
      testMode: true,
      closedAt: null,
      lastMessageAt: { gte: new Date(now.getTime() - IDLE_MINUTES * 60_000) },
    },
    orderBy: { lastMessageAt: "desc" },
  });
}

/**
 * Finish this rehearsal, so the next message starts a fresh one.
 *
 * Closed rather than deleted: the merchant may want to read back what the
 * agent said before they changed a guardrail, and back-dating `lastMessageAt`
 * to make `openConversation` skip it would be a lie in a column.
 */
export async function closeRehearsal(
  customerId: string,
  now = new Date(),
): Promise<void> {
  shopScope.require("close buyer agent rehearsal");

  await db.agentConversation.updateMany({
    where: { customerId, testMode: true, closedAt: null },
    data: { closedAt: now },
  });
}

/**
 * Has any rehearsal ever been answered *by the model*?
 *
 * The pre-publish checklist's fourth item, and the test is deliberately
 * stricter than "did not fail". An off-limits subject is declined from a
 * script, before either model call — so a shop with no API key at all could
 * satisfy this item with one message the model never saw, publish, and then
 * fail every real buyer turn with `no_key`. The evidence that a turn actually
 * reached Claude is already stored on the turn: `aiModel`.
 */
export async function rehearsalCompleted(): Promise<boolean> {
  shopScope.require("buyer agent rehearsal completed");

  const count = await db.agentMessage.count({
    where: {
      role: "AGENT",
      aiModel: { not: null },
      conversation: { testMode: true },
    },
  });
  return count > 0;
}

export function cartLines(cart: TurnCart | null): TestView["cart"] {
  if (!cart) return null;

  const lines: TestCartLineView[] = cart.lines.map((line) => ({
    title: line.title,
    sku: line.sku || null,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
    rule: line.ruleSummary,
  }));

  return { lines, subtotal: cart.subtotal };
}

export async function rehearsalView(options: {
  t: Translate;
  entitled: boolean;
  requiredPlan: string | null;
  buyerId: string | null;
  /** Narrows the picker, for a shop with more approved buyers than it lists. */
  search?: string | null;
  hasKey: boolean;
  cart?: TurnCart | null;
  failure?: string | null;
  now?: Date;
}): Promise<TestView> {
  const now = options.now ?? new Date();
  const buyers = await testBuyers(options.t, { search: options.search });

  // Whatever the merchant asked for, if it is really one of their approved
  // buyers — resolved by id, not looked for in the page of names above. This
  // is the one screen that reads a buyer's terms and order history, so a
  // customer id in a query string is checked rather than trusted, and a miss
  // is reported rather than quietly answered as somebody else.
  const asked = options.buyerId ? await approvedBuyer(options.buyerId, options.t) : null;
  const notFound = Boolean(options.buyerId) && asked === null;

  const buyerId =
    asked?.customerId ?? (notFound ? null : (buyers[0]?.customerId ?? null));

  const conversation = buyerId ? await currentRehearsal(buyerId, now) : null;
  const messages = conversation
    ? await db.agentMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const turns: TestTurnView[] = messages.map((message) => ({
    role: message.role,
    text: message.text,
    refusal: message.refusal,
    refusalLabel: refusalLabel(message.refusal, options.t),
    tool: null,
  }));

  return {
    entitled: options.entitled,
    requiredPlan: options.requiredPlan,
    buyers,
    buyerId,
    buyerNotFound: notFound,
    search: options.search?.trim() ?? "",
    turns,
    cart: cartLines(options.cart ?? null),
    failure: options.failure ?? null,
    noKey: !options.hasKey,
    completed: await rehearsalCompleted(),
  };
}
