import { BillingReplacementBehavior } from "@shopify/shopify-api";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { PlansPage } from "~/components/plans/PlansPage";
import type { PendingChangeView, PlansView } from "~/components/plans/types";
import { recordAudit } from "~/lib/audit/record.server";
import { loadEntitlements } from "~/lib/billing/entitlements.server";
import { planChangeFor } from "~/lib/billing/plan-change";
import {
  billingPlanId,
  isPlanInterval,
  isPlanKey,
  PLANS,
  type LimitKey,
  type PlanInterval,
  type PlanKey,
} from "~/lib/billing/plans";
import { syncSubscription } from "~/lib/billing/subscription.server";
import { loadUsageMeters, usageFor } from "~/lib/billing/usage.server";
import { LIMIT_KEYS } from "~/lib/billing/plans";
import { detectLocale } from "~/i18n.server";
import { withAdmin, type AdminContext } from "~/shopify.server";

async function currentUsage(): Promise<Record<LimitKey, number>> {
  const entries = await Promise.all(
    LIMIT_KEYS.map(async (key) => [key, await usageFor(key)] as const),
  );
  return Object.fromEntries(entries) as Record<LimitKey, number>;
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async ({ billing }: AdminContext) => {
    // The Plans page is the one place that always asks Shopify rather than
    // trusting the cache: the merchant is here to act on what it says, and they
    // may have just approved a charge on Shopify's screen.
    await syncSubscription(billing).catch((error) => {
      console.error("[billing] sync failed on the Plans page", error);
    });

    const url = new URL(request.url);
    const entitlements = await loadEntitlements();
    const meters = await loadUsageMeters(entitlements);

    const selectedInterval: PlanInterval = isPlanInterval(
      url.searchParams.get("interval"),
    )
      ? (url.searchParams.get("interval") as PlanInterval)
      : (entitlements.interval ?? "monthly");

    const requested = url.searchParams.get("change");
    let pendingChange: PendingChangeView | null = null;

    if (isPlanKey(requested) && requested !== entitlements.effectivePlan) {
      const change = planChangeFor({
        from: entitlements.effectivePlan,
        to: requested,
        fromInterval: entitlements.interval,
        toInterval: selectedInterval,
        usage: await currentUsage(),
      });
      pendingChange = {
        to: change.to,
        toInterval: change.toInterval,
        direction: change.direction,
        price: change.price,
        gaining: change.gaining,
        losing: change.losing,
        limitImpacts: change.limitImpacts,
        hasOverage: change.hasOverage,
      };
    }

    const locale = detectLocale(request);

    const view: PlansView = {
      plan: entitlements.plan,
      effectivePlan: entitlements.effectivePlan,
      status: entitlements.status,
      interval: entitlements.interval,
      selectedInterval,
      trialDaysRemaining: entitlements.trialDaysRemaining,
      graceDaysRemaining: entitlements.graceDaysRemaining,
      currentPeriodEndLabel: entitlements.currentPeriodEnd
        ? new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
            entitlements.currentPeriodEnd,
          )
        : null,
      isTest: entitlements.isTest,
      meters,
      pendingChange,
      error: url.searchParams.get("error") === "billing",
    };

    return json({ view });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ billing, session }) => {
    const form = await request.formData();

    if (form.get("intent") !== "change-plan") {
      throw new Response("Unknown intent", { status: 400 });
    }

    const plan = form.get("plan");
    const interval = form.get("interval");

    if (!isPlanKey(plan) || !isPlanInterval(interval)) {
      throw new Response("Unknown plan", { status: 400 });
    }

    const entitlements = await loadEntitlements();
    const isTest = process.env.SHOPIFY_BILLING_TEST_MODE === "true";

    // Moving to Free means cancelling, not buying something for $0.
    if (plan === "free") {
      if (entitlements.status === "NONE" || entitlements.effectivePlan === "free") {
        return redirect("/app/plans");
      }
      return cancelSubscription({
        billing,
        plan: entitlements.plan,
        isTest,
        shop: session.shop,
      });
    }

    const goingDown = PLANS[plan].rank < PLANS[entitlements.effectivePlan].rank;

    await recordAudit({
      actor: { type: "STAFF", id: session.id },
      action: goingDown ? "billing.downgrade_requested" : "billing.upgrade_requested",
      summary: `Requested a change from ${entitlements.effectivePlan} to ${plan} (${interval}).`,
      subject: { type: "Shop", id: session.shop },
      metadata: { from: entitlements.effectivePlan, to: plan, interval },
    });

    try {
      const confirmationUrl = await billing.request({
        plan: billingPlanId(plan, interval),
        isTest,
        returnUrl: `${process.env.SHOPIFY_APP_URL}/app/plans`,
        // An upgrade takes effect now and is prorated. A downgrade waits for the
        // end of the period the merchant already paid for — taking away what
        // they have paid for would be the dark pattern.
        ...(goingDown
          ? {
              replacementBehavior: BillingReplacementBehavior.ApplyOnNextBillingCycle,
            }
          : {}),
      });

      return redirect(confirmationUrl as string);
    } catch (error) {
      console.error("[billing] request failed", error);
      return redirect("/app/plans?error=billing");
    }
  });

async function cancelSubscription({
  billing,
  plan,
  isTest,
  shop,
}: {
  billing: AdminContext["billing"];
  plan: PlanKey;
  isTest: boolean;
  shop: string;
}) {
  const active = await billing.check({ isTest });
  const subscription = active.appSubscriptions?.[0];

  if (!subscription) return redirect("/app/plans");

  try {
    await billing.cancel({
      subscriptionId: subscription.id,
      isTest,
      // Credit the unused part rather than keeping money for a plan they have
      // asked to leave.
      prorate: true,
    });
  } catch (error) {
    console.error("[billing] cancel failed", error);
    return redirect("/app/plans?error=billing");
  }

  await recordAudit({
    actor: { type: "STAFF" },
    action: "billing.cancelled",
    summary: `Moved from ${plan} to Free. Paid features are paused and nothing has been deleted.`,
    subject: { type: "Shop", id: shop },
    metadata: { from: plan, subscriptionId: subscription.id },
  });

  return redirect("/app/plans");
}

export default function Plans() {
  const { view } = useLoaderData<typeof loader>();
  return <PlansPage view={view as PlansView} />;
}
