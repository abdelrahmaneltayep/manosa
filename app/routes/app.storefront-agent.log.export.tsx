import type { LoaderFunctionArgs } from "@remix-run/node";

import { exportConversations } from "~/lib/agent/buyer/log.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { withAdmin } from "~/shopify.server";

/**
 * The log as a CSV, one row per turn.
 *
 * A download rather than a screen, because the reason a merchant exports this
 * is to read it somewhere else. Gated on the plan like the rest of the
 * feature: a shop that cannot run the agent cannot export what it said.
 */
export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const entitlements = await loadEntitlements();
    if (!hasFeature(entitlements, "buyer_agent")) {
      throw new Response("Not available on this plan", { status: 402 });
    }

    const csv = await exportConversations();

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="mannon-agent-conversations.csv"',
        // A buyer's words are in this file; nothing about it should be cached
        // by anything between here and the merchant.
        "Cache-Control": "no-store",
      },
    });
  });
