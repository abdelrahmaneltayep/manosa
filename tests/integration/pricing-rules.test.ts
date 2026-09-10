import { parseMoney, type PricingRule } from "@mannon/pricing-engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { LimitReachedError } from "~/lib/billing/gate.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { toEngineRule } from "~/lib/pricing/rule-mapper.server";
import {
  activeEngineRules,
  archiveRule,
  createRule,
  deleteRule,
  findDuplicateName,
  listRules,
  reorderRules,
  restoreRule,
  RuleConflictError,
  RuleValidationError,
  updateRule,
} from "~/lib/pricing/rules.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const rule = (overrides: Partial<PricingRule> = {}): PricingRule =>
  ({
    id: "new",
    name: "Wholesale 35%",
    status: "active",
    priority: 100,
    combinable: false,
    kind: "percentage",
    value: { percentage: 35 },
    targets: { mode: "all" },
    audience: { mode: "tags", tags: ["wholesale"] },
    markets: { mode: "all", marketIds: [] },
    schedule: { startsAt: null, endsAt: null },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }) as PricingRule;

function fakeAdmin(): AdminGraphql & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    graphql: vi.fn(async (query: string) => {
      calls.push(query);
      const data = query.includes("MannonDiscountFunction")
        ? { shopifyFunctions: { nodes: [{ id: "gid://fn/1", title: "Mannon" }] } }
        : query.includes("MannonCreateDiscount")
          ? {
              discountAutomaticAppCreate: {
                automaticAppDiscount: { discountId: "gid://discount/1" },
                userErrors: [],
              },
            }
          : { metafieldsSet: { metafields: [{ id: "gid://mf/1" }], userErrors: [] } };
      return { json: async () => ({ data }) };
    }),
  };
}

const actor = { type: "STAFF" as const, id: "staff-1" };
const ctx = () => ({ admin: fakeAdmin(), actor });

async function installShop(shop: string, planKey = "pro") {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: { ...tenant(), planKey, billingStatus: "ACTIVE", currencyCode: "USD" },
    }),
  );
}

const published = (admin: { calls: string[] }) =>
  admin.calls.filter((query) => query.includes("MannonSetMetafields")).length;

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

