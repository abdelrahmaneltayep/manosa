import { db } from "~/db.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import { ARCHIVE_RETENTION_DAYS } from "~/lib/pricing/rules.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Everything else this app promised to stop keeping.
 *
 * Five tables that only ever grew. Each one had a sentence somewhere saying how
 * long it lived — "can be restored for 30 days", a one-hour undo window, a
 * thirty-day conversion rate — and nothing behind any of them. A retention
 * promise with no job is a sentence on a page, which is the shape this repo
 * keeps finding; `purgeAudit` was the same discovery at 6.5 and
 * `purgeConversations` at 5.3.
 *
 * One job rather than five. They are the same question asked of five tables,
 * they all want to run once a day, and five self-requeueing jobs is five
 * chances for one of them to quietly stop.
 *
 * The windows are chosen against what a screen still needs:
 *
 * - **Form events** feed the conversion rate over `STATS_WINDOW_DAYS` (30), so
 *   90 leaves a merchant comparing this month with the last two.
 * - **Webhook deliveries** are the idempotency record. Shopify retries a
 *   failed delivery for two days; 30 keeps a debugging window well past that.
 * - **Import drafts** hold an hour's undo. A week is already generous.
 * - **Archived rules** say "can be restored for 30 days" in the audit entry
 *   the merchant reads. Without this they were restorable for ever, which
 *   makes that sentence false — and the archived tab grows without limit.
 * - **Messages to buyers** are the one item here that is somebody's personal
 *   data rather than this app's bookkeeping. Twelve months, the same as the
 *   audit log, and stated in Settings beside the uninstall policy.
 */

export const RETENTION_DAYS = {
  webhookDeliveries: 30,
  formEvents: 90,
  importDrafts: 7,
  archivedRules: ARCHIVE_RETENTION_DAYS,
} as const;

/** The one window measured in months, because it is stated in months. */
export const EMAIL_RETENTION_MONTHS = 12;

const DAY = 86_400_000;
const cutoff = (now: Date, days: number) => new Date(now.getTime() - days * DAY);

export function emailCutoff(now: Date): Date {
  // Calendar months, like the audit log's: across 29 February a fixed-day
  // window is a day short of the promise, and the promise is the sentence.
  const at = new Date(now);
  at.setUTCMonth(at.getUTCMonth() - EMAIL_RETENTION_MONTHS);
  return at;
}

export interface RetentionResult {
  webhookDeliveries: number;
  formEvents: number;
  importDrafts: number;
  archivedRules: number;
  emails: number;
}

export async function purgeRetention({ now = new Date() } = {}) {
  const shop = shopScope.require("purgeRetention");
  const record = await db.shop.findUnique({ where: { shop } });

  if (!record) return { skipped: "no install record" as const };
  // An uninstalled shop's rows belong to the PII purge, which takes them all.
  if (record.uninstalledAt) return { skipped: "uninstalled" as const };

  // Queued first and unconditionally: returning early before the re-queue is
  // how recurring work stops for good — the lesson the briefing job learned.
  await enqueueJob({
    kind: "retention.purge",
    runAt: nextRun(now),
    replacePending: true,
  });

  const [webhookDeliveries, formEvents, importDrafts, archivedRules, emails] =
    await Promise.all([
      db.webhookDelivery.deleteMany({
        where: { receivedAt: { lt: cutoff(now, RETENTION_DAYS.webhookDeliveries) } },
      }),
      db.formEvent.deleteMany({
        where: { at: { lt: cutoff(now, RETENTION_DAYS.formEvents) } },
      }),
      db.ruleImportDraft.deleteMany({
        where: { createdAt: { lt: cutoff(now, RETENTION_DAYS.importDrafts) } },
      }),
      // Only the archived ones, and only past the window the merchant was
      // told about. An active rule is never touched by a retention sweep.
      db.pricingRule.deleteMany({
        where: { archivedAt: { lt: cutoff(now, RETENTION_DAYS.archivedRules) } },
      }),
      db.emailMessage.deleteMany({ where: { createdAt: { lt: emailCutoff(now) } } }),
    ]);

  const result: RetentionResult = {
    webhookDeliveries: webhookDeliveries.count,
    formEvents: formEvents.count,
    importDrafts: importDrafts.count,
    archivedRules: archivedRules.count,
    emails: emails.count,
  };

  return result;
}

/** Tomorrow, just after midnight UTC. Retention is a whole-day question. */
export function nextRun(now: Date): Date {
  const next = new Date(now);
  next.setUTCHours(0, 15, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/**
 * Make sure this shop has a retention sweep queued.
 *
 * Called from the Settings page, which is where the windows are stated — so a
 * shop that installed before this shipped starts enforcing them the first time
 * somebody reads the promise.
 */
export async function ensureRetentionScheduled(now = new Date()): Promise<void> {
  shopScope.require("ensureRetentionScheduled");

  const queued = await db.scheduledJob.count({
    where: { kind: "retention.purge", status: "PENDING" },
  });
  if (queued > 0) return;

  await enqueueJob({
    kind: "retention.purge",
    runAt: nextRun(now),
    replacePending: true,
  });
}
