import {
  guardMargins,
  type MarginGuardReport,
  type PricingRule,
} from "@mannon/pricing-engine";

import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { fetchMarginCandidates } from "~/lib/pricing/catalog.server";

/**
 * The margin guard: would this rule sell anything below cost?
 *
 * Deterministic end to end. Claude drafts a rule; this reads real prices and
 * real costs from Shopify and runs them through the same engine checkout runs,
 * so the warning a merchant sees is arithmetic they can check rather than an
 * opinion they have to trust.
 *
 * It never blocks a save. A store that has never entered a cost, or a Shopify
 * read that fails, produces "could not check" — which the card says out loud,
 * because a guard that quietly reports nothing is indistinguishable from a
 * guard that found nothing.
 */

export interface MarginGuardResult {
  status: "checked" | "unavailable";
  report: MarginGuardReport | null;
  /** True when the rule covers more than the guard priced. */
  sampled: boolean;
  /** Operator-facing reason the check could not run. */
  detail: string | null;
}

export async function checkMargins(
  admin: AdminGraphql,
  rule: PricingRule,
  options: { currencyCode: string; now: Date },
): Promise<MarginGuardResult> {
  try {
    const { candidates, sampled } = await fetchMarginCandidates(
      admin,
      rule.targets,
      options.currencyCode,
    );

    return {
      status: "checked",
      report: guardMargins(rule, candidates, options),
      sampled,
      detail: null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Loud in the logs, honest on the screen, and never in the way of a save.
    console.error(`[mannon] margin guard could not read the catalogue: ${detail}`);
    return { status: "unavailable", report: null, sampled: false, detail };
  }
}
