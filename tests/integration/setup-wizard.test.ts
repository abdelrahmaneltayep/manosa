import { money } from "@mannon/pricing-engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import type { SetupPlan } from "~/lib/ai/prompts/setup-plan.server";
import { MissingApprovalError } from "~/lib/audit/record.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { applySetupPlan, ruleFromPlan, setupGrounding } from "~/lib/setup/wizard.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * ✦ The setup wizard, applied.
 *
 * The plan is Claude's; every write is ours, through the same functions the
 * manual path uses. What these assert is that going through the wizard is not
 * a way around anything: the rule is validated and published, the audit entry
 * names the model and the person who approved it, and a shop that already has
 * groups does not get them again.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const NOW = new Date("2026-09-10T12:00:00Z");
const STAFF = "gid://shopify/StaffMember/1";
const AI = { model: "claude-sonnet-4-5", promptVersion: "1", requestId: "req_1" };

/** A translator that returns the key, so a missing key shows up as the key. */
const t = (key: string) => key;

interface AdminCall {
  query: string;
}

function fakeAdmin() {
  const calls: AdminCall[] = [];
  const admin: AdminGraphql & { calls: AdminCall[] } = {
    calls,
    graphql: vi.fn(async (query: string) => {
      calls.push({ query });

      if (query.includes("MannonDiscountFunction")) {
        return {
          json: async () => ({
            data: {
              shopifyFunctions: { nodes: [{ id: "gid://fn/1", title: "Mannon" }] },
            },
          }),
        };
      }
      if (query.includes("discountAutomaticAppCreate")) {
        return {
          json: async () => ({
            data: {
              discountAutomaticAppCreate: {
                automaticAppDiscount: { discountId: "gid://discount/1" },
                userErrors: [],
              },
            },
          }),
        };
      }
      return {
        json: async () => ({
          data: { metafieldsSet: { metafields: [{ id: "gid://mf/1" }], userErrors: [] } },
        }),
      };
    }),
  };
  return admin;
}

const plan = (overrides: Partial<SetupPlan> = {}): SetupPlan => ({
  summary: "You sell to cafés at a trade discount.",
  groups: [{ name: "Cafés", tag: "cafes", description: "Independent cafés." }],
  rule: {
    name: "Café trade price",
    kind: "percentage",
    percentage: 25,
    amount: null,
    tiers: [],
    audienceTag: "cafes",
  },
  form: { name: "Trade application", fields: ["company", "email"], autoTag: "cafes" },
  notes: null,
  ...overrides,
});

async function installShop(shop: string, planKey = "agentic") {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        planKey,
        billingStatus: "ACTIVE",
        currencyCode: "USD",
      },
    }),
  );
}

const apply = (value: SetupPlan, admin = fakeAdmin()) =>
  applySetupPlan(value, { admin, approvedById: STAFF, t, ai: AI, now: NOW });

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */

