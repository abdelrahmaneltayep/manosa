/**
 * Cold-read probe: a pricing rule belonging to another shop, fetched by its
 * raw id. It must read as not found, never as a leak.
 * Run: npx vitest run --config qa/1.1-1.2/cold-read/vitest.config.ts
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "~/db.server";
import { getRule, listRules } from "~/lib/pricing/rules.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../../../tests/support/db";

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

describe("another shop's pricing rule", () => {
  it("is not readable by id", async () => {
    const alphaRule = await shopScope.run(ALPHA, async () => {
      await db.shop.create({ data: { ...tenant() } });
      return db.pricingRule.create({
        data: {
          ...tenant(),
          name: "Alpha contract price",
          kind: "PERCENTAGE",
          status: "ACTIVE",
          priority: 10,
          combinable: false,
          value: { percentage: 35 },
          targets: { mode: "all" },
          audience: { mode: "all" },
          markets: { mode: "all", marketIds: [] },
        },
      });
    });

    const seenFromBeta = await shopScope.run(BETA, async () => {
      await db.shop.create({ data: { ...tenant() } });
      return {
        byId: await getRule(alphaRule.id),
        list: (await listRules()).rows.length,
      };
    });

    expect(seenFromBeta).toEqual({ byId: null, list: 0 });
  });

  it("cannot be read with no shop context at all", async () => {
    await expect(getRule("anything")).rejects.toThrow();
  });
});
