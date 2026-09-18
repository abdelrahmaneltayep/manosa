import { db } from "~/db.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Whether a charge for this shop is a test charge.
 *
 * Two things decide it, and neither used to be asked.
 *
 * **The store.** Shopify refuses a live recurring charge on a development
 * store. Until now the only answer was `SHOPIFY_BILLING_TEST_MODE`, a
 * process-wide environment variable — and the README told an operator to set
 * it per store, which is not a thing a single multi-tenant deployment can do.
 * Set it false and a merchant on a development store could not subscribe at
 * all; the refusal arrived as the generic "We couldn't start that change",
 * naming nothing. So the store answers for itself, from
 * `shop.plan.partnerDevelopment`, read with the rest of the shop's facts.
 *
 * **The deployment.** `SHOPIFY_BILLING_TEST_MODE=true` still forces test mode
 * everywhere, which is how a developer works against a store that is not a
 * development store. It cannot reach production: `assertEnvironment` refuses to
 * start a production process with it set, because there it means every
 * merchant in the tenancy subscribes for nothing.
 */
export function testModeForced(env = process.env.SHOPIFY_BILLING_TEST_MODE): boolean {
  return env === "true";
}

/** The pure half, so every state is testable without a database. */
export function testModeFor(
  shop: { isDevelopmentStore: boolean } | null,
  env = process.env.SHOPIFY_BILLING_TEST_MODE,
): boolean {
  return testModeForced(env) || shop?.isDevelopmentStore === true;
}

/** The same question, for the shop in scope. */
export async function billingTestMode(): Promise<boolean> {
  // The env var alone is enough, and answering without a query keeps this off
  // the path of a shop we have no install record for yet.
  if (testModeForced()) return true;

  const shop = shopScope.require("billingTestMode");
  const record = await db.shop.findUnique({
    where: { shop },
    select: { isDevelopmentStore: true },
  });

  return testModeFor(record);
}
