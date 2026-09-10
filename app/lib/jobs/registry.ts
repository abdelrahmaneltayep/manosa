import { backfillCustomers } from "~/lib/jobs/handlers/backfill-customers.server";
import { dailyBriefing } from "~/lib/jobs/handlers/daily-briefing.server";
import { backfillOrders } from "~/lib/jobs/handlers/backfill-orders.server";
import { expireQuotes } from "~/lib/jobs/handlers/expire-quotes.server";
import { decideApplications } from "~/lib/jobs/handlers/decide-applications.server";
import { screenApplications } from "~/lib/jobs/handlers/screen-applications.server";
import { purgeShopPii } from "~/lib/jobs/handlers/purge-shop-pii.server";

/**
 * Every background job kind, and what runs it.
 *
 * Handlers run inside the job's tenant scope and must be idempotent: the
 * runner retries on failure, and a crash between "handler finished" and
 * "row marked DONE" replays the job.
 */
export const JOB_HANDLERS = {
  "shop.purge_pii": purgeShopPii,
  "customers.backfill": backfillCustomers,
  "orders.backfill": backfillOrders,
  "quotes.expire": expireQuotes,
  "forms.decide_applications": decideApplications,
  "forms.screen_applications": screenApplications,
  "agent.daily_briefing": dailyBriefing,
} as const;

export type JobKind = keyof typeof JOB_HANDLERS;

export function isJobKind(value: string): value is JobKind {
  return value in JOB_HANDLERS;
}

/** Every kind the runner knows how to execute. */
export const JOB_KINDS = Object.keys(JOB_HANDLERS) as JobKind[];
