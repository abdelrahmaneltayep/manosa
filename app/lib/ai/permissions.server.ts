import { db } from "~/db.server";
import { isAiAvailable } from "~/lib/ai/client.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * May Claude do this, here, now?
 *
 * Three separate questions, and until 6.5 the product only ever asked one of
 * them. Every ✦ surface checked `isAiAvailable()` — is there a key — so
 * `aiScreening: isAiAvailable()` was the entirety of "may Claude screen my
 * applicants". A merchant who wanted drafted emails but not an opinion on
 * their trade applicants had no way to say so, and the only answer available
 * was an environment variable they cannot see.
 *
 * The three, in the order they are worth telling a merchant about:
 *
 * 1. **Permission** — what they chose in Settings → Agent controls.
 * 2. **Plan** — some ✦ features are Pro or Agentic.
 * 3. **Key** — whether this deployment can reach Anthropic at all.
 *
 * Checklist §8 also asks for an **auto-approve** toggle. It is not here,
 * because nothing in this app approves an application without a person: a
 * control for behaviour the product does not have is worse than no control,
 * and 6.4 shipped one of those and had to take it out again. It arrives with
 * auto-approval itself, defaulting off.
 *
 * One function so no caller can ask only one of the three, for the same reason
 * `activeEngineRules` is the only read behind pricing: a gate with five call
 * sites is a gate with five chances to forget one.
 */

/** The things a merchant can switch off, and the column each reads. */
export const AI_PERMISSIONS = {
  /** Reading a registration application and saying what it looks like. */
  screen: "aiMayScreen",
  /** Writing a message, a rule or a review for a person to approve. */
  draft: "aiMayDraft",
} as const;

export type AiPermission = keyof typeof AI_PERMISSIONS;

/** Why a ✦ surface is off, in the order a merchant can act on. */
export type AiBlockedBy = "permission" | "plan" | "no_key";

export interface AiGate {
  allowed: boolean;
  /** Null when allowed. Otherwise the first thing standing in the way. */
  blockedBy: AiBlockedBy | null;
  /** The plan this needs, when the plan is what is missing. */
  requiredPlan: string | null;
}

const ALLOWED: AiGate = { allowed: true, blockedBy: null, requiredPlan: null };

export async function aiGate(
  permission: AiPermission,
  options: { feature?: Parameters<typeof hasFeature>[1]; now?: Date } = {},
): Promise<AiGate> {
  const shop = shopScope.require(`aiGate(${permission})`);
  const record = await db.shop.findUnique({ where: { shop } });

  // The merchant's own choice comes first, because it is the only one of the
  // three they can change here and now.
  if (record && !record[AI_PERMISSIONS[permission]]) {
    return { allowed: false, blockedBy: "permission", requiredPlan: null };
  }

  if (options.feature) {
    const entitlements = await loadEntitlements(options.now);
    if (!hasFeature(entitlements, options.feature)) {
      return { allowed: false, blockedBy: "plan", requiredPlan: null };
    }
  }

  if (!isAiAvailable()) {
    return { allowed: false, blockedBy: "no_key", requiredPlan: null };
  }

  return ALLOWED;
}

/** Every permission at once, for the Settings page and the home status card. */
export async function aiPermissions(): Promise<Record<AiPermission, boolean>> {
  const shop = shopScope.require("aiPermissions");
  const record = await db.shop.findUnique({ where: { shop } });

  return {
    screen: record?.aiMayScreen ?? true,
    draft: record?.aiMayDraft ?? true,
  };
}
