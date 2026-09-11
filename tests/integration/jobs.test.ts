import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "~/db.server";
import { cancelPendingJobs, enqueueJob } from "~/lib/jobs/queue.server";
import { requeueStuckJobs, runDueJobs } from "~/lib/jobs/runner.server";
import { shopScope, tenant, withoutShopScope } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const PAST = () => new Date(Date.now() - 1000);
const FUTURE = () => new Date(Date.now() + 60 * 60_000);

/**
 * A handler table that always fails. Injected rather than mocked: spying on the
 * extended Prisma client leaves a stub behind that later tests inherit, which
 * is a bug in the test, not the code.
 */
const ALWAYS_FAILS = {
  "shop.purge_pii": async () => {
    throw new Error("boom");
  },
};

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

async function uninstalledShop(shop: string, uninstalledAt = new Date()) {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        name: "Alpha Coffee",
        email: "owner@alpha.test",
        uninstalledAt,
      },
    }),
  );
}

describe("queue", () => {
  it("enqueues work for the active tenant", async () => {
    await shopScope.run(ALPHA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: FUTURE() }),
    );

    const mine = await shopScope.run(ALPHA, () => db.scheduledJob.findMany());
    const theirs = await shopScope.run(BETA, () => db.scheduledJob.findMany());
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });

  it("replaces pending work instead of queueing it twice", async () => {
    await shopScope.run(ALPHA, async () => {
      await enqueueJob({ kind: "shop.purge_pii", runAt: FUTURE(), replacePending: true });
      await enqueueJob({ kind: "shop.purge_pii", runAt: FUTURE(), replacePending: true });
    });

    const jobs = await shopScope.run(ALPHA, () =>
      db.scheduledJob.findMany({ orderBy: { createdAt: "asc" } }),
    );
    expect(jobs.map((job) => job.status)).toEqual(["CANCELLED", "PENDING"]);
  });

  it("cancels only the active tenant's pending work", async () => {
    await shopScope.run(ALPHA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: FUTURE() }),
    );
    await shopScope.run(BETA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: FUTURE() }),
    );

    const cancelled = await shopScope.run(ALPHA, () =>
      cancelPendingJobs("shop.purge_pii"),
    );
    expect(cancelled).toBe(1);

    const betaJobs = await shopScope.run(BETA, () => db.scheduledJob.findMany());
    expect(betaJobs[0]?.status).toBe("PENDING");
  });
});

describe("runner", () => {
  it("runs due work and leaves future work alone", async () => {
    await uninstalledShop(ALPHA);
    await shopScope.run(ALPHA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: PAST() }),
    );
    await shopScope.run(BETA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: FUTURE() }),
    );

    const result = await runDueJobs();
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });

    const betaJob = await shopScope.run(BETA, () => db.scheduledJob.findFirstOrThrow());
    expect(betaJob.status).toBe("PENDING");
  });

  it("serves every tenant in one pass", async () => {
    await uninstalledShop(ALPHA);
    await uninstalledShop(BETA);
    await shopScope.run(ALPHA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: PAST() }),
    );
    await shopScope.run(BETA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: PAST() }),
    );

    const result = await runDueJobs();
    expect(result.succeeded).toBe(2);
  });

  it("backs a failed job off rather than retrying it immediately", async () => {
    await shopScope.run(ALPHA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: PAST() }),
    );

    const result = await runDueJobs({ handlers: ALWAYS_FAILS });
    expect(result.failed).toBe(1);

    const job = await shopScope.run(ALPHA, () => db.scheduledJob.findFirstOrThrow());
    expect(job.status).toBe("PENDING");
    expect(job.attempts).toBe(1);
    expect(job.lastError).toContain("boom");
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("gives up once a job exhausts its attempts", async () => {
    await shopScope.run(ALPHA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: PAST(), maxAttempts: 1 }),
    );
    await runDueJobs({ handlers: ALWAYS_FAILS });

    const job = await shopScope.run(ALPHA, () => db.scheduledJob.findFirstOrThrow());
    expect(job.status).toBe("FAILED");
    expect(job.finishedAt).toBeInstanceOf(Date);
  });

  it("fails a job whose handler no longer exists instead of retrying forever", async () => {
    await withoutShopScope("seeding a job kind the registry does not know", () =>
      prismaBase.scheduledJob.create({
        data: { shop: ALPHA, kind: "removed.in.a.deploy", runAt: PAST() },
      }),
    );

    const result = await runDueJobs();
    expect(result.failed).toBe(1);

    const job = await shopScope.run(ALPHA, () => db.scheduledJob.findFirstOrThrow());
    expect(job.status).toBe("FAILED");
    expect(job.lastError).toContain("Unknown job kind");
  });

  it("requeues work left RUNNING by a killed process", async () => {
    await withoutShopScope("seeding a stuck job", () =>
      prismaBase.scheduledJob.create({
        data: {
          shop: ALPHA,
          kind: "shop.purge_pii",
          runAt: PAST(),
          status: "RUNNING",
          startedAt: new Date(Date.now() - 60 * 60_000),
        },
      }),
    );

    expect(await requeueStuckJobs()).toBe(1);
    const job = await shopScope.run(ALPHA, () => db.scheduledJob.findFirstOrThrow());
    expect(job.status).toBe("PENDING");
    expect(job.startedAt).toBeNull();
  });
});

