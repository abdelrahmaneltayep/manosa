import type { AgentConversation, AgentMessage, AgentOutcome } from "@prisma/client";

import { db } from "~/db.server";
import { recordOutcome } from "~/lib/agent/buyer/conversation.server";
import { recordAudit } from "~/lib/audit/record.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";

/**
 * What the merchant reads afterwards.
 *
 * The conversation log is the reason it is defensible to publish this thing at
 * all: an agent that talks to a merchant's customers, on the merchant's domain,
 * in the merchant's name, and cannot be read afterwards is one nobody should
 * switch on. So every turn is here — including the ones that failed, and the
 * sentence the model actually wrote beside the one the buyer read.
 */

export const LOG_PAGE_SIZE = 20;

export const OUTCOMES: AgentOutcome[] = [
  "CART",
  "QUOTE",
  "ANSWERED",
  "ESCALATED",
  "DECLINED",
  "FAILED",
];

export const isOutcome = (value: string): value is AgentOutcome =>
  (OUTCOMES as string[]).includes(value);

export interface LogPage {
  rows: (AgentConversation & { turns: number })[];
  total: number;
  page: number;
  pageCount: number;
  /** True when this shop has never had a conversation at all. */
  neverAny: boolean;
}

/**
 * One page of conversations, newest first.
 *
 * Ordinary offset paging: one table, one order, and a merchant reading their
 * own log is not racing anybody. (The activity feed needs a cursor because it
 * merges two tables; this does not.)
 */
