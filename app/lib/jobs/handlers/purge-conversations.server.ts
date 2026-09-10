import { db } from "~/db.server";
import { purgeOldConversations } from "~/lib/agent/buyer/conversation.server";
import { CONVERSATION_RETENTION_DAYS } from "~/lib/agent/buyer/guardrails.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Delete Buyer Agent conversations past their retention.
 *
 * Checklist §6 says "Retention 90d". That is a promise to the merchant's buyers
 * about their own words, and a promise nothing enforces is a sentence in a
 * settings page. This is what makes it true.
 *
 * Like the other recurring work here it keeps itself alive rather than relying
 * on a scheduler this app does not have: it re-queues for tomorrow while any
 * conversation exists, and stops when the last one is gone.
 */
export async function purgeConversations({ now = new Date() } = {}) {
  const shop = shopScope.require("purgeConversations");
  const record = await db.shop.findUnique({ where: { shop } });

  if (!record) return { skipped: "no install record" as const };
  if (record.uninstalledAt) return { skipped: "uninstalled" as const };

  const deleted = await purgeOldConversations(now);

  const remaining = await db.agentConversation.count();
  if (remaining > 0) {
    await enqueueJob({
      kind: "agent.purge_conversations",
      runAt: nextRun(now),
      replacePending: true,
    });
  }

  return { deleted, remaining, retentionDays: CONVERSATION_RETENTION_DAYS };
}

/** Tomorrow, just after midnight UTC. Retention is a whole-day question. */
export function nextRun(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 15),
  );
}

/**
 * Make sure the purge is scheduled.
 *
 * Called when a conversation is opened, so a shop whose agent has just started
 * answering has a purge queued from the first message rather than from whenever
 * somebody happens to open the admin.
 */
export async function ensurePurgeScheduled(now = new Date()): Promise<void> {
  await enqueueJob({
    kind: "agent.purge_conversations",
    runAt: nextRun(now),
    replacePending: true,
  });
}
