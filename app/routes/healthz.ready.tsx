import { json } from "@remix-run/node";

import { prismaBase } from "~/db.server";
import { checkEnvironment } from "~/lib/config/environment.server";

/**
 * Is this deployment actually able to do its job?
 *
 * `/healthz` answers "is the server up" and deliberately does not touch the
 * database, so a blip cannot take the app out of rotation. This answers the
 * other question, the one nothing answered before: **is the work that carries
 * this app's promises actually running?**
 *
 * The reason it exists is `JOBS_RUNNER_TOKEN`. Every background job in this app
 * — the GDPR purge a merchant is promised within 48 hours of uninstalling, the
 * retention sweeps, quote expiry, the daily briefing — runs only because
 * something outside the app POSTs `/internal/jobs/run` on a schedule. If that
 * cron is never set up, or its token is wrong, or it silently stops, nothing
 * anywhere says so: the jobs queue up, `PENDING`, for ever, and the app looks
 * fine. That is the shape this repo keeps finding, and an operator deserves one
 * page that tells them.
 *
 * Deliberately unauthenticated, and deliberately shallow: counts and booleans,
 * never a shop name, a job payload or an error body. A probe endpoint is read
 * by load balancers and uptime checks, and none of them should be handed a
 * merchant's data.
 */

/** A queue older than this is a runner that has stopped, not a busy one. */
export const OVERDUE_MINUTES = 30;

export const loader = async () => {
  const environment = checkEnvironment();
  const checks: Record<string, unknown> = {
    configured: environment.ok,
    missingRequired: environment.missingRequired.map((one) => one.name),
    missingOptional: environment.missingOptional.map((one) => one.name),
  };

  let database = false;
  let jobs: Record<string, unknown> = { checked: false };

  try {
    // Outside the tenant scope on purpose: this is about the deployment, not
    // about any one shop, and it counts rows without reading them.
    await prismaBase.$queryRaw`SELECT 1`;
    database = true;

    const overdueSince = new Date(Date.now() - OVERDUE_MINUTES * 60_000);
    const [pending, overdue, failed] = await Promise.all([
      prismaBase.scheduledJob.count({ where: { status: "PENDING" } }),
      prismaBase.scheduledJob.count({
        where: { status: "PENDING", runAt: { lt: overdueSince } },
      }),
      prismaBase.scheduledJob.count({ where: { status: "FAILED" } }),
    ]);

    jobs = { checked: true, pending, overdue, failed, overdueMinutes: OVERDUE_MINUTES };
  } catch {
    // The message could name a host or a user. The fact is enough.
    database = false;
  }

  const runnerStalled = typeof jobs.overdue === "number" && jobs.overdue > 0;
  const ready = environment.ok && database && !runnerStalled;

  return json(
    {
      status: ready ? "ready" : "degraded",
      service: "mannon",
      time: new Date().toISOString(),
      database,
      // Named rather than implied: "the job runner has not run in half an hour"
      // is the single most consequential thing that can be silently true here.
      runnerStalled,
      jobs,
      ...checks,
    },
    {
      status: ready ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
};
