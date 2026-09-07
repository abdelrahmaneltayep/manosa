import { db, prismaBase } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import type { WebhookContext } from "~/lib/webhooks/registry";

/**
 * GDPR gives us 48h to remove personal data after an uninstall. Scheduling at
 * +47h leaves an hour of slack for a late or backed-up runner while staying
 * inside the window, and gives a merchant who reinstalls by mistake most of
 * two days to get their setup back.
 */
const PII_PURGE_DELAY_MS = 47 * 60 * 60 * 1000;

/**
 * The app has been removed from the store.
 *
 * Two things happen now and one happens later:
 *  - sessions are deleted immediately, because an access token we can no longer
 *    use is a standing credential with no purpose;
 *  - the install is tombstoned, so the app stops treating the shop as active;
 *  - the PII purge is scheduled, and cancelled if the merchant reinstalls.
 *
 * Idempotent: Shopify delivers at least once, and a merchant who uninstalls
 * twice in a row must not end up with two purge jobs.
 */
export async function handleAppUninstalled({ shop }: WebhookContext) {
  // Sessions are deliberately outside the tenant scope (they are read during
  // OAuth, before a tenant exists), so this filters by shop explicitly.
  const { count: deletedSessions } = await prismaBase.session.deleteMany({
    where: { shop },
  });

  const existing = await db.shop.findUnique({ where: { shop } });

  if (existing) {
    await db.shop.update({
      where: { shop },
      data: { uninstalledAt: existing.uninstalledAt ?? new Date() },
    });
  } else {
    // Uninstalled before any authenticated page view ever ran. Record it so the
    // purge job has something to act on.
    await db.shop.create({ data: { shop, uninstalledAt: new Date() } });
  }

  await enqueueJob({
    kind: "shop.purge_pii",
    runAt: new Date(Date.now() + PII_PURGE_DELAY_MS),
    replacePending: true,
  });

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "app.uninstalled",
    summary: `App removed from ${shop}. ${deletedSessions} session(s) revoked; personal data scheduled for deletion within 48 hours.`,
    subject: { type: "Shop", id: shop },
    metadata: { deletedSessions },
  });
}
