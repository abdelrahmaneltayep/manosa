import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import {
  assertEnvironment,
  checkEnvironment,
  ENVIRONMENT,
  EnvironmentIncomplete,
} from "~/lib/config/environment.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";

/**
 * Whether this deployment can actually do its job.
 *
 * Two questions nothing answered before: is the app configured well enough to
 * tell a real request from a forged one, and is the background work that
 * carries its promises actually running?
 */

const ALPHA = "alpha.myshopify.com";
const ready = async () => {
  const { loader } = await import("~/routes/healthz.ready");
  return loader();
};

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

/* -------------------------------------------------------------------------- */

describe("the environment check", () => {
  it("names every variable this app reads, with what breaks without it", () => {
    // Derived from the list, so a variable added to the code and not to the
    // list is a variable nobody is told about.
    const named = new Set(ENVIRONMENT.map((one) => one.name));
    for (const name of [
      "DATABASE_URL",
      "SHOPIFY_API_KEY",
      "SHOPIFY_API_SECRET",
      "SHOPIFY_APP_URL",
      "JOBS_RUNNER_TOKEN",
      "ANTHROPIC_API_KEY",
    ]) {
      expect(named, name).toContain(name);
    }

    for (const one of ENVIRONMENT) {
      expect(one.breaks.length, one.name).toBeGreaterThan(20);
    }
  });

  it("refuses to start in production without a secret it verifies with", () => {
    vi.stubEnv("SHOPIFY_API_SECRET", "");

    // An empty secret does not refuse a webhook — it verifies it against an
    // empty key, so a forged delivery for any shop is accepted. Ten minutes of
    // a failed deploy beats an afternoon of that.
    expect(() => assertEnvironment("production")).toThrow(EnvironmentIncomplete);
    try {
      assertEnvironment("production");
    } catch (error) {
      expect((error as Error).message).toContain("SHOPIFY_API_SECRET");
      expect((error as Error).message).toContain("forged");
    }

    vi.unstubAllEnvs();
  });

  it("only warns outside production, so a contributor still gets a dev server", () => {
    vi.stubEnv("SHOPIFY_API_SECRET", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => assertEnvironment("development")).not.toThrow();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  it("treats a blank value as missing, not as set", () => {
    vi.stubEnv("JOBS_RUNNER_TOKEN", "   ");
    expect(checkEnvironment().missingOptional.map((one) => one.name)).toContain(
      "JOBS_RUNNER_TOKEN",
    );
    vi.unstubAllEnvs();
  });
});

/* -------------------------------------------------------------------------- */

describe("the readiness probe", () => {
  it("is ready when the database answers and nothing is overdue", async () => {
    const response = await ready();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("ready");
    expect(body.database).toBe(true);
    expect(body.runnerStalled).toBe(false);
  });

  it("says the runner has stopped, which nothing said before", async () => {
    await shopScope.run(ALPHA, async () => {
      await db.shop.create({ data: { ...tenant() } });
      await db.scheduledJob.create({
        data: {
          ...tenant(),
          kind: "shop.purge_pii",
          status: "PENDING",
          // Due an hour ago and still pending: the cron that POSTs
          // /internal/jobs/run is not running, and every promise this app
          // makes about deleting data on a schedule is silently unkept.
          runAt: new Date(Date.now() - 60 * 60_000),
        },
      });
    });

    const response = await ready();
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.runnerStalled).toBe(true);
    expect(body.jobs.overdue).toBe(1);
  });

  it("does not call a job that is merely queued for later overdue", async () => {
    await shopScope.run(ALPHA, async () => {
      await db.shop.create({ data: { ...tenant() } });
      await db.scheduledJob.create({
        data: {
          ...tenant(),
          kind: "audit.purge",
          status: "PENDING",
          runAt: new Date(Date.now() + 60 * 60_000),
        },
      });
    });

    const body = await (await ready()).json();
    expect(body.runnerStalled).toBe(false);
    expect(body.jobs.pending).toBe(1);
    expect(body.jobs.overdue).toBe(0);
  });

  it("hands a load balancer no merchant's data", async () => {
    await shopScope.run(ALPHA, async () => {
      await db.shop.create({ data: { ...tenant(), email: "owner@alpha.test" } });
      await db.scheduledJob.create({
        data: {
          ...tenant(),
          kind: "shop.purge_pii",
          status: "FAILED",
          runAt: new Date(Date.now() - 60 * 60_000),
          lastError: "connection to alpha-db-7 refused for user mannon",
        },
      });
    });

    // This endpoint is unauthenticated and read by uptime checks. Counts and
    // booleans only: no shop name, no job payload, no error body.
    const text = JSON.stringify(await (await ready()).json());
    expect(text).not.toContain(ALPHA);
    expect(text).not.toContain("owner@alpha.test");
    expect(text).not.toContain("alpha-db-7");
  });

  it("reports a missing optional key rather than pretending it is fine", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const body = await (await ready()).json();

    // Not a failure — the product works without it — but an operator opening
    // one page should see which parts are switched off here.
    expect(body.missingOptional).toContain("ANTHROPIC_API_KEY");
    expect(body.status).toBe("ready");

    vi.unstubAllEnvs();
  });
});
