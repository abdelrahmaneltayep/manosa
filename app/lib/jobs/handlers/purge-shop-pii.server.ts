import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Remove merchant PII after an uninstall (GDPR — within 48h of the app being
 * removed; scheduled at +47h so a late runner still lands inside the window).
 *
 * Skipped if the shop has been reinstalled in the meantime: `uninstalledAt` is
 * cleared on reinstall, and deleting a live merchant's data would be far worse
 * than keeping a stale row.
 *
 * The install record itself is kept — it holds no personal data once the
 * contact fields are cleared, and it is what lets a reinstall restore the
 * previous setup.
 */
export async function purgeShopPii() {
  const shop = shopScope.require("purgeShopPii");
  const record = await db.shop.findUnique({ where: { shop } });

  if (!record) return { skipped: "no install record" as const };
  if (!record.uninstalledAt) return { skipped: "reinstalled" as const };
  if (record.piiPurgedAt) return { skipped: "already purged" as const };

  const [, redactedAudit, deletedConversations] = await db.$transaction([
    db.shop.update({
      where: { shop },
      data: { name: null, email: null, piiPurgedAt: new Date() },
    }),
    // Keep the audit trail's shape — who did what, when — without the
    // identifiers that make it personal data.
    db.auditLog.updateMany({
      where: { shop },
      data: { actorId: null, actorLabel: null, ip: null },
    }),
    // Buyer Agent conversations are a buyer's own words to a merchant who no
    // longer has this app. Deleted rather than redacted: there is nothing left
    // in them worth keeping once the names are gone, and the messages go with
    // them by cascade.
    db.agentConversation.deleteMany({ where: { shop } }),
  ]);

  // Defence in depth: sessions are deleted the moment the uninstall webhook
  // lands, so this should always be zero.
  const sessions = await db.$executeRaw`DELETE FROM "Session" WHERE "shop" = ${shop}`;

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "shop.pii_purged",
    summary: `Removed merchant contact details, redacted ${redactedAudit.count} audit entries and deleted ${deletedConversations.count} agent conversations after uninstall.`,
    subject: { type: "Shop", id: shop },
    metadata: {
      redactedAuditEntries: redactedAudit.count,
      deletedSessions: sessions,
      deletedConversations: deletedConversations.count,
    },
  });

  return {
    redactedAuditEntries: redactedAudit.count,
    deletedSessions: sessions,
    deletedConversations: deletedConversations.count,
  };
}
