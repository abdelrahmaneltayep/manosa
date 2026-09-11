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

/**
 * The same gate, as a guard rather than a fact.
 *
 * `aiGate` returns *whether*; a loader puts that in a view and a component
 * disables a button with it. That is a courtesy. **This** is the enforcement,
 * and it exists because four ✦ actions shipped with the courtesy and nothing
 * else: the button rendered disabled, and a POST straight to the route still
 * sent the merchant's data to Anthropic — data they had just declined to
 * share, on a call they pay for.
 *
 * Every ✦ action calls this before it reaches a prompt. The rule is written
 * in this repo already, in `app.storefront-agent.test.tsx`: *a disabled button
 * is a courtesy, not enforcement.*
 */
export async function requireAi(
  permission: AiPermission,
  options: { feature?: Parameters<typeof hasFeature>[1]; now?: Date } = {},
): Promise<void> {
  const gate = await aiGate(permission, options);
  if (gate.allowed) return;

  // 403 for a permission the merchant themselves withdrew, 402 for a plan.
  // Different things, and the status says which without a body to read.
  throw new Response(
    gate.blockedBy === "permission"
      ? "This shop has switched this off in Settings"
      : gate.blockedBy === "plan"
        ? "This plan does not include this"
        : "No Anthropic API key is configured",
    { status: gate.blockedBy === "plan" ? 402 : 403 },
  );
}
