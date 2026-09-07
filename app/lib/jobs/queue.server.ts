import type { Prisma } from "@prisma/client";

import { db } from "~/db.server";
import type { JobKind } from "~/lib/jobs/registry";
import { tenant } from "~/lib/tenant/shop-context.server";

export interface EnqueueOptions {
  kind: JobKind;
  runAt: Date;
  payload?: Prisma.InputJsonValue;
  maxAttempts?: number;
  /**
   * Replace any pending job of the same kind for this shop instead of adding a
   * second one. Use for "do X once, later" work such as the uninstall purge —
   * two uninstall webhooks must not queue two purges.
   */
  replacePending?: boolean;
}

export async function enqueueJob(options: EnqueueOptions) {
  if (options.replacePending) {
    await db.scheduledJob.updateMany({
      where: { kind: options.kind, status: "PENDING" },
      data: { status: "CANCELLED", finishedAt: new Date() },
    });
  }

  return db.scheduledJob.create({
    data: {
      ...tenant(),
      kind: options.kind,
      runAt: options.runAt,
      payload: options.payload,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    },
  });
}

/**
 * Cancel pending work of a kind for the active tenant. Returns how many were
 * cancelled, so callers can log whether anything was actually pending.
 */
export async function cancelPendingJobs(kind: JobKind) {
  const { count } = await db.scheduledJob.updateMany({
    where: { kind, status: "PENDING" },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
  return count;
}