export async function listConversations(
  options: {
    page?: number;
    pageSize?: number;
    outcome?: AgentOutcome | null;
    search?: string | null;
  } = {},
): Promise<LogPage> {
  shopScope.require("agent conversation log");

  const pageSize = options.pageSize ?? LOG_PAGE_SIZE;
  const page = Math.max(1, options.page ?? 1);
  const search = options.search?.trim();

  const where = {
    ...(options.outcome ? { outcome: options.outcome } : {}),
    ...(search
      ? {
          OR: [
            { company: { contains: search, mode: "insensitive" as const } },
            { customerId: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [total, neverAny, rows] = await Promise.all([
    db.agentConversation.count({ where }),
    db.agentConversation.count(),
    db.agentConversation.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { messages: true } } },
    }),
  ]);

  return {
    rows: rows.map(({ _count, ...row }) => ({ ...row, turns: _count.messages })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    neverAny: neverAny === 0,
  };
}

export interface Transcript {
  conversation: AgentConversation;
  messages: AgentMessage[];
}

export async function readConversation(id: string): Promise<Transcript | null> {
  shopScope.require("agent transcript");

  const conversation = await db.agentConversation.findUnique({ where: { id } });
  if (!conversation) return null;

  return {
    conversation,
    messages: await db.agentMessage.findMany({
      where: { conversationId: id },
      // Insertion, not `createdAt`: both halves of a turn share one timestamp.
      orderBy: { seq: "asc" },
    }),
  };
}

/**
 * A person joins the conversation.
 *
 * From this moment the agent stops answering — `answerBuyerTurn` checks
 * `takenOverAt` before it does anything — and the buyer is told a person has
 * joined rather than being left wondering why the replies stopped.
 */
export async function takeOver(id: string, actorId: string | null): Promise<void> {
  shopScope.require("take over conversation");

  const conversation = await db.agentConversation.findUnique({ where: { id } });
  if (!conversation) throw new Response("Conversation not found", { status: 404 });
  // There is nobody on the other end of a rehearsal to hand to.
  if (conversation.testMode) {
    throw new Response("Cannot take over a test conversation", { status: 409 });
  }
  if (conversation.takenOverAt) return;

  const now = new Date();
  await db.$transaction(async (tx) => {
    // Conditional on the row still being un-taken-over, and the announcement
    // is written only if this call is the one that won. A read-then-write here
    // announced twice and audited twice on a double-click.
    const claimed = await tx.agentConversation.updateMany({
      where: { id, takenOverAt: null },
      data: { takenOverAt: now, takenOverBy: actorId },
    });
    if (claimed.count !== 1) return;

    // The agent announces the human, in the transcript, so the buyer's next
    // view of the thread says who they are talking to. Written as real text
    // rather than an empty row with a reason: an empty agent turn is how this
    // app records a turn nobody could answer, and the transcript renders it
    // that way.
    await tx.agentMessage.create({
      data: {
        ...tenant(),
        conversationId: id,
        role: "AGENT",
        text: TAKEN_OVER_TEXT,
        refusal: "taken_over",
        createdAt: now,
      },
    });

    await recordAudit(
      {
        actor: { type: "STAFF", id: actorId },
        action: "agent.taken_over",
        summary: `Took over the Buyer Agent's conversation with ${
          conversation.company ?? conversation.customerId ?? "a visitor"
        }.`,
        subject: { type: "AgentConversation", id },
      },
      tx,
    );
  });

  // Outside the claim, and through `recordOutcome`, whose whole job is that the
  // strongest thing that happened wins. Setting ESCALATED directly made the log
  // say no cart was built in a conversation that built one.
  await recordOutcome(id, "ESCALATED");
}

/**
 * What the transcript shows where a person joined.
 *
 * Stored in English on the row because it is a record of an event, not a
 * message anyone reads in their own language — the *buyer* is told a person
 * joined by the widget, in the widget's locale (`agent.takenOver` in the theme
 * catalogue). The merchant's transcript renders this row through
 * `agent.transcript.joined`, so the marker here is never what they read.
 */
export const TAKEN_OVER_TEXT = "A person joined this conversation.";

/** As long as a merchant's reply may be. Refused past this, never truncated. */
export const MAX_REPLY_CHARS = 2_000;

export class ReplyTooLongError extends Error {
  constructor(readonly length: number) {
    super(`Reply is ${length} characters; the limit is ${MAX_REPLY_CHARS}.`);
    this.name = "ReplyTooLongError";
  }
}

/** A merchant's own reply, typed into the transcript. */
export async function replyAsMerchant(
  id: string,
  text: string,
  actorId: string | null,
): Promise<void> {
  shopScope.require("reply as merchant");

  const message = text.trim();
  if (message === "") throw new Response("Nothing to send", { status: 422 });
  // Refused rather than silently shortened. A merchant who typed 2,500
  // characters, pressed Send and saw "Sent" had 500 of them thrown away.
  if (message.length > MAX_REPLY_CHARS) {
    throw new ReplyTooLongError(message.length);
  }

  const conversation = await db.agentConversation.findUnique({ where: { id } });
  if (!conversation) throw new Response("Conversation not found", { status: 404 });
  if (conversation.testMode) {
    throw new Response("Cannot reply to a test conversation", { status: 409 });
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.agentMessage.create({
      data: {
        ...tenant(),
        conversationId: id,
        role: "MERCHANT",
        text: message,
        createdAt: now,
      },
    });
    await tx.agentConversation.update({
      where: { id },
      data: {
        lastMessageAt: now,
        // Replying is taking over, whether or not the button was pressed
        // first: the agent must not answer over a person mid-thread.
        ...(conversation.takenOverAt ? {} : { takenOverAt: now, takenOverBy: actorId }),
      },
    });
  });

  // Ranked, for the same reason as `takeOver`: a conversation that built a cart
  // and was then answered by a person still built a cart.
  if (!conversation.takenOverAt) await recordOutcome(id, "ESCALATED");
}

/* -------------------------------------------------------------------------- */

/** As many turns as one export carries. Ninety days of a busy shop is more. */
export const EXPORT_LIMIT = 20_000;

export interface ExportResult {
  csv: string;
  rows: number;
  /** True when the shop has more turns than one export can carry. */
  truncated: boolean;
}

/**
 * One CSV row per turn: the checklist's "export CSV".
 *
 * Two things it now does that it did not. It honours the filters the merchant
 * had on when they pressed the link — an Export button inside a filter toolbar
 * that exports everything reads as a filtered export and is not one. And it is
 * bounded: every message of every conversation, joined into one string in
 * memory, fails as a timeout on the merchant's download exactly when their shop
 * is busy enough for the export to matter.
 */
export async function exportConversations(
  options: { outcome?: AgentOutcome | null; search?: string | null } = {},
): Promise<ExportResult> {
  shopScope.require("export conversations");

  const search = options.search?.trim();
  const conversation = {
    ...(options.outcome ? { outcome: options.outcome } : {}),
    ...(search
      ? {
          OR: [
            { company: { contains: search, mode: "insensitive" as const } },
            { customerId: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const rows = await db.agentMessage.findMany({
    where: Object.keys(conversation).length > 0 ? { conversation } : {},
    orderBy: { seq: "asc" },
    take: EXPORT_LIMIT + 1,
    include: { conversation: true },
  });

  const truncated = rows.length > EXPORT_LIMIT;
  if (truncated) rows.length = EXPORT_LIMIT;

  const header = [
    "conversation",
    "at",
    "buyer",
    "outcome",
    // A rehearsal is labelled here too. A merchant reading this file in a
    // spreadsheet has none of the screen's chips to go on.
    "test",
    "role",
    "text",
    "refusal",
    "model",
  ];

  const lines = rows.map((row) =>
    [
      row.conversationId,
      row.createdAt.toISOString(),
      row.conversation.company ?? row.conversation.customerId ?? "",
      row.conversation.outcome,
      row.conversation.testMode ? "yes" : "no",
      row.role,
      row.text,
      row.refusal ?? "",
      row.aiModel ?? "",
    ]
      .map(csvCell)
      .join(","),
  );

  return { csv: [header.join(","), ...lines].join("\n"), rows: lines.length, truncated };
}

/**
 * One CSV cell.
 *
 * Quoted always, and a leading `=`, `+`, `-` or `@` prefixed with an
 * apostrophe: a buyer's message is untrusted text, and a spreadsheet reads a
 * cell starting with one of those as a formula.
 */
function csvCell(value: string): string {
  const risky = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${risky.replace(/"/g, '""')}"`;
}
