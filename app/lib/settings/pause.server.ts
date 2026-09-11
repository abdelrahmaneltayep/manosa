import { db } from "~/db.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { activeEngineRules } from "~/lib/pricing/rules.server";
import { publishRuleset } from "~/lib/pricing/ruleset.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * The safe "turn it off" every merchant looks for.
 *
 * Checklist §8: *"pause app (rules stop applying, nothing is deleted)"*. Both
 * halves are load-bearing, and the flag on its own delivered neither.
 *
 * `pausedAt` had existed since 0.1 and was read in exactly one place — the App
 * Proxy, which refuses while paused. So pausing stopped the storefront blocks
 * and left **the discount Function still pricing at checkout**, because
 * Shopify evaluates the published ruleset metafield without asking us. A pause
 * that leaves wholesale prices live is the screen claiming something that did
 * not happen.
 *
 * Two changes make it true:
 *
 * 1. `activeEngineRules` returns nothing while paused. It is the single read
 *    behind every surface that prices in *our* code — quotes, PO-to-order,
 *    quick order, the Buyer Agent — so there is no path around it, and a rule
 *    saved while paused cannot quietly republish a live ruleset either.
 * 2. Pausing publishes an **empty** ruleset, which is the only way to reach
 *    the Function. Resuming publishes the real one back.
 *
 * Nothing is deleted at any point: every rule, price, group and order stays
 * exactly where it was, and resuming is one write plus one publish.
 */

export interface PauseResult {
  pausedAt: Date | null;
  /** How many rules checkout is pricing with after this. */
  ruleCount: number;
  /** False when the flag is set here but the publish has not landed. */
  reachedCheckout: boolean;
}

export async function pauseApp({
  admin,
  actor,
  now = new Date(),
}: {
  admin: AdminGraphql;
  actor: AuditActor;
  now?: Date;
}): Promise<PauseResult> {
  const shop = shopScope.require("pauseApp");
  const record = await db.shop.findUnique({ where: { shop } });

  // Already paused: re-pausing must not move "Paused since" to today and must
  // not write a second entry about a change that did not happen. The publish
  // still runs, because that is how an incomplete pause is retried.
  const pausedAt = record?.pausedAt ?? now;
  if (!record?.pausedAt) {
    await db.shop.update({
      where: { shop },
      data: { pausedAt, pausePublishedAt: null },
    });

    // Written before the publish, not after. The publish is the part that can
    // fail, and an app that is paused with no record of who paused it is
    // Invariant 5 broken on the most consequential control on the page.
    await recordAudit({
      actor,
      action: "settings.app_paused",
      summary: "Paused Mannon. Wholesale prices stopped applying; nothing was deleted.",
      subject: { type: "Shop", id: shop },
      metadata: { pausedAt: pausedAt.toISOString() },
    });
  }

  // Flag first, so everything in our own code has already stopped — a pause
  // that reached checkout but not the admin would mean quoting wholesale and
  // charging retail, which is the direction that costs a merchant money.
  const { rules } = await activeEngineRules();

  // A shop with no discount has nothing live at checkout to stop, and
  // publishing would *create* a discount — switching the app off is not a
  // reason to create a live object in somebody's Shopify admin.
  if (!record?.discountId) {
    // Nothing is live at checkout to stop, so the pause is complete.
    await db.shop.update({ where: { shop }, data: { pausePublishedAt: now } });
    return { pausedAt, ruleCount: 0, reachedCheckout: true };
  }

  await publishRuleset(admin, rules);
  await db.shop.update({ where: { shop }, data: { pausePublishedAt: new Date() } });
  return { pausedAt, ruleCount: rules.length, reachedCheckout: true };
}

export async function resumeApp({
  admin,
  actor,
}: {
  admin: AdminGraphql;
  actor: AuditActor;
}): Promise<PauseResult> {
  const shop = shopScope.require("resumeApp");
  const record = await db.shop.findUnique({ where: { shop } });
  if (!record?.pausedAt) return { pausedAt: null, ruleCount: 0, reachedCheckout: true };

  await db.shop.update({
    where: { shop },
    data: { pausedAt: null, pausePublishedAt: null },
  });

  try {
    const { rules } = await activeEngineRules();
    if (record.discountId) await publishRuleset(admin, rules);

    await recordAudit({
      actor,
      action: "settings.app_resumed",
      summary: `Resumed Mannon. ${rules.length} rule${rules.length === 1 ? "" : "s"} price at checkout again.`,
      subject: { type: "Shop", id: shop },
      metadata: { ruleCount: rules.length },
    });

    return { pausedAt: null, ruleCount: rules.length, reachedCheckout: true };
  } catch (error) {
    // Resume is the dangerous direction and it gets a compensating action.
    // Half a resume means our own code prices wholesale — quotes, the agent,
    // PO-to-order — while Shopify's metafield is still the empty one, so a
    // buyer is quoted one price and charged another. Better to stay paused,
    // which is a state the merchant can see and press again.
    await db.shop.update({
      where: { shop },
      data: { pausedAt: record.pausedAt, pausePublishedAt: record.pausePublishedAt },
    });
    throw error;
  }
}
