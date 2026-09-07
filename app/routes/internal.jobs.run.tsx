import { timingSafeEqual } from "node:crypto";

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { requeueStuckJobs, runDueJobs } from "~/lib/jobs/runner.server";

/**
 * Job runner endpoint. Point a scheduler at it:
 *
 *   * * * * * curl -fsS -XPOST -H "Authorization: Bearer $JOBS_RUNNER_TOKEN" \
 *               https://<app-url>/internal/jobs/run
 *
 * An HTTP endpoint rather than a CLI script because it works on every host
 * this app can run on — platform cron, an external scheduler, or a container
 * sidecar — with no second build pipeline for the script.
 *
 * Without JOBS_RUNNER_TOKEN set, this refuses to run rather than exposing an
 * unauthenticated endpoint that mutates data across every shop.
 */
function authorized(request: Request, token: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;

  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // token length, so compare lengths first and always run the comparison.
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const token = process.env.JOBS_RUNNER_TOKEN;

  if (!token) {
    console.error(
      "[jobs] JOBS_RUNNER_TOKEN is not set — the runner is disabled, so the " +
        "post-uninstall PII purge will not run. Set it and schedule the endpoint.",
    );
    return json({ error: "Job runner is not configured" }, { status: 503 });
  }

  if (!authorized(request, token)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const requeued = await requeueStuckJobs();
  const result = await runDueJobs();

  return json(
    { requeued, ...result },
    { status: result.failed > 0 ? 500 : 200, headers: { "Cache-Control": "no-store" } },
  );
};

/** POST only — a GET here is a misconfigured scheduler. */
export const loader = async () => json({ error: "Method not allowed" }, { status: 405 });
