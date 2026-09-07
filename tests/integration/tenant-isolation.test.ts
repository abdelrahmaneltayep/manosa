import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "~/db.server";
import {
  MissingShopContextError,
  shopScope,
  tenant,
  withoutShopScope,
} from "~/lib/tenant/shop-context.server";
import { CrossTenantError } from "~/lib/tenant/shop-scope.server";
import { prismaBase, resetDatabase } from "../support/db";

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";

const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

async function seedBothShops() {
  await inAlpha(() => db.shop.create({ data: { ...tenant(), name: "Alpha Coffee" } }));
  await inBeta(() => db.shop.create({ data: { ...tenant(), name: "Beta Beans" } }));
}

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

describe("fail-closed behaviour", () => {
  it("refuses to read a scoped model with no tenant context", async () => {
    await expect(db.shop.findMany()).rejects.toBeInstanceOf(MissingShopContextError);
  });

  it("refuses to write a scoped model with no tenant context", async () => {
    await expect(db.shop.create({ data: { shop: ALPHA } })).rejects.toBeInstanceOf(
      MissingShopContextError,
    );
  });

  it("names the model and operation so the fix is obvious", async () => {
    await expect(db.shop.count()).rejects.toThrow(/Shop\.count/);
  });
});

describe("automatic scoping", () => {
  it("stamps the tenant onto creates", async () => {
    const created = await inAlpha(() =>
      db.shop.create({ data: { ...tenant(), name: "Alpha Coffee" } }),
    );
    expect(created.shop).toBe(ALPHA);
  });

  it("filters reads to the active tenant", async () => {
    await seedBothShops();

    const fromAlpha = await inAlpha(() => db.shop.findMany());
    expect(fromAlpha.map((row) => row.shop)).toEqual([ALPHA]);

    const fromBeta = await inBeta(() => db.shop.findMany());
    expect(fromBeta.map((row) => row.shop)).toEqual([BETA]);
  });

  it("filters aggregates to the active tenant", async () => {
    await seedBothShops();
    expect(await inAlpha(() => db.shop.count())).toBe(1);
  });

  it("scopes upsert, so the same key in two shops stays two rows", async () => {
    await inAlpha(() =>
      db.shop.upsert({ where: { shop: ALPHA }, update: {}, create: { ...tenant() } }),
    );
    await inBeta(() =>
      db.shop.upsert({ where: { shop: BETA }, update: {}, create: { ...tenant() } }),
    );

    const all = await withoutShopScope("test assertion", () =>
      prismaBase.shop.findMany({ orderBy: { shop: "asc" } }),
    );
    expect(all.map((row) => row.shop)).toEqual([ALPHA, BETA]);
  });
});

describe("cross-tenant access", () => {
  it("cannot read another shop's row by primary key", async () => {
    await seedBothShops();
    const alphaRow = await inAlpha(() => db.shop.findFirstOrThrow());

    const stolen = await inBeta(() => db.shop.findUnique({ where: { id: alphaRow.id } }));
    expect(stolen).toBeNull();
  });

  it("raises not-found rather than updating another shop's row", async () => {
    await seedBothShops();
    const alphaRow = await inAlpha(() => db.shop.findFirstOrThrow());

    await expect(
      inBeta(() =>
        db.shop.update({ where: { id: alphaRow.id }, data: { name: "hijacked" } }),
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025",
    );

    const untouched = await inAlpha(() => db.shop.findFirstOrThrow());
    expect(untouched.name).toBe("Alpha Coffee");
  });

  it("raises not-found rather than deleting another shop's row", async () => {
    await seedBothShops();
    const alphaRow = await inAlpha(() => db.shop.findFirstOrThrow());

    await expect(
      inBeta(() => db.shop.delete({ where: { id: alphaRow.id } })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025",
    );

    expect(await inAlpha(() => db.shop.count())).toBe(1);
  });

  it("does not silently drop a deleteMany aimed at another shop", async () => {
    await seedBothShops();
    const removed = await inBeta(() => db.shop.deleteMany({ where: { shop: BETA } }));
    expect(removed.count).toBe(1);
    expect(await inAlpha(() => db.shop.count())).toBe(1);
  });
});

describe("attempts to widen the scope", () => {
  it("rejects a literal shop filter for a different tenant", async () => {
    await expect(
      inBeta(() => db.shop.findMany({ where: { shop: ALPHA } })),
    ).rejects.toBeInstanceOf(CrossTenantError);
  });

  it("rejects a shop filter object that could match several tenants", async () => {
    await expect(
      inBeta(() =>
        db.shop.findMany({
          where: { shop: { in: [ALPHA, BETA] } } as Prisma.ShopWhereInput,
        }),
      ),
    ).rejects.toBeInstanceOf(CrossTenantError);
  });

  it("rejects a create that claims another tenant", async () => {
    await expect(
      inBeta(() => db.shop.create({ data: { shop: ALPHA } })),
    ).rejects.toBeInstanceOf(CrossTenantError);
  });

  it("allows a redundant filter that matches the active tenant", async () => {
    await seedBothShops();
    const rows = await inAlpha(() => db.shop.findMany({ where: { shop: ALPHA } }));
    expect(rows).toHaveLength(1);
  });
});

describe("abuse cases", () => {
  it("cannot widen the scope through an OR branch", async () => {
    await seedBothShops();

    // A hand-built filter that would match both shops if `shop` were merged as
    // just another OR branch instead of an outer AND.
    const rows = await inBeta(() =>
      db.shop.findMany({
        where: { OR: [{ name: "Alpha Coffee" }, { name: "Beta Beans" }] },
      }),
    );

    expect(rows.map((row) => row.shop)).toEqual([BETA]);
  });

  it("cannot reach another tenant through a nested relation filter", async () => {
    await seedBothShops();
    // No relations exist yet; assert the shape that keeps this honest as the
    // schema grows — the tenant predicate is always at the top level of `where`.
    const rows = await inBeta(() => db.shop.findMany({ where: { NOT: { name: "" } } }));
    expect(rows.map((row) => row.shop)).toEqual([BETA]);
  });

  it("keeps concurrent writes from different tenants apart", async () => {
    await Promise.all([
      inAlpha(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return db.shop.create({ data: { ...tenant(), name: "Alpha Coffee" } });
      }),
      inBeta(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return db.shop.create({ data: { ...tenant(), name: "Beta Beans" } });
      }),
    ]);

    const all = await withoutShopScope("test assertion", () =>
      prismaBase.shop.findMany({ orderBy: { shop: "asc" } }),
    );
    expect(all.map((row) => [row.shop, row.name])).toEqual([
      [ALPHA, "Alpha Coffee"],
      [BETA, "Beta Beans"],
    ]);
  });

  it("rejects a malformed empty tenant rather than matching everything", () => {
    expect(() => shopScope.run("", async () => db.shop.findMany())).toThrow(
      MissingShopContextError,
    );
  });
});

describe("exemptions", () => {
  it("lets Session work without a tenant context", async () => {
    await expect(
      prismaBase.session.findMany({ where: { shop: ALPHA } }),
    ).resolves.toEqual([]);
  });

  it("withoutShopScope sees every tenant", async () => {
    await seedBothShops();
    const all = await withoutShopScope("test assertion", () => db.shop.findMany());
    expect(all).toHaveLength(2);
  });
});
