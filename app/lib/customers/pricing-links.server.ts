import { db } from "~/db.server";

/**
 * How many live pricing rules actually target a group's tag.
 *
 * Counted in memory rather than with a JSON query: there are tens of rules,
 * not millions, and a JSON path query that silently matches nothing would show
 * every tier as "no pricing attached" — which reads as a bug in the tier, not
 * in the count.
 */
export async function pricingRuleCountsByTag(): Promise<Map<string, number>> {
  const rules = await db.pricingRule.findMany({
    where: { status: "ACTIVE", archivedAt: null },
    select: { audience: true },
  });

  const counts = new Map<string, number>();

  for (const rule of rules) {
    const audience = rule.audience as { mode?: string; tags?: unknown };
    if (audience?.mode !== "tags" || !Array.isArray(audience.tags)) continue;

    for (const tag of audience.tags) {
      if (typeof tag !== "string") continue;
      const key = tag.trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return counts;
}
