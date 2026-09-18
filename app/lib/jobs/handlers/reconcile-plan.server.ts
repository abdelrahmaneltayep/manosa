import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import { publishLimits } from "~/lib/orders/limits.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { activeEngineRules } from "~/lib/pricing/rules.server";
import { publishRuleset } from "~/lib/pricing/ruleset.server";
import { publishBuyerTerms } from "~/lib/terms/ledger.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { unauthenticated } from "~/shopify.server";

/**
 * Make the plan true at checkout, after it changes.
 *
 * Three capabilities reach a buyer through a metafield this app writes rather
 * than through any code path a gate can stand in front of: the pricing ruleset
 * the discount Function reads, the order limits the validation Function reads,
 * and the net terms the payment customization reads. Shopify evaluates all
 * three without asking us.
 *
 * So gating the *admin* stopped none of them. A merchant who cancelled kept
 * every rule pricing, every minimum blocking and every buyer's "pay in 30
 * days" on offer — for ever — while the Plans page said "Paid features are
 * paused" and `recordPayment` refused to let them record the money coming in
 * against invoices this app was still issuing. The credit half ran and the
 * collection half stopped.
 *
 * This is the other half of the fix. The publishers now each ask what the
 * effective plan allows; this is what makes them run at the moment the answer
 * changes, in both directions — a downgrade withdraws, and resubscribing puts
 * everything back. **Nothing is deleted at any point:** every rule, limit,
 * invoice and due date stays exactly where it is, and the shop gets all of it
 * back by paying again.
 *
 * Buyers are paged like the backfills, with the cursor on the shop row: a
 * request-triggered runner has a timeout, and a sweep that tries to do a whole
 * customer base in one go finishes none of it.
 */
export type AdminForShop = (shop: string) => Promise<AdminGraphql>;

const offlineAdmin: AdminForShop = async (shop) => {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
};

/** How many buyers one run republishes. Exported for the tests to assert on. */
export const RECONCILE_PAGE_SIZE = 50;

export async function reconcilePlan(adminFor: AdminForShop = offlineAdmin) {
  const shop = shopScope.require("reconcilePlan");
  const record = await db.shop.findUnique({ where: { shop } });

  if (!record) return { skipped: "no install record" as const };
  if (record.uninstalledAt) return { skipped: "uninstalled" as const };

  const admin = await adminFor(shop);
  const entitlements = await loadEntitlements();

  // The first run of a reconcile does the two single-metafield surfaces; the
  // cursor means the later pages are buyers only.
  let pausedRules = 0;
  if (!record.planReconcileCursor) {
    // Only where a discount exists. Publishing would *create* one, and a plan
    // change is not a reason to put a live object in somebody's Shopify admin.
    if (record.discountId) {
      const { rules, pausedByPlan } = await activeEngineRules();
      pausedRules = pausedByPlan;
      await publishRuleset(admin, rules);
    }
    await publishLimits(admin);
  }

  // Buyers whose terms have to be withdrawn or restored. Their own days, or
  // their group's — a buyer with neither has no terms metafield to change.
  const page = await db.customer.findMany({
    where: {
      // A buyer deleted in Shopify has no metafield to change.
      deletedInShopifyAt: null,
      OR: [{ netTermsDays: { not: null } }, { group: { netTermsDays: { not: null } } }],
    },
    include: { group: true },
    orderBy: { id: "asc" },
    take: RECONCILE_PAGE_SIZE + 1,
    ...(record.planReconcileCursor
      ? { cursor: { id: record.planReconcileCursor }, skip: 1 }
      : {}),
  });

  const buyers = page.slice(0, RECONCILE_PAGE_SIZE);
  for (const buyer of buyers) {
    await publishBuyerTerms(admin, buyer);
  }

  const more = page.length > RECONCILE_PAGE_SIZE;
  if (more) {
    await db.shop.update({
      where: { shop },
      data: { planReconcileCursor: buyers[buyers.length - 1]!.id },
    });
    // Immediately: the next page is due now, not on some interval.
    await enqueueJob({ kind: "billing.reconcile", runAt: new Date() });
    return { buyers: buyers.length, done: false, pausedRules };
  }

  await db.shop.update({
    where: { shop },
    data: { planReconcileCursor: null, planReconciledAt: new Date() },
  });

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "billing.plan_reconciled",
    summary: summarise(entitlements.effectivePlan, pausedRules, entitlements),
    subject: { type: "Shop", id: shop },
    metadata: {
      effectivePlan: entitlements.effectivePlan,
      pausedRules,
      orderLimits: hasFeature(entitlements, "order_limits"),
      netTerms: hasFeature(entitlements, "net_terms"),
    },
  });

  return { buyers: buyers.length, done: true, pausedRules };
}

/**
 * What changed at checkout, in the merchant's terms.
 *
 * Named rather than implied: "paid features are paused" is a sentence a
 * merchant cannot check. How many rules stopped pricing is one they can.
 */
function summarise(
  plan: string,
  pausedRules: number,
  entitlements: { features: readonly string[] },
): string {
  const paused: string[] = [];
  if (pausedRules > 0) {
    paused.push(`${pausedRules} pricing rule${pausedRules === 1 ? "" : "s"}`);
  }
  if (!entitlements.features.includes("order_limits")) paused.push("order limits");
  if (!entitlements.features.includes("net_terms")) paused.push("net terms");

  if (paused.length === 0) {
    return `Checkout is up to date with the ${plan} plan. Nothing is paused.`;
  }
  return (
    `Checkout is up to date with the ${plan} plan. Paused, and not deleted: ` +
    `${paused.join(", ")}. Resubscribing puts all of it back.`
  );
}