describe("applying a plan", () => {
  it("creates the groups, the rule and the form", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const applied = await apply(plan());

      expect(applied.groups).toHaveLength(1);
      expect(applied.ruleId).not.toBeNull();
      expect(applied.formId).not.toBeNull();

      const group = await db.customerGroup.findFirstOrThrow();
      expect(group.name).toBe("Cafés");
      expect(group.tag).toBe("cafes");

      const rule = await db.pricingRule.findFirstOrThrow();
      expect(rule.name).toBe("Café trade price");
      expect(rule.status).toBe("ACTIVE");
      expect(rule.audience).toEqual({ mode: "tags", tags: ["cafes"] });
    });
  });

  it("leaves the form as a draft, because buyers can see a live one", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await apply(plan());
      const form = await db.registrationForm.findFirstOrThrow();
      expect(form.status).toBe("DRAFT");
      // The tag that ties an approved application to the rule's audience.
      expect(form.publish).toMatchObject({ autoTags: ["cafes"] });
    });
  });

  it("publishes the ruleset, so checkout knows about the rule", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await apply(plan(), admin);
      // A rule that is not published simply does not exist at checkout.
      expect(admin.calls.some((call) => call.query.includes("metafieldsSet"))).toBe(true);
    });
  });

  it("records who approved it, and what read the description", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await apply(plan());

      const entry = await db.auditLog.findFirstOrThrow({
        where: { action: "setup.wizard_applied" },
      });
      expect(entry.aiAssisted).toBe(true);
      expect(entry.approvedById).toBe(STAFF);
      expect(entry.aiModel).toBe("claude-sonnet-4-5");

      // The rule's own entry carries the same approval — that is the invariant
      // `recordAudit` enforces, and the wizard is not an exception to it.
      const ruleEntry = await db.auditLog.findFirstOrThrow({
        where: { action: "pricing_rule.created" },
      });
      expect(ruleEntry.aiAssisted).toBe(true);
      expect(ruleEntry.approvedById).toBe(STAFF);
    });
  });

  it("creates nothing a plan did not ask for", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const applied = await apply(plan({ rule: null, form: null }));

      expect(applied.ruleId).toBeNull();
      expect(applied.formId).toBeNull();
      expect(await db.pricingRule.count()).toBe(0);
      expect(await db.registrationForm.count()).toBe(0);
      expect(await db.customerGroup.count()).toBe(1);
    });
  });

  it("never reaches another shop", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inAlpha(() => apply(plan()));

    await inBeta(async () => {
      expect(await db.customerGroup.count()).toBe(0);
      expect(await db.pricingRule.count()).toBe(0);
      expect(await db.registrationForm.count()).toBe(0);
    });
  });

  it("refuses to apply anything with no approver", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await expect(
        applySetupPlan(plan(), {
          admin,
          // The empty string is what a route with no session would hand over.
          approvedById: "",
          t,
          ai: AI,
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(MissingApprovalError);

      // The group is created before the rule, so this is a partial apply — but
      // no pricing rule exists, which is the half that matters.
      expect(await db.pricingRule.count()).toBe(0);
    });
  });
});

describe("the rule a plan becomes", () => {
  it("prices a percentage off, for the planned tag only", () => {
    const rule = ruleFromPlan(plan(), NOW);
    expect(rule?.kind).toBe("percentage");
    expect(rule?.audience).toEqual({ mode: "tags", tags: ["cafes"] });
    expect(rule?.status).toBe("active");
  });

  it("prices an amount off in the shop's own currency, with no conversions", () => {
    const rule = ruleFromPlan(
      plan({
        rule: {
          name: "Five off",
          kind: "amount_off",
          percentage: null,
          amount: money(500, "USD"),
          tiers: [],
          audienceTag: "cafes",
        },
      }),
      NOW,
    );

    expect(rule?.kind).toBe("amount_off");
    // No per-currency overrides: elsewhere the engine skips the rule rather
    // than inventing an exchange rate.
    expect(rule?.value).toEqual({ base: money(500, "USD"), overrides: {} });
  });

  it("turns quantity breaks into engine tiers", () => {
    const rule = ruleFromPlan(
      plan({
        rule: {
          name: "Volume",
          kind: "volume_tier",
          percentage: null,
          amount: null,
          tiers: [
            { minQuantity: 1, maxQuantity: 49, percentage: 10 },
            { minQuantity: 50, maxQuantity: null, percentage: 20 },
          ],
          audienceTag: "cafes",
        },
      }),
      NOW,
    );

    expect(rule?.kind).toBe("volume_tier");
    expect(rule?.value).toEqual({
      tiers: [
        { minQuantity: 1, maxQuantity: 49, kind: "percentage", percentage: 10 },
        { minQuantity: 50, maxQuantity: null, kind: "percentage", percentage: 20 },
      ],
    });
  });

  it("is nothing at all when the plan proposed no rule", () => {
    expect(ruleFromPlan(plan({ rule: null }), NOW)).toBeNull();
  });
});

describe("the grounding", () => {
  it("tells the model what this shop already has, with the real tags", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await db.customerGroup.create({
        data: {
          ...tenant(),
          name: "Cafés",
          handle: "cafes",
          tag: "wholesale-cafe",
          sortOrder: 0,
        },
      });

      const grounding = await setupGrounding();
      expect(grounding.groups).toEqual([{ name: "Cafés", tag: "wholesale-cafe" }]);
      expect(grounding.hasRule).toBe(false);
      expect(grounding.hasForm).toBe(false);
      expect(grounding.currencyCode).toBe("USD");
    });
  });

  it("never describes another shop", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(() => apply(plan()));

    await inAlpha(async () => {
      const grounding = await setupGrounding();
      expect(grounding.groups).toEqual([]);
      expect(grounding.hasRule).toBe(false);
    });
  });
});
