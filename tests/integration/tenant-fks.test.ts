import { afterAll, describe, expect, it } from "vitest";

import { prismaBase } from "../support/db";

/**
 * Every foreign key is composite on `shop`, in the database itself.
 *
 * The tenant guard rewrites a `where` and stamps a `create`, and neither can
 * stop a foreign key pointing across the line: from shop B you could create an
 * `OrderLine` whose `orderId` belonged to shop A, and once such a row existed a
 * relation read handed it over — an `include` resolves inside one SQL statement
 * and is never a model operation the guard can filter. Postgres is the only
 * layer that can refuse it, so it does.
 *
 * **The Prisma relations stay single-column on purpose.** Putting `shop` into a
 * Prisma `@relation` changes its generated input types: a create that mixes
 * scalar fields with a nested write stops compiling, which is most of the
 * writes in this app. Prisma builds queries; Postgres owns referential
 * integrity. The cost of that split is that `prisma migrate dev` would happily
 * regenerate a single-column constraint and nothing would say so — which is
 * what this test is for. It reads the live catalogue, not the schema file.
 */

interface Constraint {
  table: string;
  constraint: string;
  columns: string[];
}

/** Every FK in the database, with the columns it is built on, in order. */
async function foreignKeys(): Promise<Constraint[]> {
  return prismaBase.$queryRawUnsafe<Constraint[]>(`
    SELECT
      c.conrelid::regclass::text AS table,
      c.conname                  AS constraint,
      array_agg(a.attname ORDER BY k.ord) AS columns
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.contype = 'f'
    GROUP BY c.conrelid, c.conname
    ORDER BY 1, 2
  `);
}

afterAll(async () => {
  await prismaBase.$disconnect();
});

describe("every foreign key in this database", () => {
  it("is there at all — this test cannot pass by finding nothing", async () => {
    const keys = await foreignKeys();
    expect(keys.length).toBeGreaterThanOrEqual(9);
  });

  it("carries shop as its first column, so a parent in another shop is impossible", async () => {
    const keys = await foreignKeys();

    const single = keys
      .filter((key) => !key.columns.includes("shop"))
      .map((key) => `${key.table}.${key.constraint} (${key.columns.join(", ")})`);

    // A constraint that lost its `shop` column is a tenant boundary that moved
    // back into code review.
    expect(single).toEqual([]);
  });

  it("keeps the buyer's group deletable without nulling their shop", async () => {
    // `Customer.groupId` is the one `SET NULL` relation. A plain composite
    // SET NULL would try to null `shop`, which is NOT NULL — so it names the
    // column, which Postgres 15+ allows. Without this a merchant could not
    // delete a group at all, and deleting one is how members fall back to
    // tag-only pricing, a real state the buyers list shows with a banner.
    const [definition] = await prismaBase.$queryRawUnsafe<{ def: string }[]>(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = 'Customer_shop_groupId_fkey'
    `);

    expect(definition?.def).toContain('FOREIGN KEY (shop, "groupId")');
    expect(definition?.def).toContain('ON DELETE SET NULL ("groupId")');
  });
});
