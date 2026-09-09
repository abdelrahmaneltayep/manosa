import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import {
  errorCsv,
  estimatePublishedSize,
  runImport,
  undoImport,
  UndoExpiredError,
  UNDO_WINDOW_MS,
} from "~/lib/pricing/csv/import.server";
import { parseCsv } from "~/lib/pricing/csv/parse";
import { planImport } from "~/lib/pricing/csv/plan";
import { resolveSkus } from "~/lib/pricing/csv/skus.server";
import { exportFor, templateCsv } from "~/lib/pricing/csv/export.server";
import { detectTemplate } from "~/lib/pricing/csv/templates";
import { listRules } from "~/lib/pricing/rules.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);
const actor = { type: "STAFF" as const, id: "staff-1" };

const HEADER =
  "rule_name,type,value,applies_to,skus,customer_tags,status,priority,combinable,starts_at,ends_at";

function fakeAdmin(
  variants: Record<string, string> = {},
): AdminGraphql & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    graphql: vi.fn(async (query: string) => {
      calls.push(query);
      const data = query.includes("MannonVariantsBySku")
        ? {
            productVariants: {
              nodes: Object.entries(variants).map(([sku, id]) => ({ id, sku })),
            },
          }
        : query.includes("MannonDiscountFunction")
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

async function installShop(shop: string, planKey = "pro") {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: { ...tenant(), planKey, billingStatus: "ACTIVE", currencyCode: "USD" },
    }),
  );
}

function planFor(csv: string, skuToVariantId = new Map<string, string>()) {
  const doc = parseCsv(csv);
  return planImport(doc, detectTemplate(doc.headers)!, {
    currencyCode: "USD",
    skuToVariantId,
    existingNames: new Set(),
    now: new Date("2026-06-15T12:00:00Z"),
  });
}

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

describe("running an import", () => {
  it("creates the planned rules and records the run", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();
    const plan = planFor(
      `${HEADER}\nA,percentage,10,all,,wholesale,active,100,no,,\n` +
        `B,percentage,20,all,,wholesale,active,100,no,,\n`,
    );

    const result = await inAlpha(() =>
      runImport(plan, { fileName: "prices.csv", admin, actor }),
    );

    expect(result.created).toBe(2);
    expect((await inAlpha(() => listRules())).rows.map((row) => row.name).sort()).toEqual(
      ["A", "B"],
    );

    const record = await inAlpha(() =>
      db.ruleImport.findUniqueOrThrow({ where: { id: result.importId } }),
    );
    expect(record.fileName).toBe("prices.csv");
    expect(record.createdCount).toBe(2);
  });

  it("publishes to checkout when the import includes a live rule", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();
    await inAlpha(() =>
      runImport(planFor(`${HEADER}\nA,percentage,10,all,,wholesale,active,100,no,,\n`), {
        fileName: "f.csv",
        admin,
        actor,
      }),
    );

    expect(admin.calls.some((query) => query.includes("MannonSetMetafields"))).toBe(true);
  });

  it("does not publish an import of drafts", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();
    await inAlpha(() =>
      runImport(planFor(`${HEADER}\nA,percentage,10,all,,wholesale,draft,100,no,,\n`), {
        fileName: "f.csv",
        admin,
        actor,
      }),
    );

    expect(admin.calls.some((query) => query.includes("MannonSetMetafields"))).toBe(
      false,
    );
  });

  /** Importing 200 rules on a plan that allows one should fail before insert one. */
  it("checks the plan quota for the whole batch, not per row", async () => {
    await installShop(ALPHA, "free");
    const plan = planFor(
      `${HEADER}\nA,percentage,10,all,,wholesale,draft,100,no,,\n` +
        `B,percentage,20,all,,wholesale,draft,100,no,,\n`,
    );

    await expect(
      inAlpha(() => runImport(plan, { fileName: "f.csv", admin: fakeAdmin(), actor })),
    ).rejects.toThrow(/pricingRules/);

    expect(await inAlpha(() => db.pricingRule.count())).toBe(0);
  });

  it("writes an audit entry naming the file", async () => {
    await installShop(ALPHA);
    await inAlpha(() =>
      runImport(planFor(`${HEADER}\nA,percentage,10,all,,wholesale,draft,100,no,,\n`), {
        fileName: "june-prices.csv",
        admin: fakeAdmin(),
        actor,
      }),
    );

    const entry = await inAlpha(() =>
      db.auditLog.findFirstOrThrow({ where: { action: "pricing_rule.imported" } }),
    );
    expect(entry.summary).toContain("june-prices.csv");
  });
});

