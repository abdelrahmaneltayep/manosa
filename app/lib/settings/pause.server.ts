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

  await db.shop.update({ where: { shop }, data: { pausedAt: now } });

  // After the flag, so `activeEngineRules` already reports nothing and the two
  // cannot disagree if this throws part-way.
  const { rules } = await activeEngineRules();
  await publishRuleset(admin, rules);

  await recordAudit({
    actor,
    action: "settings.app_paused",
    summary: "Paused Mannon. Wholesale prices stopped applying; nothing was deleted.",
    subject: { type: "Shop", id: shop },
    metadata: { pausedAt: now.toISOString() },
  });

  return { pausedAt: now, ruleCount: rules.length };
}

export async function resumeApp({
  admin,
  actor,
}: {
  admin: AdminGraphql;
  actor: AuditActor;
}): Promise<PauseResult> {
  const shop = shopScope.require("resumeApp");

  await db.shop.update({ where: { shop }, data: { pausedAt: null } });

  const { rules } = await activeEngineRules();
  await publishRuleset(admin, rules);

  await recordAudit({
    actor,
    action: "settings.app_resumed",
    summary: `Resumed Mannon. ${rules.length} rule${rules.length === 1 ? "" : "s"} price at checkout again.`,
    subject: { type: "Shop", id: shop },
    metadata: { ruleCount: rules.length },
  });

  return { pausedAt: null, ruleCount: rules.length };
}
