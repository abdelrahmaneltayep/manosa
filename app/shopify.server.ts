import "@shopify/shopify-app-remix/adapters/node";

import { BillingInterval, BillingReplacementBehavior } from "@shopify/shopify-api";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
  type AdminApiContext,
  type Session,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

import { prismaBase } from "~/db.server";
import { assertEnvironment } from "~/lib/config/environment.server";
import {
  billingPlanId,
  PLAN_LIST,
  type PlanDefinition,
  type PlanInterval,
} from "~/lib/billing/plans";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Shopify's billing configuration, derived from the plan catalog rather than
 * written out again — the price a merchant is charged and the price shown on
 * the Plans page cannot disagree if both read the same table.
 */
function billingLineItem(plan: PlanDefinition, interval: PlanInterval) {
  return {
    amount: interval === "annual" ? plan.annualPrice : plan.monthlyPrice,
    currencyCode: "USD",
    interval:
      interval === "annual" ? BillingInterval.Annual : BillingInterval.Every30Days,
  } as const;
}

const billing = Object.fromEntries(
  PLAN_LIST.filter((plan) => plan.monthlyPrice > 0).flatMap((plan) =>
    (["monthly", "annual"] as const).map((interval) => [
      billingPlanId(plan.key, interval),
      {
        trialDays: plan.trialDays,
        // Default for an upgrade: replace the subscription now and prorate, so
        // the merchant gets what they just paid for immediately and is credited
        // for the unused part of the old plan. A downgrade overrides this at
        // request time to take effect at the end of the period they have
        // already paid for — see app.plans.tsx.
        replacementBehavior: BillingReplacementBehavior.Standard,
        lineItems: [billingLineItem(plan, interval)],
      },
    ]),
  ),
);

// Before anything reads a variable with a `!` or a `?? ""` behind it. In
// production this throws with the whole list rather than booting an app that
// verifies webhook signatures against an empty key.
assertEnvironment();

const shopifyConfig = {
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET ?? "",
  apiVersion: ApiVersion.July25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL ?? "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prismaBase),
  distribution: AppDistribution.AppStore,
  billing,
  future: {
    // Token exchange instead of the legacy OAuth redirect dance. Requires
    // Shopify-managed installation, which shopify.app.toml declares.
    unstable_newEmbeddedAuthStrategy: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
} as const;

const shopify = shopifyApp(shopifyConfig);

export default shopify;
export const apiVersion = ApiVersion.July25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

/** The billing helpers Shopify hands an authenticated admin request. */
export type BillingContext = Awaited<
  ReturnType<typeof shopify.authenticate.admin>
>["billing"];

export interface AdminContext {
  session: Session;
  admin: AdminApiContext;
  billing: BillingContext;
}

/**
 * The only sanctioned way for an admin route to reach the database.
 *
 * Authenticates the embedded request, then runs the handler inside the tenant
 * scope so every Prisma query is filtered by this shop. Loaders and actions
 * should never call `authenticate.admin` and touch `db` separately — that pair
 * is exactly the mistake the scope exists to prevent.
 */
export async function withAdmin<T>(
  request: Request,
  handler: (ctx: AdminContext) => Promise<T>,
): Promise<T> {
  const { session, admin, billing: billingContext } = await authenticate.admin(request);
  return shopScope.run(session.shop, () =>
    handler({ session, admin, billing: billingContext }),
  );
}
