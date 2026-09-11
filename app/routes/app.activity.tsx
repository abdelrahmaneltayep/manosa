import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { ActivityPage } from "~/components/activity/ActivityPage";
import { db } from "~/db.server";
import type { ActivityLogView } from "~/components/activity/types";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import {
  ACTIVITY_FILTERS,
  ACTOR_FILTERS,
  isActivityFilter,
  isActorFilter,
  actionLabel,
  loadActivity,
  readDay,
  recordedActions,
} from "~/lib/activity/feed.server";
import {
  AUDIT_RETENTION_MONTHS,
  ensureAuditPurgeScheduled,
  retentionCutoff,
} from "~/lib/jobs/handlers/purge-audit.server";
import { activityKindLabel, whenLabel } from "~/lib/agent/home-view.server";
import { withAdmin } from "~/shopify.server";

/**
 * The full activity log.
 *
 * Home's feed with a filter and a way further back. Read-only: everything on
 * it happened somewhere else and is recorded, not decided, here.
 */

/** The earliest day this log can actually answer about. */
const keptFrom = (cutoff: Date, installedAt: Date | null): string =>
  (installedAt && installedAt > cutoff ? installedAt : cutoff).toISOString().slice(0, 10);

/** "Show more" has to keep the filters, or page two is a different question. */
function keeping(url: URL, overrides: Record<string, string> = {}): string {
  const kept = new URLSearchParams();
  for (const key of ["filter", "actor", "action", "from", "to"]) {
    const value = overrides[key] ?? url.searchParams.get(key);
    if (value) kept.set(key, value);
  }
  const query = kept.toString();
  // No trailing "?&": an unfiltered log's "Show older" used to read
  // `/app/activity?&before=...`.
  return query ? `/app/activity?${query}` : "/app/activity";
}

/** Rows per page. Home shows eight; this is a page of a log. */
const PAGE_SIZE = 50;

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    const url = new URL(request.url);
    const locale = detectLocale(request);
    const t = translate(await getFixedT(locale));
    const now = new Date();

    const requested = url.searchParams.get("filter") ?? "all";
    const filter = isActivityFilter(requested) ? requested : "all";
    const before = url.searchParams.get("before");

    const askedActor = url.searchParams.get("actor") ?? "anyone";
    const actor = isActorFilter(askedActor) ? askedActor : "anyone";
    const action = (url.searchParams.get("action") ?? "").trim();
    const from = readDay(url.searchParams.get("from"));
    const to = readDay(url.searchParams.get("to"));

    // The log enforces its own retention: it is called from the page that
    // states it, so a shop that installed before the job existed starts
    // keeping the promise the first time somebody reads their history.
    await ensureAuditPurgeScheduled(now);

    const [page, actions, shop] = await Promise.all([
      loadActivity({
        limit: PAGE_SIZE,
        before,
        filter,
        actor,
        action: action || null,
        from,
        to,
      }),
      recordedActions(),
      db.shop.findUnique({ where: { shop: session.shop } }),
    ]);

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
      // A merchant filtered to "Claude, 1-7 Sep" who clicks "Pricing" should
      // still be filtered to Claude, 1-7 Sep. These links used to drop every
      // filter but the category.
      filterHrefs: Object.fromEntries(
        ACTIVITY_FILTERS.map((one) => [one, keeping(url, { filter: one })]),
      ),
      actor,
      actors: [...ACTOR_FILTERS],
      action,
      actions: actions.map((value) => ({ value, label: actionLabel(value, t) })),
      from: url.searchParams.get("from") ?? "",
      to: url.searchParams.get("to") ?? "",
      retentionMonths: AUDIT_RETENTION_MONTHS,
      // The later of the retention cutoff and the install: a shop installed
      // last week does not have a log going back to last June, and saying so
      // is the page claiming a history that does not exist.
      keptFrom: keptFrom(retentionCutoff(now), shop?.installedAt ?? null),
      filtered: actor !== "anyone" || action !== "" || from !== null || to !== null,
      nextHref: page.nextCursor
        ? `${keeping(url)}${keeping(url).includes("?") ? "&" : "?"}before=${encodeURIComponent(page.nextCursor)}`
        : null,
    };

    return json({ view });
  });

export default function Activity() {
  const { view } = useLoaderData<typeof loader>();
  return <ActivityPage view={view as ActivityLogView} />;
}