describe("undoing an import", () => {
  const importOne = async (admin = fakeAdmin()) =>
    inAlpha(() =>
      runImport(
        planFor(
          `${HEADER}\nA,percentage,10,all,,wholesale,active,100,no,,\n` +
            `B,percentage,20,all,,wholesale,active,100,no,,\n`,
        ),
        { fileName: "f.csv", admin, actor },
      ),
    );

  it("removes exactly the rules it created", async () => {
    await installShop(ALPHA);
    // A rule the merchant wrote by hand, which undo must not touch.
    await inAlpha(() =>
      db.pricingRule.create({
        data: {
          ...tenant(),
          name: "Written by hand",
          kind: "PERCENTAGE",
          value: { percentage: 5 },
          targets: { mode: "all" },
          audience: { mode: "all" },
          markets: { mode: "all", marketIds: [] },
        },
      }),
    );

    const result = await importOne();
    const undone = await inAlpha(() =>
      undoImport(result.importId, { admin: fakeAdmin(), actor }),
    );

    expect(undone.deleted).toBe(2);
    const left = await inAlpha(() => db.pricingRule.findMany());
    expect(left.map((row) => row.name)).toEqual(["Written by hand"]);
  });

  it("republishes so checkout drops the imported rules too", async () => {
    await installShop(ALPHA);
    const result = await importOne();
    const admin = fakeAdmin();

    await inAlpha(() => undoImport(result.importId, { admin, actor }));
    expect(admin.calls.some((query) => query.includes("MannonSetMetafields"))).toBe(true);
  });

  it("is safe to click twice", async () => {
    await installShop(ALPHA);
    const result = await importOne();

    await inAlpha(() => undoImport(result.importId, { admin: fakeAdmin(), actor }));
    const second = await inAlpha(() =>
      undoImport(result.importId, { admin: fakeAdmin(), actor }),
    );

    expect(second).toEqual({ deleted: 0, alreadyUndone: true });
  });

  it("stops offering one-click undo after an hour", async () => {
    await installShop(ALPHA);
    const result = await importOne();
    const later = new Date(Date.now() + UNDO_WINDOW_MS + 1000);

    await expect(
      inAlpha(() =>
        undoImport(result.importId, { admin: fakeAdmin(), actor, now: later }),
      ),
    ).rejects.toBeInstanceOf(UndoExpiredError);

    // The rules are still there — expiry removes the shortcut, not the data.
    expect(await inAlpha(() => db.pricingRule.count())).toBe(2);
  });

  it("cannot undo another shop's import", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const result = await importOne();

    await expect(
      inBeta(() => undoImport(result.importId, { admin: fakeAdmin(), actor })),
    ).rejects.toBeInstanceOf(Response);

    expect(await inAlpha(() => db.pricingRule.count())).toBe(2);
  });
});

describe("the size check", () => {
  /**
   * Publishing fails on the whole set, so a merchant would otherwise import two
   * hundred rules and only then find checkout still on the old prices.
   */
  it("warns before importing, not after", () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      ...planFor(
        `${HEADER}\nRule ${index} with a fairly long name,percentage,10,all,,wholesale,active,100,no,,\n`,
      ).planned[0]!.rule,
      id: `r${index}`,
    }));

    const small = estimatePublishedSize([], many.slice(0, 5));
    const big = estimatePublishedSize([], many);

    expect(small.exceeds).toBe(false);
    expect(big.exceeds).toBe(true);
  });

  it("counts what is already published, not just the new rules", () => {
    const rule = planFor(`${HEADER}\nA,percentage,10,all,,wholesale,active,100,no,,\n`)
      .planned[0]!.rule;
    const existing = Array.from({ length: 300 }, (_, index) => ({
      ...rule,
      id: `e${index}`,
    }));

    expect(estimatePublishedSize(existing, [rule]).exceeds).toBe(true);
  });

  it("ignores drafts, which never reach checkout", () => {
    const draft = planFor(`${HEADER}\nA,percentage,10,all,,wholesale,draft,100,no,,\n`)
      .planned[0]!.rule;
    const many = Array.from({ length: 400 }, (_, index) => ({
      ...draft,
      id: `d${index}`,
    }));
    expect(estimatePublishedSize([], many).exceeds).toBe(false);
  });
});