describe("the uninstall PII purge", () => {
  it("clears contact details and redacts the audit trail", async () => {
    await uninstalledShop(ALPHA);
    await withoutShopScope("seeding audit history", () =>
      prismaBase.auditLog.create({
        data: {
          shop: ALPHA,
          actorType: "STAFF",
          actorId: "gid://shopify/StaffMember/1",
          actorLabel: "Dana",
          ip: "203.0.113.7",
          action: "pricing_rule.created",
          summary: "Created a rule.",
        },
      }),
    );
    await shopScope.run(ALPHA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: PAST() }),
    );

    await runDueJobs();

    const shop = await shopScope.run(ALPHA, () =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.email).toBeNull();
    expect(shop.name).toBeNull();
    expect(shop.piiPurgedAt).toBeInstanceOf(Date);

    const entry = await shopScope.run(ALPHA, () =>
      db.auditLog.findFirstOrThrow({ where: { action: "pricing_rule.created" } }),
    );
    expect(entry.actorId).toBeNull();
    expect(entry.actorLabel).toBeNull();
    expect(entry.ip).toBeNull();
    // The shape of the trail survives — who did what is gone, that it happened is not.
    expect(entry.action).toBe("pricing_rule.created");
  });

  it("does not touch a shop that reinstalled before the purge ran", async () => {
    await shopScope.run(ALPHA, () =>
      db.shop.create({
        data: { ...tenant(), name: "Alpha Coffee", email: "owner@alpha.test" },
      }),
    );
    await shopScope.run(ALPHA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: PAST() }),
    );

    await runDueJobs();

    const shop = await shopScope.run(ALPHA, () =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(shop.email).toBe("owner@alpha.test");
    expect(shop.piiPurgedAt).toBeNull();
  });

  it("is idempotent — a second run changes nothing", async () => {
    await uninstalledShop(ALPHA);
    await shopScope.run(ALPHA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: PAST() }),
    );
    await runDueJobs();

    const first = await shopScope.run(ALPHA, () =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );

    await shopScope.run(ALPHA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: PAST() }),
    );
    await runDueJobs();

    const second = await shopScope.run(ALPHA, () =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(second.piiPurgedAt?.getTime()).toBe(first.piiPurgedAt?.getTime());
  });

  it("takes the merchant's own storefront wording with it", async () => {
    await uninstalledShop(ALPHA);
    await shopScope.run(ALPHA, () =>
      db.storefrontString.create({
        data: { ...tenant(), key: "forms.submit", locale: "en", value: "Apply now" },
      }),
    );
    await shopScope.run(BETA, async () => {
      await db.shop.create({ data: { ...tenant() } });
      await db.storefrontString.create({
        data: { ...tenant(), key: "forms.submit", locale: "en", value: "Join us" },
      });
    });
    await shopScope.run(ALPHA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: PAST() }),
    );

    await runDueJobs();

    // Settings promises everything stored about a shop goes within 48 hours. A
    // table that nothing names here outlives that promise silently.
    expect(await shopScope.run(ALPHA, () => db.storefrontString.count())).toBe(0);
    expect(await shopScope.run(BETA, () => db.storefrontString.count())).toBe(1);
  });

  it("never reaches another tenant's data", async () => {
    await uninstalledShop(ALPHA);
    await shopScope.run(BETA, () =>
      db.shop.create({
        data: { ...tenant(), name: "Beta Beans", email: "owner@beta.test" },
      }),
    );
    await shopScope.run(ALPHA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: PAST() }),
    );

    await runDueJobs();

    const beta = await shopScope.run(BETA, () =>
      db.shop.findUniqueOrThrow({ where: { shop: BETA } }),
    );
    expect(beta.email).toBe("owner@beta.test");
    expect(beta.name).toBe("Beta Beans");
  });
});

describe("the runner endpoint", () => {
  const post = async (headers: HeadersInit) => {
    const { action } = await import("~/routes/internal.jobs.run");
    return action({
      request: new Request("https://mannon.test/internal/jobs/run", {
        method: "POST",
        headers,
      }),
      params: {},
      context: {} as never,
    });
  };

  it("refuses to run when no token is configured", async () => {
    const previous = process.env.JOBS_RUNNER_TOKEN;
    delete process.env.JOBS_RUNNER_TOKEN;

    const response = await post({ Authorization: "Bearer anything" });
    expect(response.status).toBe(503);

    if (previous !== undefined) process.env.JOBS_RUNNER_TOKEN = previous;
  });

  it("rejects a missing or wrong token", async () => {
    process.env.JOBS_RUNNER_TOKEN = "correct-horse-battery-staple";

    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: "Bearer wrong" })).status).toBe(401);
    // Same length as the real token — the comparison must not be a prefix match.
    expect(
      (await post({ Authorization: "Bearer correct-horse-battery-stapl3" })).status,
    ).toBe(401);

    delete process.env.JOBS_RUNNER_TOKEN;
  });

  it("runs due work for a caller holding the token", async () => {
    process.env.JOBS_RUNNER_TOKEN = "correct-horse-battery-staple";
    await uninstalledShop(ALPHA);
    await shopScope.run(ALPHA, () =>
      enqueueJob({ kind: "shop.purge_pii", runAt: PAST() }),
    );

    const response = await post({ Authorization: "Bearer correct-horse-battery-staple" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ succeeded: 1, failed: 0 });

    delete process.env.JOBS_RUNNER_TOKEN;
  });

  it("does not serve the app shell on GET", async () => {
    const { loader } = await import("~/routes/internal.jobs.run");
    expect((await loader()).status).toBe(405);
  });
});
