import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { ActivityPage } from "~/components/activity/ActivityPage";
import type { ActivityLogView } from "~/components/activity/types";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import {
  ACTIVITY_FILTERS,
  isActivityFilter,
  loadActivity,
} from "~/lib/activity/feed.server";
import { activityKindLabel, whenLabel } from "~/lib/agent/home-view.server";
import { withAdmin } from "~/shopify.server";

/**
 * The full activity log.
 *
 * Home's feed with a filter and a way further back. Read-only: everything on
 * it happened somewhere else and is recorded, not decided, here.
 */

/** Rows per page. Home shows eight; this is a page of a log. */
const PAGE_SIZE = 50;

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const locale = detectLocale(request);
    const t = translate(await getFixedT(locale));
    const now = new Date();

    const requested = url.searchParams.get("filter") ?? "all";
    const filter = isActivityFilter(requested) ? requested : "all";
    const before = url.searchParams.get("before");

    const page = await loadActivity({ limit: PAGE_SIZE, before, filter });

    const view: ActivityLogView = {
      rows: page.rows.map((row) => ({
        id: row.id,
        summary: row.summary,
        when: whenLabel(row.at, now, locale),
        at: row.at.toISOString(),
        href: row.href,
        agent: row.agent,
        kindLabel: activityKindLabel(row.action, t),
        actorLabel: row.actorLabel,
      })),
      filter,
      filters: [...ACTIVITY_FILTERS],
      nextHref: page.nextCursor
        ? `/app/activity?filter=${filter}&before=${encodeURIComponent(page.nextCursor)}`
        : null,
    };

    return json({ view });
  });

export default function Activity() {
  const { view } = useLoaderData<typeof loader>();
  return <ActivityPage view={view as ActivityLogView} />;
}
