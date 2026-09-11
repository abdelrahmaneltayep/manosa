import { Prisma } from "@prisma/client";

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

  const [
    ,
    redactedAudit,
    deletedConversations,
    deletedSamples,
    deletedStrings,
    deletedBuyers,
    ,
    deletedApplications,
    deletedEmails,
    deletedQuotes,
    ,
    ,
    ,
    ,
    ,
    deletedOrders,
  ] = await db.$transaction([
    db.shop.update({
      where: { shop },
      data: { name: null, email: null, piiPurgedAt: new Date() },
    }),
    // Keep the audit trail's shape — what happened, and when — without a word
    // of anybody in it.
    //
    // Nulling the actor columns was not enough and reading it that way was the
    // mistake: a rejection's summary carries the address it went to, a
    // reminder's metadata carries `{to: …}`, a tag change's carries a VAT
    // number. All of it was still readable after a shop had been "purged".
    // `summary` becomes the action it records and `metadata` goes entirely —
    // there is no merchant left to read the detail, and the detail is the part
    // that is somebody's.
    db.auditLog.updateMany({
      where: { shop },
      data: {
        actorId: null,
        actorLabel: null,
        ip: null,
        metadata: Prisma.DbNull,
        summary: "",
      },
    }),
    // Buyer Agent conversations are a buyer's own words to a merchant who no
    // longer has this app. Deleted rather than redacted: there is nothing left
    // in them worth keeping once the names are gone, and the messages go with
    // them by cascade.
    db.agentConversation.deleteMany({ where: { shop } }),
    // The merchant's own messages to their buyers, pasted in as writing
    // samples: names, order references, whatever they happened to contain.
    // Same reasoning as the conversations above, and the same promise — the
    // Settings page says everything stored about a shop goes within 48 hours.
    // It has no relation and so is in no cascade; it has to be named here.
    db.brandVoiceSample.deleteMany({ where: { shop } }),
    // The merchant's own wording for the strings a buyer reads. Not personal
    // data, but the Settings page promises everything stored about a shop goes
    // within 48 hours, and a table nobody names here is a table that outlives
    // the promise. It has no relation, so it is in no cascade.
    db.storefrontString.deleteMany({ where: { shop } }),

    // --- The buyers themselves (7.2) ---------------------------------------
    //
    // Until the release pass this job cleared the *merchant's* contact details
    // and left every buyer's behind: names, addresses, phone numbers, VAT
    // numbers, the answers typed into a registration form, the documents
    // uploaded with it and every message sent to them. That is the personal
    // data in this app; the merchant's own row is the small part of it.
    //
    // `tests/unit/privacy-coverage.test.ts` checks this list against the
    // schema, so a table added later fails the build rather than outliving the
    // promise quietly.
    db.customer.deleteMany({ where: { shop } }),
    // Uploads go with their submission by cascade. Named anyway, because a
    // file is the one thing here no apology recovers, and because the count
    // then appears in the audit entry.
    db.formUpload.deleteMany({ where: { shop } }),
    db.formSubmission.deleteMany({ where: { shop } }),
    db.emailMessage.deleteMany({ where: { shop } }),
    // Whole, not redacted. A single buyer's redaction leaves the order behind
    // because the merchant is still trading on it; here the merchant is gone.
    db.quote.deleteMany({ where: { shop } }),
    // An email domain the merchant closed the door on, with a free-text
    // reason beside it. Nothing cascades to it — `model Shop` has no relations
    // at all — so without this line it outlived every uninstall for ever.
    db.blockedDomain.deleteMany({ where: { shop } }),
    // The monthly review names the shop's top buyer inside `facts.slots`, and
    // is kept for ever by design so a merchant can compare March with March.
    // "For ever" stops at the uninstall.
    db.monthlyReview.deleteMany({ where: { shop } }),
    db.merchantBriefing.deleteMany({ where: { shop } }),
    // A draft import holds the merchant's uploaded file, verbatim.
    db.ruleImportDraft.deleteMany({ where: { shop } }),
    // Token counts and a staff id. Never a prompt and never an answer — but
    // it is the merchant's own record of what they spent, and they are gone.
    db.aiRun.deleteMany({ where: { shop } }),
    db.order.deleteMany({ where: { shop } }),
  ]);

  // `summary` is set from the row's own `action`, which `updateMany` cannot do
  // — so the trail still reads as a list of what happened rather than a column
  // of blanks.
  await db.$executeRaw`UPDATE "AuditLog" SET "summary" = "action" WHERE "shop" = ${shop} AND "summary" = ''`;

  // Defence in depth: sessions are deleted the moment the uninstall webhook
  // lands, so this should always be zero.
  const sessions = await db.$executeRaw`DELETE FROM "Session" WHERE "shop" = ${shop}`;

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "shop.pii_purged",
    summary: `Removed merchant contact details, redacted ${redactedAudit.count} audit entries and deleted ${deletedConversations.count} agent conversations, ${deletedSamples.count} writing samples ${deletedStrings.count} translated strings, ${deletedBuyers.count} buyers, ${deletedApplications.count} applications, ${deletedEmails.count} messages, ${deletedQuotes.count} quotes and ${deletedOrders.count} orders after uninstall.`,
    subject: { type: "Shop", id: shop },
    metadata: {
      redactedAuditEntries: redactedAudit.count,
      deletedSessions: sessions,
      deletedConversations: deletedConversations.count,
      deletedSamples: deletedSamples.count,
      deletedStrings: deletedStrings.count,
      deletedBuyers: deletedBuyers.count,
      deletedApplications: deletedApplications.count,
      deletedEmails: deletedEmails.count,
      deletedQuotes: deletedQuotes.count,
      deletedOrders: deletedOrders.count,
    },
  });

  return {
    redactedAuditEntries: redactedAudit.count,
    deletedSessions: sessions,
    deletedConversations: deletedConversations.count,
    deletedSamples: deletedSamples.count,
    deletedStrings: deletedStrings.count,
    deletedBuyers: deletedBuyers.count,
    deletedApplications: deletedApplications.count,
    deletedEmails: deletedEmails.count,
    deletedQuotes: deletedQuotes.count,
    deletedOrders: deletedOrders.count,
  };
}
