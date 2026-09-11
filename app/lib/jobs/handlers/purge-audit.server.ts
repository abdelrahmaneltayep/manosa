import { db } from "~/db.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Delete audit entries past their retention.
 *
 * Checklist §8, on the audit log: **"Retention 12 months."** The schema's own
 * comment on `AuditLog` has promised it since 0.2 and nothing enforced it —
 * `purgeConversations` existed for `AgentMessage`, and the audit table just
 * grew. A retention promise with no job behind it is a sentence on a settings
 * page, which is the shape this repo keeps finding.
 *
 * Twelve months is a floor as well as a ceiling: it is how far back a merchant
 * can answer "who changed this price", so the page says the date rather than
 * leaving them to guess how much history they still have.
 *
 * Self-requeueing, like the other recurring work here, because this app has no
 * external scheduler.
 */

export const AUDIT_RETENTION_DAYS = 365;

/** The oldest entry this shop still has, after a purge would run. */
export function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export async function purgeAudit({ now = new Date() } = {}) {
  const shop = shopScope.require("purgeAudit");
  const record = await db.shop.findUnique({ where: { shop } });

  if (!record) return { skipped: "no install record" as const };
  // An uninstalled shop's rows are the PII purge's business, not this job's.
  if (record.uninstalledAt) return { skipped: "uninstalled" as const };

  // Queued first and unconditionally, for the reason the briefing learned:
  // returning early before the re-queue is how recurring work stops for good.
  await enqueueJob({
    kind: "audit.purge",
    runAt: nextRun(now),
    replacePending: true,
  });

  const { count } = await db.auditLog.deleteMany({
    where: { createdAt: { lt: retentionCutoff(now) } },
  });

  return { deleted: count, retentionDays: AUDIT_RETENTION_DAYS };
}

/** Tomorrow, just after midnight UTC. Retention is a whole-day question. */
export function nextRun(now: Date): Date {
  const next = new Date(now);
  next.setUTCHours(0, 5, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/**
 * Make sure this shop has a purge queued.
 *
 * Called from the activity log, which is the page that states the retention —
 * so a shop that installed before this shipped starts enforcing it the first
 * time somebody reads their own history.
 */
export async function ensureAuditPurgeScheduled(now = new Date()): Promise<void> {
  shopScope.require("ensureAuditPurgeScheduled");

  const queued = await db.scheduledJob.count({
    where: { kind: "audit.purge", status: "PENDING" },
  });
  if (queued > 0) return;

  await enqueueJob({ kind: "audit.purge", runAt: nextRun(now), replacePending: true });
}
