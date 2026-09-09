import { db } from "~/db.server";
import { SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { decideOnArrival } from "~/lib/forms/decisions.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { unauthenticated } from "~/shopify.server";

/**
 * Run the auto-approval criteria over applications nobody has looked at yet.
 *
 * Separate from the form submission on purpose. A buyer pressing "send" should
 * not be waiting on the Admin API, and approving takes several calls — finding
 * or creating a customer, tagging them, publishing their checkout facts. If
 * any of that fails, the application is still sitting safely in the queue for
 * a person, which is the outcome that must never be lost.
 *
 * Claims work by `autoEvaluatedAt`, so a retry after a partial failure picks
 * up only what it did not finish.
 */

/** How many applications one run decides. Bounded: each one is several calls. */
export const DECIDE_BATCH = 25;

export type AdminForShop = (shop: string) => Promise<AdminGraphql>;

const offlineAdmin: AdminForShop = async (shop) => {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
};

export async function decideApplications(adminFor: AdminForShop = offlineAdmin) {
  const shop = shopScope.require("decideApplications");
  const record = await db.shop.findUnique({ where: { shop } });

  if (!record) return { skipped: "no install record" as const };
  if (record.uninstalledAt) return { skipped: "uninstalled" as const };

  const waiting = await db.formSubmission.findMany({
    where: { status: "PENDING", autoEvaluatedAt: null },
    orderBy: { createdAt: "asc" },
    take: DECIDE_BATCH,
    select: { id: true },
  });

  if (waiting.length === 0) return { examined: 0, approved: 0, rejected: 0, failed: 0 };

  const admin = await adminFor(shop);
  const result = { examined: 0, approved: 0, rejected: 0, failed: 0 };

  for (const { id } of waiting) {
    // Stamped before the decision, not after: a submission that throws every
    // time would otherwise be retried forever, and the queue behind it would
    // never be reached.
    await db.formSubmission.update({
      where: { id },
      data: { autoEvaluatedAt: new Date() },
    });

    try {
      const outcome = await decideOnArrival(id, { admin, actor: SYSTEM_ACTOR });
      result.examined += 1;
      if (outcome.applied === "approve") result.approved += 1;
      if (outcome.applied === "reject") result.rejected += 1;
    } catch (error) {
      result.failed += 1;
      // The application stays PENDING, which is exactly where it should be:
      // waiting for a person.
      console.error(
        `[mannon] could not auto-decide application ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return result;
}
