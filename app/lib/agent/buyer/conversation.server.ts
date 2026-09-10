import type { AgentConversation, AgentOutcome, AgentRole, Prisma } from "@prisma/client";

import { db } from "~/db.server";
import { CONVERSATION_RETENTION_DAYS } from "~/lib/agent/buyer/guardrails.server";
import type { ToolResult } from "~/lib/agent/buyer/tools.server";
import { ensurePurgeScheduled } from "~/lib/jobs/handlers/purge-conversations.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";

/**
 * Where a conversation lives.
 *
 * Kept because the merchant has to be able to read what their agent told their
 * buyers — that is the whole of the checklist's conversation log, and an agent
 * nobody can audit is one nobody should publish. Kept for ninety days and not a
 * day longer, because a wholesale buyer's chat is their business.
 */

/** Turns of history handed back to the model. */
export const HISTORY_LIMIT = 8;

/** A conversation this old is finished, and a new message starts a new one. */
export const IDLE_MINUTES = 60;

export interface TurnRecord {
  role: AgentRole;
  text: string;
  /** Typed as Prisma's own JSON input, so nothing has to be cast at the call. */
  toolCalls?: Prisma.InputJsonValue;
  refusal?: string | null;
  ai?: { model: string; promptVersion: string; requestId: string | null } | null;
}

/**
 * The conversation this message belongs to.
 *
 * One per buyer per idle window: a buyer who comes back the next morning gets a
 * fresh thread rather than a transcript stretching back a month, and the log
 * reads as separate errands, which is what they were.
 */
export async function openConversation(options: {
  customerId: string | null;
  company: string | null;
  locale: string;
  now?: Date;
}): Promise<AgentConversation> {
  const now = options.now ?? new Date();
  shopScope.require("buyer agent conversation");

  const since = new Date(now.getTime() - IDLE_MINUTES * 60_000);
  const existing = options.customerId
    ? await db.agentConversation.findFirst({
        where: { customerId: options.customerId, lastMessageAt: { gte: since } },
        orderBy: { lastMessageAt: "desc" },
      })
    : null;

  if (existing) return existing;

  const conversation = await db.agentConversation.create({
    data: {
      ...tenant(),
      customerId: options.customerId,
      company: options.company,
      locale: options.locale,
      startedAt: now,
      lastMessageAt: now,
    },
  });

  // Retention starts being enforced from the first conversation, not from
  // whenever somebody next opens the admin. Idempotent: `replacePending`.
  await ensurePurgeScheduled(now);
  return conversation;
}

export async function appendTurn(
  conversationId: string,
  turn: TurnRecord,
  options: { now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();

  await db.$transaction(async (tx) => {
    await tx.agentMessage.create({
      data: {
        ...tenant(),
        conversationId,
        role: turn.role,
        text: turn.text,
        toolCalls: turn.toolCalls,
        refusal: turn.refusal ?? null,
        aiModel: turn.ai?.model ?? null,
        aiPromptVersion: turn.ai?.promptVersion ?? null,
        aiRequestId: turn.ai?.requestId ?? null,
        createdAt: now,
      },
    });

    await tx.agentConversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: now },
    });
  });
}

/**
 * What the outcome chip says.
 *
 * The strongest thing that happened wins: a conversation that built a cart and
 * also answered a question is a cart. A refusal only wins when nothing else
 * did, so a buyer who was declined once and then helped reads as helped.
 */
export function outcomeFor(result: ToolResult): AgentOutcome {
  if (result.refusal) return result.tool === "decline" ? "DECLINED" : "ANSWERED";
  switch (result.tool) {
    case "build_cart":
      return "CART";
    case "request_quote":
      return "QUOTE";
    case "escalate":
      return "ESCALATED";
    case "decline":
      return "DECLINED";
    default:
      return "ANSWERED";
  }
}

const RANK: Record<AgentOutcome, number> = {
  DECLINED: 0,
  ANSWERED: 1,
  ESCALATED: 2,
  QUOTE: 3,
  CART: 4,
};

export async function recordOutcome(
  conversationId: string,
  outcome: AgentOutcome,
): Promise<void> {
  const current = await db.agentConversation.findUnique({
    where: { id: conversationId },
    select: { outcome: true },
  });
  if (!current) return;
  if (RANK[current.outcome] >= RANK[outcome]) return;

  await db.agentConversation.update({
    where: { id: conversationId },
    data: { outcome },
  });
}

/**
 * How many turns this buyer has taken lately.
 *
 * The ceiling is per buyer rather than per shop: one buyer cannot spend the
 * merchant's whole model budget, and neither can a script pointed at the
 * endpoint. A decision, so it lives here rather than in the route — a rule
 * inside a Remix action is a rule this environment cannot test.
 */
export const TURN_LIMIT = 20;
export const TURN_WINDOW_MS = 10 * 60_000;

export async function overTurnLimit(
  customerId: string,
  options: { now?: Date; limit?: number } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const turns = await db.agentMessage.count({
    where: {
      role: "BUYER",
      createdAt: { gte: new Date(now.getTime() - TURN_WINDOW_MS) },
      conversation: { customerId },
    },
  });
  return turns >= (options.limit ?? TURN_LIMIT);
}

/** The last few turns, oldest first, for the model's context. */
export async function historyFor(
  conversationId: string,
): Promise<{ role: string; text: string }[]> {
  const rows = await db.agentMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, text: true },
  });

  return rows.reverse().map((row) => ({ role: row.role.toLowerCase(), text: row.text }));
}

/**
 * Delete conversations past their retention.
 *
 * Messages go with them by cascade. Run from the daily job runner; also the
 * thing that makes "Retention 90d" a fact rather than a sentence in a settings
 * page.
 */
export async function purgeOldConversations(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CONVERSATION_RETENTION_DAYS * 86_400_000);
  const { count } = await db.agentConversation.deleteMany({
    where: { lastMessageAt: { lt: cutoff } },
  });
  return count;
}
