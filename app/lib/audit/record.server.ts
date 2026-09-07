import type { AuditActorType, Prisma } from "@prisma/client";

import { db } from "~/db.server";
import { tenant } from "~/lib/tenant/shop-context.server";

/** Anything that can run a Prisma write — the client, or a transaction. */
type Writer = Pick<typeof db, "auditLog">;

export interface AuditActor {
  type: AuditActorType;
  /** Staff user id, customer id, or the agent identifier. */
  id?: string | null;
  /** Display name captured now, so the entry still reads right later. */
  label?: string | null;
}

export interface AiProvenance {
  model: string;
  promptVersion: string;
  requestId?: string | null;
}

export interface AuditEntry {
  actor: AuditActor;
  /** Dotted action name, e.g. "pricing_rule.created". */
  action: string;
  /** One human sentence. This is what the merchant reads in the log. */
  summary: string;
  subject?: { type: string; id: string } | null;
  metadata?: Prisma.InputJsonValue | null;
  /** Present on every entry produced with Claude's help. */
  ai?: AiProvenance | null;
  /**
   * Set when this action changed live data on an AI suggestion. Requires an
   * approval — see the invariant below.
   */
  aiAssisted?: boolean;
  approval?: { byId: string; at?: Date } | null;
  requestId?: string | null;
  ip?: string | null;
}

export class MissingApprovalError extends Error {
  constructor(action: string) {
    super(
      `Refusing to record "${action}": it is marked aiAssisted, which means it ` +
        `changed live data on Claude's suggestion, but carries no approval. ` +
        `Claude drafts, the merchant approves — record the approving user, or ` +
        `do not mark the entry aiAssisted.`,
    );
    this.name = "MissingApprovalError";
  }
}

/**
 * Write one audit entry for the active tenant.
 *
 * Pass `client` to enlist this in the caller's transaction, which is how AI
 * write paths should use it: the mutation and its approval record commit
 * together, or neither does. A failure throws — an audit log with silent gaps
 * is worse than a failed request, because nobody finds out.
 */
export async function recordAudit(entry: AuditEntry, client: Writer = db) {
  // The engineering rule this table exists to enforce.
  if (entry.aiAssisted && !entry.approval?.byId) {
    throw new MissingApprovalError(entry.action);
  }

  return client.auditLog.create({
    data: {
      ...tenant(),
      actorType: entry.actor.type,
      actorId: entry.actor.id ?? null,
      actorLabel: entry.actor.label ?? null,
      action: entry.action,
      summary: entry.summary,
      subjectType: entry.subject?.type ?? null,
      subjectId: entry.subject?.id ?? null,
      metadata: entry.metadata ?? undefined,
      aiModel: entry.ai?.model ?? null,
      aiPromptVersion: entry.ai?.promptVersion ?? null,
      aiRequestId: entry.ai?.requestId ?? null,
      aiAssisted: entry.aiAssisted ?? false,
      approvedById: entry.approval?.byId ?? null,
      approvedAt: entry.approval ? (entry.approval.at ?? new Date()) : null,
      requestId: entry.requestId ?? null,
      ip: entry.ip ?? null,
    },
  });
}

/** Actor shorthand for webhooks, jobs and migrations. */
export const SYSTEM_ACTOR: AuditActor = { type: "SYSTEM", label: "Mannon" };