describe("creating a rule", () => {
  it("stores it and publishes it to checkout", async () => {
    await installShop(ALPHA);
    const context = ctx();

    const created = await inAlpha(() => createRule(rule(), context));

    expect(created.name).toBe("Wholesale 35%");
    expect(created.status).toBe("ACTIVE");
    // A rule nobody published does not exist at checkout, so saving must push.
    expect(published(context.admin)).toBeGreaterThan(0);
  });

  it("does not publish a draft", async () => {
    await installShop(ALPHA);
    const context = ctx();

    await inAlpha(() => createRule(rule({ status: "draft" }), context));

    expect(published(context.admin)).toBe(0);
  });

  it("round-trips through the database unchanged", async () => {
    await installShop(ALPHA);
    const original = rule({
      kind: "volume_tier",
      value: {
        tiers: [
          { minQuantity: 5, maxQuantity: 19, kind: "percentage", percentage: 5 },
          {
            minQuantity: 20,
            maxQuantity: null,
            kind: "fixed_price",
            amount: parseMoney("8.80", "USD"),
          },
        ],
      },
      targets: {
        mode: "collections",
        collectionIds: ["c-1"],
        excludeCollectionIds: ["c-sale"],
      },
      schedule: { startsAt: new Date("2026-06-01T00:00:00Z"), endsAt: null },
    });

    const created = await inAlpha(() => createRule(original, ctx()));
    const back = toEngineRule(created);

    expect(back.kind).toBe("volume_tier");
    expect(back.value).toEqual(original.value);
    expect(back.targets).toEqual(original.targets);
    expect(back.schedule.startsAt?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("refuses an invalid rule before it reaches the database", async () => {
    await installShop(ALPHA);

    await expect(
      inAlpha(() => createRule(rule({ name: "  " }), ctx())),
    ).rejects.toBeInstanceOf(RuleValidationError);

    expect(await inAlpha(() => db.pricingRule.count())).toBe(0);
  });

  /** Free allows one rule; the count and the insert must not drift apart. */
  it("enforces the plan's rule quota", async () => {
    await installShop(ALPHA, "free");
    await inAlpha(() => createRule(rule({ name: "First" }), ctx()));

    await expect(
      inAlpha(() => createRule(rule({ name: "Second" }), ctx())),
    ).rejects.toBeInstanceOf(LimitReachedError);
  });

  it("allows a duplicate name but can report it", async () => {
    await installShop(ALPHA);
    await inAlpha(() => createRule(rule({ name: "Summer tiers" }), ctx()));
    await inAlpha(() => createRule(rule({ name: "Summer tiers" }), ctx()));

    expect(await inAlpha(() => db.pricingRule.count())).toBe(2);
    expect(await inAlpha(() => findDuplicateName("summer tiers"))).not.toBeNull();
  });
});

describe("editing a rule", () => {
  it("saves and bumps the version", async () => {
    await installShop(ALPHA);
    const created = await inAlpha(() => createRule(rule(), ctx()));

    const updated = await inAlpha(() =>
      updateRule(
        created.id,
        rule({ name: "Wholesale 40%", value: { percentage: 40 } }),
        1,
        ctx(),
      ),
    );

    expect(updated.name).toBe("Wholesale 40%");
    expect(updated.version).toBe(2);
  });

  /**
   * Two staff saving at once must not both believe they won — a silently
   * overwritten pricing change is discovered from a customer's invoice.
   */
  it("refuses a save built on a stale version, and shows theirs", async () => {
    await installShop(ALPHA);
    const created = await inAlpha(() => createRule(rule(), ctx()));

    // A colleague saves first.
    await inAlpha(() => updateRule(created.id, rule({ name: "Theirs" }), 1, ctx()));

    await expect(
      inAlpha(() => updateRule(created.id, rule({ name: "Mine" }), 1, ctx())),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RuleConflictError &&
        error.current.name === "Theirs" &&
        error.current.version === 2,
    );

    const row = await inAlpha(() =>
      db.pricingRule.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(row.name).toBe("Theirs");
  });

  it("lets the merchant overwrite once they have seen the conflict", async () => {
    await installShop(ALPHA);
    const created = await inAlpha(() => createRule(rule(), ctx()));
    await inAlpha(() => updateRule(created.id, rule({ name: "Theirs" }), 1, ctx()));

    const forced = await inAlpha(() =>
      updateRule(created.id, rule({ name: "Mine" }), 2, ctx()),
    );
    expect(forced.name).toBe("Mine");
  });

  it("republishes when a rule stops being active", async () => {
    await installShop(ALPHA);
    const created = await inAlpha(() => createRule(rule(), ctx()));
    const context = ctx();

    await inAlpha(() => updateRule(created.id, rule({ status: "draft" }), 1, context));

    // Checkout has to learn the rule is gone, not just that it changed.
    expect(published(context.admin)).toBeGreaterThan(0);
  });
});

describe("archiving and deleting", () => {
  it("archives without deleting, and takes it out of checkout", async () => {
    await installShop(ALPHA);
    const created = await inAlpha(() => createRule(rule(), ctx()));
    const context = ctx();

    await inAlpha(() => archiveRule(created.id, context));

    const row = await inAlpha(() =>
      db.pricingRule.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(row.archivedAt).toBeInstanceOf(Date);
    expect(row.status).toBe("ARCHIVED");
    expect(published(context.admin)).toBeGreaterThan(0);

    const { rules } = await inAlpha(activeEngineRules);
    expect(rules).toEqual([]);
  });

  /** A rule that stopped applying weeks ago must not start charging on one click. */
  it("restores as a draft, never straight back to live", async () => {
    await installShop(ALPHA);
    const created = await inAlpha(() => createRule(rule(), ctx()));
    await inAlpha(() => archiveRule(created.id, ctx()));

    const restored = await inAlpha(() => restoreRule(created.id, ctx()));
    expect(restored.status).toBe("DRAFT");
    expect(restored.archivedAt).toBeNull();
  });

  it("refuses to permanently delete a rule that is still live", async () => {
    await installShop(ALPHA);
    const created = await inAlpha(() => createRule(rule(), ctx()));

    await expect(inAlpha(() => deleteRule(created.id, ctx()))).rejects.toThrow(/Archive/);
    expect(await inAlpha(() => db.pricingRule.count())).toBe(1);
  });

  it("deletes an archived rule permanently", async () => {
    await installShop(ALPHA);
    const created = await inAlpha(() => createRule(rule(), ctx()));
    await inAlpha(() => archiveRule(created.id, ctx()));
    await inAlpha(() => deleteRule(created.id, ctx()));

    expect(await inAlpha(() => db.pricingRule.count())).toBe(0);
    const entry = await inAlpha(() =>
      db.auditLog.findFirstOrThrow({ where: { action: "pricing_rule.deleted" } }),
    );
    expect(entry.summary).toContain("Wholesale 35%");
  });
});

describe("the list", () => {
  it("separates live rules from archived ones", async () => {
    await installShop(ALPHA);
    const a = await inAlpha(() => createRule(rule({ name: "Live" }), ctx()));
    const b = await inAlpha(() => createRule(rule({ name: "Gone" }), ctx()));
    await inAlpha(() => archiveRule(b.id, ctx()));

    const live = await inAlpha(() => listRules());
    const archived = await inAlpha(() => listRules({ archived: true }));

    expect(live.rows.map((row) => row.id)).toEqual([a.id]);
    expect(archived.rows.map((row) => row.id)).toEqual([b.id]);
  });

  it("orders by priority, then age, matching how the engine resolves them", async () => {
    await installShop(ALPHA);
    await inAlpha(() => createRule(rule({ name: "Third", priority: 300 }), ctx()));
    await inAlpha(() => createRule(rule({ name: "First", priority: 10 }), ctx()));
    await inAlpha(() => createRule(rule({ name: "Second", priority: 200 }), ctx()));

    const page = await inAlpha(() => listRules());
    expect(page.rows.map((row) => row.name)).toEqual(["First", "Second", "Third"]);
  });

  it("searches by name, and still reports how many rules exist", async () => {
    await installShop(ALPHA);
    await inAlpha(() => createRule(rule({ name: "Gold tier" }), ctx()));
    await inAlpha(() => createRule(rule({ name: "Silver tier" }), ctx()));

    const page = await inAlpha(() => listRules({ search: "gold" }));
    expect(page.rows).toHaveLength(1);
    // Tells "no rules yet" apart from "no rules match", which are different screens.
    expect(page.totalUnfiltered).toBe(2);
  });

  it("paginates rather than rendering hundreds of rows", async () => {
    await installShop(ALPHA);
    for (let index = 0; index < 12; index += 1) {
      await inAlpha(() =>
        createRule(rule({ name: `Rule ${index}`, status: "draft" }), ctx()),
      );
    }

    const page = await inAlpha(() => listRules({ pageSize: 5, page: 2 }));
    expect(page.rows).toHaveLength(5);
    expect(page.total).toBe(12);
  });
});

describe("priority order", () => {
  it("rewrites priorities in the order the merchant left them", async () => {
    await installShop(ALPHA);
    const a = await inAlpha(() => createRule(rule({ name: "A", priority: 100 }), ctx()));
    const b = await inAlpha(() => createRule(rule({ name: "B", priority: 100 }), ctx()));

    await inAlpha(() => reorderRules([b.id, a.id], ctx()));

    const page = await inAlpha(() => listRules());
    expect(page.rows.map((row) => row.name)).toEqual(["B", "A"]);
    // Spaced, so a rule can later be dropped between two without a rewrite.
    expect(page.rows.map((row) => row.priority)).toEqual([10, 20]);
  });
});

describe("tenant isolation", () => {
  it("does not show one shop's rules to another", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    await inAlpha(() => createRule(rule({ name: "Alpha only" }), ctx()));

    expect((await inBeta(() => listRules())).rows).toEqual([]);
    expect((await inBeta(activeEngineRules)).rules).toEqual([]);
  });

  it("cannot fetch another shop's rule by id", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const created = await inAlpha(() => createRule(rule(), ctx()));

    expect(
      await inBeta(() => db.pricingRule.findUnique({ where: { id: created.id } })),
    ).toBeNull();
  });

  it("cannot archive another shop's rule", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const created = await inAlpha(() => createRule(rule(), ctx()));

    await expect(inBeta(() => archiveRule(created.id, ctx()))).rejects.toBeInstanceOf(
      Response,
    );

    const row = await inAlpha(() =>
      db.pricingRule.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(row.archivedAt).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("a rule Claude drafted", () => {
  const provenance = {
    ai: { model: "claude-sonnet-4-5", promptVersion: "1", requestId: "msg_01test" },
    approvedById: "staff-1",
    metadata: { sentence: "Buy 10 get 5%", approvedAnyway: false },
  };

  it("records who approved it, and what they were shown", async () => {
    await installShop(ALPHA);
    const created = await inAlpha(() => createRule(rule(), { ...ctx(), provenance }));

    const entry = await inAlpha(() =>
      db.auditLog.findFirstOrThrow({
        where: { action: "pricing_rule.created", subjectId: created.id },
      }),
    );

    expect(entry.aiAssisted).toBe(true);
    expect(entry.approvedById).toBe("staff-1");
    expect(entry.approvedAt).not.toBeNull();
    expect(entry.aiModel).toBe("claude-sonnet-4-5");
    expect(entry.aiRequestId).toBe("msg_01test");
    // The prompt that made it, kept with the rule it made — checklist §2.
    expect(entry.metadata).toMatchObject({ sentence: "Buy 10 get 5%" });
  });

  it("is an ordinary rule once approved: same validation, same publish", async () => {
    await installShop(ALPHA);
    const context = { ...ctx(), provenance };
    const created = await inAlpha(() => createRule(rule(), context));

    expect(created.status).toBe("ACTIVE");
    expect(context.admin.calls.some((query) => query.includes("metafieldsSet"))).toBe(
      true,
    );
  });

  it("refuses to record an approval nobody gave", async () => {
    await installShop(ALPHA);

    await expect(
      inAlpha(() =>
        createRule(rule(), {
          ...ctx(),
          // The compiler stops this at every call site in the app; this proves
          // the runtime refuses it too, because the invariant is the point.
          provenance: { ...provenance, approvedById: "" },
        }),
      ),
    ).rejects.toThrow(/aiAssisted/);

    // And leaves no rule behind: a live price nobody approved is exactly what
    // the refusal exists to prevent.
    expect(await inAlpha(() => db.pricingRule.count())).toBe(0);
  });

  it("leaves a hand-built rule unmarked", async () => {
    await installShop(ALPHA);
    const created = await inAlpha(() => createRule(rule(), ctx()));

    const entry = await inAlpha(() =>
      db.auditLog.findFirstOrThrow({
        where: { action: "pricing_rule.created", subjectId: created.id },
      }),
    );

    expect(entry.aiAssisted).toBe(false);
    expect(entry.approvedById).toBeNull();
    expect(entry.aiModel).toBeNull();
  });
});
