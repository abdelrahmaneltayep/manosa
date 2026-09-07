import type { ActionFunctionArgs } from "@remix-run/node";

import { prismaBase } from "~/db.server";
import { authenticate } from "~/shopify.server";

/**
 * Uninstall handler.
 *
 * Phase 0.2 builds the full webhook framework (dispatch table, retry-safe
 * queue, GDPR-timed PII purge). What matters here and cannot wait is revoking
 * the access tokens: once the app is gone the sessions are dead weight and a
 * standing credential.
 *
 * Session rows are deliberately unscoped (see UNSCOPED_MODELS) — this deletes
 * by shop explicitly.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  if (topic !== "APP_UNINSTALLED") {
    // authenticate.webhook already verified the HMAC; a mismatched topic means
    // the route is wired to the wrong subscription.
    throw new Response("Unexpected topic", { status: 400 });
  }

  await prismaBase.session.deleteMany({ where: { shop } });

  // TODO(phase 0.2): mark Shop.uninstalledAt and schedule the 48h PII purge.
  return new Response(null, { status: 200 });
};
