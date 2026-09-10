import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { ConversationLogPage } from "~/components/agent/ConversationLogPage";
import type { LogView } from "~/components/agent/types";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import { loadGuardrails } from "~/lib/agent/buyer/guardrails.server";
import { isOutcome, listConversations } from "~/lib/agent/buyer/log.server";
import { logView } from "~/lib/agent/buyer/view-model.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { lowestPlanWithFeature } from "~/lib/billing/plans";
import { withAdmin } from "~/shopify.server";

/** Every conversation the agent had, newest first. */
export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const locale = detectLocale(request);
    const t = await getFixedT(locale);
    const now = new Date();

    const outcome = (url.searchParams.get("outcome") ?? "").trim();
    const search = (url.searchParams.get("search") ?? "").trim();
    const page = Number(url.searchParams.get("page") ?? "1");

    const [rows, guardrails, entitlements] = await Promise.all([
      listConversations({
        page: Number.isFinite(page) ? page : 1,
        outcome: isOutcome(outcome) ? outcome : null,
        search: search || null,
      }),
      loadGuardrails(),
      loadEntitlements(),
    ]);

    const entitled = hasFeature(entitlements, "buyer_agent");

    return json({
      view: logView(rows, {
        now,
        locale,
        t: translate(t),
        published: guardrails.published,
        entitled,
        requiredPlan: entitled ? null : lowestPlanWithFeature("buyer_agent"),
        // Echoed back exactly as typed, so the filter bar and the "no results"
        // link agree about what was asked for.
        filters: { outcome: isOutcome(outcome) ? outcome : "", search },
      }),
    });
  });

export default function ConversationLog() {
  const { view } = useLoaderData<typeof loader>();
  return <ConversationLogPage view={view as LogView} />;
}
