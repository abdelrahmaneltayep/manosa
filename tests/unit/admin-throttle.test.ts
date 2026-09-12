import { describe, expect, it, vi } from "vitest";

import {
  AdminApiError,
  MAX_THROTTLE_WAIT_MS,
  runMutation,
  runQuery,
  THROTTLE_RETRIES,
  throttleWaitMs,
  type AdminGraphql,
} from "~/lib/pricing/admin-graphql.server";

/**
 * Being rate limited is not a failure.
 *
 * Shopify's Admin API is cost-based: a request that would overdraw the bucket
 * comes back as a top-level error, and both readers used to turn any top-level
 * error into a thrown `AdminApiError`. On a big store that meant a merchant
 * pressing Save on a pricing rule was told the publish failed when the honest
 * answer was "in a moment" — and `CLAUDE.md`'s own test matrix names a
 * 10k-product store as a required scenario.
 */

const THROTTLED = {
  errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
  extensions: {
    cost: {
      requestedQueryCost: 100,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 50, restoreRate: 50 },
    },
  },
};

/** An admin that answers with the given bodies in order. */
function admin(...bodies: unknown[]): AdminGraphql & { calls: number } {
  const stub = {
    calls: 0,
    graphql: async () => {
      const body = bodies[Math.min(stub.calls, bodies.length - 1)];
      stub.calls += 1;
      return { json: async () => body };
    },
  };
  return stub;
}

const ok = { data: { thing: { id: "gid://shopify/Thing/1" }, userErrors: [] } };
const read = (data: Record<string, unknown>) => ({
  result: (data.thing as { id: string }).id,
  userErrors: [] as { message: string }[],
});

/* -------------------------------------------------------------------------- */

describe("how long to wait", () => {
  it("is arithmetic on Shopify's own figures, not a guess", () => {
    // 100 needed, 50 available, 50 restored a second → one second.
    expect(throttleWaitMs(THROTTLED)).toBe(1000);
  });

  it("is nothing when the points are already there", () => {
    expect(
      throttleWaitMs({
        extensions: {
          cost: {
            requestedQueryCost: 10,
            throttleStatus: { currentlyAvailable: 900, restoreRate: 50 },
          },
        },
      }),
    ).toBe(0);
  });

  it("is unknown rather than invented when Shopify did not say", () => {
    // A blind wait is honest; a number made up from nothing is not.
    expect(throttleWaitMs({ errors: [{ message: "Throttled" }] })).toBeNull();
    expect(
      throttleWaitMs({
        extensions: {
          cost: { requestedQueryCost: 100, throttleStatus: { restoreRate: 0 } },
        },
      }),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("a throttled request", () => {
  it("waits the time Shopify asked for and then succeeds", async () => {
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    const api = admin(THROTTLED, ok);

    const result = await runMutation(api, "thingUpdate", "mutation {}", {}, read, {
      sleep,
    });

    expect(result).toBe("gid://shopify/Thing/1");
    expect(api.calls).toBe(2);
    expect(slept).toEqual([1000]);
  });

  it("is safe to resend, which is the whole reason this is allowed", async () => {
    // A throttled request is rejected before Shopify runs it, so the mutation
    // never happened on the attempt that bounced. That is not true of a
    // timeout, and neither of those is retried here.
    const api = admin(THROTTLED, THROTTLED, ok);
    await runMutation(api, "thingUpdate", "mutation {}", {}, read, {
      sleep: async () => {},
    });

    expect(api.calls).toBe(THROTTLE_RETRIES + 1);
  });

  it("gives up rather than holding a page nobody is still watching", async () => {
    const slow = {
      ...THROTTLED,
      extensions: {
        cost: {
          requestedQueryCost: 1000,
          throttleStatus: { currentlyAvailable: 0, restoreRate: 1 },
        },
      },
    };
    expect(throttleWaitMs(slow)).toBeGreaterThan(MAX_THROTTLE_WAIT_MS);

    const api = admin(slow);
    const sleep = vi.fn(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      runQuery(api, "thingRead", "query {}", {}, { sleep }),
    ).rejects.toBeInstanceOf(AdminApiError);

    // It did not wait sixteen minutes to fail.
    expect(sleep).not.toHaveBeenCalled();
    expect(api.calls).toBe(1);
    warn.mockRestore();
  });

  it("tells the merchant nothing was changed, which is true", async () => {
    const api = admin(THROTTLED);
    try {
      await runQuery(api, "thingRead", "query {}", {}, { sleep: async () => {} });
      expect.unreachable("should have thrown");
    } catch (error) {
      const failure = error as AdminApiError;
      expect(failure).toBeInstanceOf(AdminApiError);
      expect(failure.userErrors[0]!.code).toBe("THROTTLED");
      // The one thing a merchant needs to know before pressing Save again.
      expect(failure.message).toContain("Nothing was changed");
      expect(failure.message).toContain("try again");
    }
  });

  it("waits blind rather than not at all when Shopify gave no figures", async () => {
    const slept: number[] = [];
    const api = admin({ errors: [{ message: "Throttled" }] }, ok);

    await runQuery(
      api,
      "thingRead",
      "query {}",
      {},
      {
        sleep: async (ms) => void slept.push(ms),
      },
    );

    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */

describe("everything that is not a throttle", () => {
  it("is raised at once, and never retried", async () => {
    // A real error re-sent is a mutation that might run twice.
    const api = admin({ errors: [{ message: "Field 'nope' doesn't exist" }] });

    await expect(
      runMutation(api, "thingUpdate", "mutation {}", {}, read, { sleep: async () => {} }),
    ).rejects.toThrow("doesn't exist");
    expect(api.calls).toBe(1);
  });

  it("still turns userErrors into a failure", async () => {
    const api = admin({
      data: { thing: null, userErrors: [{ message: "Handle is taken" }] },
    });

    await expect(
      runMutation(
        api,
        "thingUpdate",
        "mutation {}",
        {},
        (data) => ({
          result: data.thing as string,
          userErrors: (data as { userErrors: { message: string }[] }).userErrors,
        }),
        { sleep: async () => {} },
      ),
    ).rejects.toThrow("Handle is taken");
  });

  it("costs a successful call nothing", async () => {
    const api = admin(ok);
    const sleep = vi.fn(async () => {});

    await runMutation(api, "thingUpdate", "mutation {}", {}, read, { sleep });

    expect(api.calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