describe("the problem report", () => {
  it("lists every problem with its line, sorted", () => {
    const plan = planFor(
      `${HEADER}\n` +
        `A,mystery,10,all,,wholesale,draft,100,no,,\n` +
        `B,percentage,0,all,,wholesale,draft,100,no,,\n`,
    );

    const csv = errorCsv(
      plan,
      (code, params) => `${code}:${JSON.stringify(params ?? {})}`,
    );
    const lines = csv.trim().split("\r\n");

    expect(lines[0]).toBe("line,column,severity,problem");
    expect(lines[1]).toContain("2,type,error");
    expect(lines[2]).toContain("3,,warning");
  });
});

describe("resolving SKUs", () => {
  it("matches exactly, never fuzzily", async () => {
    // Shopify's search is fuzzy at the edges; pricing the wrong variant is
    // worse than reporting an unknown SKU.
    const admin = fakeAdmin({ "ABC-1": "gid://v/1", "ABC-10": "gid://v/10" });
    const found = await resolveSkus(admin, ["ABC-1"]);

    expect(found.get("ABC-1")).toBe("gid://v/1");
    expect(found.has("ABC-10")).toBe(false);
  });

  it("does not call Shopify when the file has no SKUs", async () => {
    const admin = fakeAdmin();
    expect((await resolveSkus(admin, [])).size).toBe(0);
    expect(admin.calls).toEqual([]);
  });
});

describe("export", () => {
  it("round-trips: export, re-read, same rules", async () => {
    await installShop(ALPHA);
    await inAlpha(() =>
      runImport(
        planFor(
          `${HEADER}\nWholesale 35%,percentage,35,all,,wholesale,active,100,no,,\n` +
            `Contract,fixed_price,8.00,all,,wholesale,draft,50,yes,,\n`,
        ),
        { fileName: "f.csv", admin: fakeAdmin(), actor },
      ),
    );

    const page = await inAlpha(() => listRules());
    const csv = exportFor("rules", page.rows);
    const replan = planFor(csv);

    expect(replan.errors).toEqual([]);
    expect(replan.planned.map((item) => item.rule.name).sort()).toEqual([
      "Contract",
      "Wholesale 35%",
    ]);
    expect(
      replan.planned.find((item) => item.rule.name === "Contract")!.rule,
    ).toMatchObject({
      kind: "fixed_price",
      combinable: true,
      priority: 50,
    });
  });

  it("ships a template a merchant can fill in and import back", () => {
    const csv = templateCsv("rules");
    const replan = planFor(csv);
    expect(replan.errors).toEqual([]);
    expect(replan.planned.length).toBeGreaterThan(0);
  });

  it("puts quantity breaks in their own sheet", async () => {
    await installShop(ALPHA);
    const breaks =
      "rule_name,applies_to,skus,customer_tags,min_quantity,max_quantity,discount_type,discount_value,status,priority\n" +
      "Gold,all,,wholesale,5,19,percentage,5,active,100\n" +
      "Gold,all,,wholesale,20,,percentage,12,active,100\n";

    await inAlpha(() =>
      runImport(planFor(breaks), { fileName: "b.csv", admin: fakeAdmin(), actor }),
    );

    const page = await inAlpha(() => listRules());
    // A volume rule does not fit one row, so the rules sheet leaves it out.
    expect(exportFor("rules", page.rows).trim().split("\r\n")).toHaveLength(1);

    const exported = exportFor("quantity_breaks", page.rows);
    expect(planFor(exported).planned[0]!.rule.value).toMatchObject({
      tiers: [
        expect.objectContaining({ minQuantity: 5 }),
        expect.objectContaining({ minQuantity: 20 }),
      ],
    });
  });
});
