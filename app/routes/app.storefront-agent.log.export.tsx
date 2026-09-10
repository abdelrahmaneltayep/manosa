import type { LoaderFunctionArgs } from "@remix-run/node";

import { exportConversations, isOutcome } from "~/lib/agent/buyer/log.server";
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

    // The same filters the log list was showing, so a link inside a filter
    // toolbar exports what the toolbar is filtered to.
    const url = new URL(request.url);
    const outcome = (url.searchParams.get("outcome") ?? "").trim();
    const search = (url.searchParams.get("search") ?? "").trim();

    const { csv, rows, truncated } = await exportConversations({
      outcome: isOutcome(outcome) ? outcome : null,
      search: search || null,
    });

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="mannon-agent-conversations.csv"',
        // A buyer's words are in this file; nothing about it should be cached
        // by anything between here and the merchant.
        "Cache-Control": "no-store",
        // Said in a header rather than nowhere: a merchant whose export hit
        // the ceiling has a file that is not the whole story, and a silently
        // short CSV is the kind of thing nobody notices until it matters.
        "X-Mannon-Rows": String(rows),
        ...(truncated ? { "X-Mannon-Truncated": "true" } : {}),
      },
    });
  });
