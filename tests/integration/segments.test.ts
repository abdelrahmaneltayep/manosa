import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "~/db.server";
import type { SegmentCondition } from "~/lib/customers/segments";
import {
  conditionsOf,
  countSegment,
  deleteSegment,
  listSegments,
  previewSegment,
  saveSegment,
  segmentMemberIds,
  SegmentValidationError,
} from "~/lib/customers/segments.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * Segments against a real database.
 *
 * The count on screen and the members a rule would price come from one
 * function, so these tests are as much about them agreeing as about either
 * being right.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const actor = { type: "STAFF" as const, id: "staff-1" };
const NOW = new Date("2026-06-01T12:00:00Z");
const DAY = 86_400_000;

const usd = (amount: number): SegmentCondition => ({
  field: "lifetime_spend",
  op: "gt",
  amount: { amount, currencyCode: "USD" },
});

async function customer(overrides: Record<string, unknown> = {}) {
  return db.customer.create({
    data: {
      ...tenant(),
      customerId: `gid://shopify/Customer/${Math.random().toString(36).slice(2)}`,
      email: `buyer-${Math.random().toString(36).slice(2)}@acme.test`,
      company: "Acme Ltd",
      tags: ["wholesale"],
      lifetimeSpend: 600_000,
      currencyCode: "USD",
      orderCount: 12,
      lastOrderAt: new Date(NOW.getTime() - 60 * DAY),
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */

describe("counting a segment", () => {
  it("matches on spend in minor units", async () => {
    await inAlpha(async () => {
      await customer({ lifetimeSpend: 600_000 });
      await customer({ lifetimeSpend: 100_000 });

      expect(await countSegment([usd(500_000)], NOW)).toBe(1);
    });
  });

  it("will not compare across currencies", async () => {
    await inAlpha(async () => {
      // ¥600,000 is not $6,000, and the engine refuses to invent a rate. So
      // does this: a buyer priced in another currency is not in the segment.
      await customer({ lifetimeSpend: 600_000, currencyCode: "JPY" });
      expect(await countSegment([usd(500_000)], NOW)).toBe(0);
    });
  });

  it("counts days since the last order, and excludes those who never ordered", async () => {
    await inAlpha(async () => {
      await customer({ lastOrderAt: new Date(NOW.getTime() - 60 * DAY) });
      await customer({ lastOrderAt: new Date(NOW.getTime() - 10 * DAY) });
      await customer({ lastOrderAt: null });

      const quiet: SegmentCondition = { field: "last_order_days", op: "gt", value: 45 };
      expect(await countSegment([quiet], NOW)).toBe(1);

      // "Never ordered" is its own question, and a different answer.
      expect(await countSegment([{ field: "never_ordered" }], NOW)).toBe(1);
    });
  });

  it("ANDs its conditions", async () => {
    await inAlpha(async () => {
      await customer({ lifetimeSpend: 600_000, tags: ["wholesale"] });
      await customer({ lifetimeSpend: 600_000, tags: ["retail"] });

      const conditions: SegmentCondition[] = [
        usd(500_000),
        { field: "tag", op: "has", value: "wholesale" },
      ];
      expect(await countSegment(conditions, NOW)).toBe(1);
    });
  });

  it("leaves out a customer Shopify has deleted", async () => {
    await inAlpha(async () => {
      await customer({ deletedInShopifyAt: new Date() });
      expect(await countSegment([usd(1)], NOW)).toBe(0);
    });
  });

  it("counts nobody for another shop's customers", async () => {
    await inBeta(async () => {
      await customer({ lifetimeSpend: 900_000 });
    });
    await inAlpha(async () => {
      expect(await countSegment([usd(1)], NOW)).toBe(0);
    });
  });
});

describe("previewing", () => {
  it("shows who is in it, not just how many", async () => {
    await inAlpha(async () => {
      await customer({ company: "Big Buyer Ltd", lifetimeSpend: 900_000 });
      const preview = await previewSegment([usd(500_000)], NOW);

      expect(preview.count).toBe(1);
      expect(preview.samples[0]?.name).toBe("Big Buyer Ltd");
      expect(preview.loosen).toBeNull();
    });
  });

  it("names the condition to loosen when nobody matches", async () => {
    await inAlpha(async () => {
      // Matches the tag, misses the spend by a mile.
      await customer({ lifetimeSpend: 1_000, tags: ["wholesale"] });

      const preview = await previewSegment(
        [usd(500_000), { field: "tag", op: "has", value: "wholesale" }],
        NOW,
      );

      expect(preview.count).toBe(0);
      // Dropping the spend condition finds somebody; dropping the tag does not.
      expect(preview.loosen).toBe(0);
    });
  });

  it("says nothing helps when no single condition is the problem", async () => {
    await inAlpha(async () => {
      const preview = await previewSegment(
        [usd(500_000), { field: "tag", op: "has", value: "wholesale" }],
        NOW,
      );
      expect(preview.count).toBe(0);
      expect(preview.loosen).toBeNull();
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("saving", () => {
  it("stores the conditions, the count and who approved it", async () => {
    await inAlpha(async () => {
      await customer({ lifetimeSpend: 900_000 });

      const segment = await saveSegment(
        {
          name: "Big buyers",
          conditions: [usd(500_000)],
          sentence: "buyers who spent over 5000",
          ai: { model: "claude-sonnet-4-5", promptVersion: "1" },
        },
        actor,
        NOW,
      );

      expect(segment.lastCount).toBe(1);
      expect(conditionsOf(segment)).toEqual([usd(500_000)]);

      const entry = await db.auditLog.findFirstOrThrow({
        where: { action: "customer_segment.created" },
      });
      expect(entry.aiAssisted).toBe(true);
      expect(entry.approvedById).toBe("staff-1");
      expect(entry.aiModel).toBe("claude-sonnet-4-5");
    });
  });

  it("leaves a hand-built segment unmarked", async () => {
    await inAlpha(async () => {
      await saveSegment({ name: "By hand", conditions: [usd(1)] }, actor, NOW);

      const entry = await db.auditLog.findFirstOrThrow({
        where: { action: "customer_segment.created" },
      });
      expect(entry.aiAssisted).toBe(false);
      expect(entry.approvedById).toBeNull();
    });
  });

  it("refuses a segment with no name or no conditions", async () => {
    await inAlpha(async () => {
      await expect(
        saveSegment({ name: "", conditions: [usd(1)] }, actor, NOW),
      ).rejects.toBeInstanceOf(SegmentValidationError);
      await expect(
        saveSegment({ name: "Empty", conditions: [] }, actor, NOW),
      ).rejects.toBeInstanceOf(SegmentValidationError);

      expect(await db.customerSegment.count()).toBe(0);
    });
  });

  it("lets two shops use the same segment name", async () => {
    await inAlpha(() =>
      saveSegment({ name: "Big buyers", conditions: [usd(1)] }, actor, NOW),
    );
    await inBeta(() =>
      saveSegment({ name: "Big buyers", conditions: [usd(1)] }, actor, NOW),
    );

    expect(await inAlpha(() => listSegments())).toHaveLength(1);
    expect(await inBeta(() => listSegments())).toHaveLength(1);
  });

  it("refuses the same name twice in one shop", async () => {
    await inAlpha(async () => {
      await saveSegment({ name: "Big buyers", conditions: [usd(1)] }, actor, NOW);
      await expect(
        saveSegment({ name: "Big buyers", conditions: [usd(2)] }, actor, NOW),
      ).rejects.toThrow();
    });
  });

  it("cannot delete another shop's segment", async () => {
    const theirs = await inBeta(() =>
      saveSegment({ name: "Theirs", conditions: [usd(1)] }, actor, NOW),
    );

    await expect(inAlpha(() => deleteSegment(theirs.id, actor))).rejects.toBeInstanceOf(
      Response,
    );

    expect(await inBeta(() => listSegments())).toHaveLength(1);
  });
});

describe("members, for a pricing rule's audience", () => {
  it("returns Shopify customer ids", async () => {
    await inAlpha(async () => {
      const row = await customer({ lifetimeSpend: 900_000 });
      expect(await segmentMemberIds([usd(500_000)], NOW)).toEqual([row.customerId]);
    });
  });

  it("agrees with the count it was previewed on", async () => {
    await inAlpha(async () => {
      await customer({ lifetimeSpend: 900_000 });
      await customer({ lifetimeSpend: 800_000 });
      await customer({ lifetimeSpend: 1_000 });

      const conditions = [usd(500_000)];
      const preview = await previewSegment(conditions, NOW);
      const members = await segmentMemberIds(conditions, NOW);

      expect(members).toHaveLength(preview.count);
    });
  });

  it("never returns another shop's buyers", async () => {
    await inBeta(() => customer({ lifetimeSpend: 900_000 }));
    await inAlpha(async () => {
      expect(await segmentMemberIds([usd(1)], NOW)).toEqual([]);
    });
  });
});
