import type { BillingStatus } from "@prisma/client";

import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import { GRACE_PERIOD_DAYS } from "~/lib/billing/entitlements.server";
import { parseBillingPlanId } from "~/lib/billing/plans";
import type { WebhookContext } from "~/lib/webhooks/registry";

/**
 * Shopify tells us the moment a subscription changes — approved, cancelled, or
 * frozen because a charge failed.
 *
 * This keeps the cached plan correct without waiting for the merchant's next
 * page load, which matters most in the case they are least likely to be
 * watching: a card expiring overnight.
 *
 * The payload is Shopify's, so it is narrowed here rather than trusted.
 */
interface SubscriptionPayload {
  app_subscription?: {
    admin_graphql_api_id?: string;
    name?: string;
    status?: string;
    created_at?: string;
    test?: boolean;
  };
}

export async function handleAppSubscriptionsUpdate({ shop, payload }: WebhookContext) {
  const subscription = (payload as SubscriptionPayload).app_subscription;

  if (!subscription?.name || !subscription.status) {
    console.warn(`[billing] app_subscriptions/update for ${shop} had no subscription`);
    return;
  }

  const parsed = parseBillingPlanId(subscription.name);
  const status = mapStatus(subscription.status);

  // An unrecognised plan name would otherwise silently drop a paying merchant
  // to Free. Leave the cached plan alone and make it loud instead.
  if (!parsed && status !== "CANCELLED") {
    console.error(
      `[billing] unrecognised subscription "${subscription.name}" for ${shop}; ` +
        `leaving the cached plan untouched.`,
    );
    return;
  }

  const existing = await db.shop.findUnique({ where: { shop } });
  if (!existing) {
    console.warn(`[billing] app_subscriptions/update for unknown shop ${shop}`);
    return;
  }

  const now = new Date();
  const plan = status === "CANCELLED" ? "free" : (parsed?.plan ?? "free");

  await db.shop.update({
    where: { shop },
    data: {
      planKey: plan,
      billingStatus: status,
      billingInterval: status === "CANCELLED" ? null : (parsed?.interval ?? null),
      subscriptionId: subscription.admin_graphql_api_id ?? existing.subscriptionId,
      subscriptionName: subscription.name,
      isTestSubscription: subscription.test ?? existing.isTestSubscription,
      // Start the grace clock on the first frozen notification only, so a
      // repeated webhook cannot extend it indefinitely.
      graceEndsAt:
        status === "PAST_DUE"
          ? (existing.graceEndsAt ??
            new Date(now.getTime() + GRACE_PERIOD_DAYS * 86_400_000))
          : null,
      billingSyncedAt: now,
    },
  });

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: `billing.${status.toLowerCase()}`,
    summary: summarise(status, plan, existing.planKey),
    subject: { type: "Shop", id: shop },
    metadata: {
      subscriptionName: subscription.name,
      shopifyStatus: subscription.status,
      from: existing.planKey,
      to: plan,
    },
  });
}

function mapStatus(shopifyStatus: string): BillingStatus {
  switch (shopifyStatus.toUpperCase()) {
    case "ACTIVE":
      return "ACTIVE";
    case "FROZEN":
      return "PAST_DUE";
    case "CANCELLED":
    case "EXPIRED":
    case "DECLINED":
      return "CANCELLED";
    default:
      return "NONE";
  }
}

function summarise(status: BillingStatus, plan: string, previousPlan: string): string {
  switch (status) {
    case "PAST_DUE":
      return `The charge for the ${previousPlan} plan failed. Paid features keep working for ${GRACE_PERIOD_DAYS} days while the payment method is updated.`;
    case "CANCELLED":
      return `The ${previousPlan} subscription ended. Paid features are paused and nothing has been deleted.`;
    case "ACTIVE":
      return `The ${plan} plan is active.`;
    default:
      return `Subscription status is now ${status.toLowerCase()}.`;
  }
}
