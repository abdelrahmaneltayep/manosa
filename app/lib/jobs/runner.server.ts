import { db } from "~/db.server";
import { JOB_HANDLERS } from "~/lib/jobs/registry";
import { shopScope, withoutShopScope } from "~/lib/tenant/shop-context.server";

/** What the runner needs of a handler table. */
export type JobHandlerTable = Record<string, () => Promise<unknown>>;

export interface RunDueJobsOptions {
  limit?: number;
  /**
   * Handler table to dispatch through. Defaults to the real registry; tests
   * pass a stub so retry and backoff can be exercised without depending on
   * what any particular handler happens to do internally.
   */
  handlers?: JobHandlerTable;
}

const BACKOFF_BASE_MS = 60_000;

export interface RunnerResult {
  claimed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/** Exponential backoff, capped at an hour: 1m, 2m, 4m, 8m, 16m, 32m, 60m. */
function nextAttemptAt(attempts: number): Date {
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempts, 60 * 60_000);
  return new Date(Date.now() + delay);
}

/**
 * Run every job that is due.
 *
 * Finding due work is the one genuinely cross-tenant query in the app — the
 * runner serves all shops — so it is explicit about that, then re-enters the
 * job's own tenant scope before touching anything.
 *
 * Claiming uses a conditional update, so two runners racing on the same row
 * result in one claim and one no-op rather than two executions.
 */
export async function runDueJobs({
  limit = 50,
  handlers = JOB_HANDLERS,
}: RunDueJobsOptions = {}): Promise<RunnerResult> {
  const due = await withoutShopScope("job runner serves every shop", () =>
    db.scheduledJob.findMany({
      where: { status: "PENDING", runAt: { lte: new Date() } },
      orderBy: { runAt: "asc" },
      take: limit,
      select: { id: true, shop: true, kind: true, attempts: true, maxAttempts: true },
    }),
  );

  const result: RunnerResult = { claimed: 0, succeeded: 0, failed: 0, skipped: 0 };

  for (const job of due) {
    await shopScope.run(job.shop, async () => {
      const claim = await db.scheduledJob.updateMany({
        where: { id: job.id, status: "PENDING" },
        data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } },
      });

      // Another runner got there first.
      if (claim.count !== 1) {
        result.skipped += 1;
        return;
      }
      result.claimed += 1;

      const handler = handlers[job.kind];
      if (!handler) {
        // A job kind that no longer exists — a deploy removed the handler.
        // Fail it loudly rather than retrying something nothing can run.
        await db.scheduledJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            lastError: `Unknown job kind "${job.kind}"`,
          },
        });
        result.failed += 1;
        return;
      }

      try {
        await handler();
        await db.scheduledJob.update({
          where: { id: job.id },
          data: { status: "DONE", finishedAt: new Date(), lastError: null },
        });
        result.succeeded += 1;
      } catch (error) {
        const attempts = job.attempts + 1;
        const exhausted = attempts >= job.maxAttempts;
        await db.scheduledJob.update({
          where: { id: job.id },
          data: exhausted
            ? {
                status: "FAILED",
                finishedAt: new Date(),
                lastError: String(error),
              }
            : {
                status: "PENDING",
                startedAt: null,
                runAt: nextAttemptAt(attempts),
                lastError: String(error),
              },
        });
        result.failed += 1;
        console.error(
          `[jobs] ${job.kind} failed for ${job.shop} (attempt ${attempts}/${job.maxAttempts})`,
          error,
        );
      }
    });
  }

  return result;
}

/**
 * Return RUNNING jobs that have been stuck longer than `staleAfterMs` to
 * PENDING — a process killed mid-job would otherwise leave them claimed
 * forever.
 */
export async function requeueStuckJobs(staleAfterMs = 15 * 60_000) {
  const cutoff = new Date(Date.now() - staleAfterMs);
  return withoutShopScope("job runner serves every shop", async () => {
    const { count } = await db.scheduledJob.updateMany({
      where: { status: "RUNNING", startedAt: { lt: cutoff } },
      data: { status: "PENDING", startedAt: null },
    });
    return count;
  });
}
