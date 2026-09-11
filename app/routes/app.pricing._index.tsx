import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { RuleListPage } from "~/components/pricing/RuleListPage";
import type { RuleListView } from "~/components/pricing/types";
import { db } from "~/db.server";
import { aiGate } from "~/lib/ai/permissions.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import { loadEntitlements } from "~/lib/billing/entitlements.server";
import { RulesetTooLargeError } from "~/lib/pricing/ruleset.server";
import {
  archiveRule,
  ARCHIVE_RETENTION_DAYS,
  listRules,
  restoreRule,
  RULES_PAGE_SIZE,
} from "~/lib/pricing/rules.server";
import { duplicateNamesIn, toRowView } from "~/lib/pricing/view-model.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { withAdmin } from "~/shopify.server";

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const t = await getFixedT(detectLocale(request));
    const now = new Date();

    const page = await listRules({
      archived: url.searchParams.get("archived") === "1",
      search: url.searchParams.get("search") ?? undefined,
      page: Number(url.searchParams.get("page") ?? 1) || 1,
      sort: (url.searchParams.get("sort") as "priority" | "name" | "usage") ?? "priority",
      // Settings links here with the count it showed. Ignoring this meant the
      // merchant was told "3 rules" and shown seven.
      combinable: url.searchParams.get("combinable") === "1",
    });

    const shop = await db.shop.findUnique({
      where: { shop: shopScope.require("pricing") },
    });
    const entitlements = await loadEntitlements(now);
    const limit = entitlements.limits.pricingRules;
    const duplicates = duplicateNamesIn(page.rows);

    const view: RuleListView = {
      rows: page.rows.map((row) =>
        toRowView(row, { now, duplicateNames: duplicates, t: translate(t) }),
      ),
      total: page.total,
      page: page.page,
      pageSize: RULES_PAGE_SIZE,
      totalUnfiltered: page.totalUnfiltered,
      search: url.searchParams.get("search") ?? "",
      archived: url.searchParams.get("archived") === "1",
      sort: url.searchParams.get("sort") ?? "priority",
      unreadableCount: 0,
      cachedMinutesAgo: null,
      published: shop
        ? {
            ruleCount: shop.rulesetRuleCount,
            at: shop.rulesetPublishedAt ? shop.rulesetPublishedAt.toISOString() : null,
          }
        : null,
      publishError: url.searchParams.get("publishError") as RuleListView["publishError"],
      atRuleLimit: limit !== null && page.totalUnfiltered >= limit,
      archiveRetentionDays: ARCHIVE_RETENTION_DAYS,
      // ✦ Describe a rule works whenever there is a key to ask with.
      aiAvailable: (await aiGate("draft")).allowed,
    };

    return json({ view });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const intent = form.get("intent");
    const ruleId = (form.get("ruleId") ?? "").toString();

    if (!ruleId) throw new Response("Missing rule", { status: 400 });
    const context = { admin, actor: { type: "STAFF" as const, id: session.id } };

    try {
      if (intent === "archive") await archiveRule(ruleId, context);
      else if (intent === "restore") await restoreRule(ruleId, context);
      else throw new Response("Unknown intent", { status: 400 });
    } catch (error) {
      // The rule change itself succeeded; only the push to checkout failed.
      // Say so rather than implying the whole save was lost.
      if (error instanceof RulesetTooLargeError) {
        return redirect("/app/pricing?publishError=too_large");
      }
      throw error;
    }

    return redirect("/app/pricing");
  });

export default function PricingIndex() {
  const { view } = useLoaderData<typeof loader>();
  return <RuleListPage view={view as RuleListView} />;
}
