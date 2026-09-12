/**
 * Cold-read probes for task 0.1 — the multi-tenancy layer.
 * Adversarial. Each `it` is named for the claim it is trying to break.
 * Run: npx vitest run --config qa/0.1/cold-read/vitest.config.ts
 */
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
import { prismaBase, resetDatabase } from "../../../tests/support/db";

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

/** A full little tenant: shop, group, buyer, order + line, quote + line, form, conversation + message. */
async function seed(shop: string) {
  return shopScope.run(shop, async () => {
    await db.shop.create({ data: { ...tenant(), name: `${shop} store` } });
    const group = await db.customerGroup.create({
      data: { ...tenant(), name: `${shop} group`, handle: `g-${shop}`, tag: `${shop}-tag` },
    });
    const customer = await db.customer.create({
      data: {
        ...tenant(),
        customerId: `gid://shopify/Customer/${shop}`,
        email: `buyer@${shop}`,
        company: `${shop} Trading`,
        groupId: group.id,
      },
    });
    const order = await db.order.create({
      data: {
        ...tenant(),
        orderId: `gid://shopify/Order/${shop}`,
        name: "#1001",
        processedAt: new Date(),
        totalPrice: 10_000,
      },
    });
    const line = await db.orderLine.create({
      data: {
        ...tenant(),
        orderId: order.id,
        lineItemId: `gid://shopify/LineItem/${shop}`,
        title: `${shop} secret product`,
        quantity: 1,
        discounts: [],
      },
    });
    const quote = await db.quote.create({
      data: { ...tenant(), publicId: `pub-${shop}`, number: "Q-1001" },
    });
    const form = await db.registrationForm.create({
      data: {
        ...tenant(),
        name: "Apply",
        slug: "apply",
        publicId: `form-${shop}`,
        fields: {},
        appearance: {},
        emails: {},
        publish: {},
      },
    });
    const conversation = await db.agentConversation.create({
      data: { ...tenant(), company: `${shop} Trading` },
    });
    const message = await db.agentMessage.create({
      data: {
        ...tenant(),
        conversationId: conversation.id,
        role: "BUYER",
        text: `${shop} confidential question`,
      },
    });
    return { group, customer, order, line, quote, form, conversation, message };
  });
}

describe("P0 candidate: cross-tenant read by primary key, across many models", () => {
  it("findUnique by id reads as not found for every model", async () => {
    const alpha = await seed(ALPHA);
    await seed(BETA);

    const stolen = await inBeta(async () => ({
      customer: await db.customer.findUnique({ where: { id: alpha.customer.id } }),
      order: await db.order.findUnique({ where: { id: alpha.order.id } }),
      line: await db.orderLine.findUnique({ where: { id: alpha.line.id } }),
      quote: await db.quote.findUnique({ where: { id: alpha.quote.id } }),
      form: await db.registrationForm.findUnique({ where: { id: alpha.form.id } }),
      conversation: await db.agentConversation.findUnique({
        where: { id: alpha.conversation.id },
      }),
      message: await db.agentMessage.findUnique({ where: { id: alpha.message.id } }),
      group: await db.customerGroup.findUnique({ where: { id: alpha.group.id } }),
    }));

    expect(stolen).toEqual({
      customer: null,
      order: null,
      line: null,
      quote: null,
      form: null,
      conversation: null,
      message: null,
      group: null,
    });
  });

  it("findUnique by a GLOBALLY unique non-id column reads as not found", async () => {
    const alpha = await seed(ALPHA);
    await seed(BETA);

    const byPublicId = await inBeta(() =>
      db.quote.findUnique({ where: { publicId: alpha.quote.publicId } }),
    );
    expect(byPublicId).toBeNull();

    const bySeq = await inBeta(() =>
      db.agentMessage.findUnique({ where: { seq: alpha.message.seq } }),
    );
    expect(bySeq).toBeNull();
  });

  it("update/delete by another shop's id raise not-found, not a write", async () => {
    const alpha = await seed(ALPHA);
    await seed(BETA);

    const notFound = (error: unknown) =>
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";

    await expect(
      inBeta(() =>
        db.customer.update({
          where: { id: alpha.customer.id },
          data: { internalNote: "hijacked" },
        }),
      ),
    ).rejects.toSatisfy(notFound);

    await expect(
      inBeta(() => db.order.delete({ where: { id: alpha.order.id } })),
    ).rejects.toSatisfy(notFound);

    const still = await inAlpha(() =>
      db.order.findUnique({ where: { id: alpha.order.id } }),
    );
    expect(still).not.toBeNull();
  });
});

describe("P0 candidate: relation traversal", () => {
  it("cannot read another shop's order lines through the order relation", async () => {
    const alpha = await seed(ALPHA);
    await seed(BETA);

    const lines = await inBeta(() =>
      db.orderLine.findMany({ where: { order: { shop: ALPHA } } }),
    );
    expect(lines.map((l) => l.title)).not.toContain(`${ALPHA} secret product`);
  });

  it("cannot read another shop's agent messages through the conversation relation", async () => {
    const alpha = await seed(ALPHA);
    await seed(BETA);

    const messages = await inBeta(() =>
      db.agentMessage.findMany({
        where: { conversation: { id: alpha.conversation.id } },
      }),
    );
    expect(messages).toEqual([]);
  });

  it("cannot read another shop's submissions through the form relation", async () => {
    const alpha = await seed(ALPHA);
    await seed(BETA);
    await inAlpha(() =>
      db.formSubmission.create({
        data: {
          ...tenant(),
          formId: alpha.form.id,
          email: "applicant@alpha",
          answers: {},
        },
      }),
    );

    const rows = await inBeta(() =>
      db.formSubmission.findMany({ where: { formId: alpha.form.id } }),
    );
    expect(rows).toEqual([]);
  });

  it("an INCLUDE through a relation cannot pull another shop's rows", async () => {
    const alpha = await seed(ALPHA);
    await seed(BETA);
    // Cross-tenant FK written directly (no relation guard on scalar FKs).
    await inBeta(async () => {
      await db.orderLine.create({
        data: {
          ...tenant(),
          orderId: alpha.order.id, // <- another shop's parent
          lineItemId: "gid://shopify/LineItem/cross",
          title: "planted",
          quantity: 1,
          discounts: [],
        },
      });
    });

    const leaked = await inAlpha(() =>
      db.order.findUnique({ where: { id: alpha.order.id }, include: { lines: true } }),
    );
    expect(leaked?.lines.map((l) => l.shop)).toEqual([ALPHA]);
  });
});

describe("P0 candidate: nested writes", () => {
  it("stamps the active tenant onto a nested create", async () => {
    await inAlpha(() => db.shop.create({ data: { ...tenant() } }));
    const created = await inAlpha(() =>
      db.order.create({
        data: {
          ...tenant(),
          orderId: "gid://shopify/Order/nested",
          name: "#2001",
          processedAt: new Date(),
          lines: {
            create: [
              {
                shop: BETA, // a lie the extension should refuse
                lineItemId: "gid://shopify/LineItem/nested",
                title: "nested",
                quantity: 1,
                discounts: [],
              },
            ],
          },
        },
        include: { lines: true },
      }),
    );
    expect(created.lines.map((l) => l.shop)).toEqual([ALPHA]);
  });
});

describe("P0 candidate: moving a row between tenants with `data`", () => {
  it("refuses an update that reassigns `shop`", async () => {
    const alpha = await seed(ALPHA);
    await seed(BETA);

    await expect(
      inAlpha(() =>
        db.customer.update({ where: { id: alpha.customer.id }, data: { shop: BETA } }),
      ),
    ).rejects.toBeInstanceOf(CrossTenantError);

    const stillAlpha = await inAlpha(() =>
      db.customer.findUnique({ where: { id: alpha.customer.id } }),
    );
    expect(stillAlpha).not.toBeNull();
  });

  it("refuses an updateMany that reassigns `shop`", async () => {
    await seed(ALPHA);
    await seed(BETA);
    await expect(
      inAlpha(() => db.customer.updateMany({ where: {}, data: { shop: BETA } })),
    ).rejects.toBeInstanceOf(CrossTenantError);
  });

  it("refuses an upsert whose UPDATE branch reassigns `shop`", async () => {
    const alpha = await seed(ALPHA);
    await expect(
      inAlpha(() =>
        db.customer.upsert({
          where: { id: alpha.customer.id },
          update: { shop: BETA },
          create: {
            ...tenant(),
            customerId: "gid://shopify/Customer/x",
          },
        }),
      ),
    ).rejects.toBeInstanceOf(CrossTenantError);
  });
});

describe("P0 candidate: raw SQL", () => {
  it("refuses raw SQL with no tenant context", async () => {
    await expect(db.$queryRaw`SELECT 1`).rejects.toBeInstanceOf(MissingShopContextError);
  });

  it("raw SQL inside shop A cannot read shop B's rows", async () => {
    await seed(ALPHA);
    await seed(BETA);
    const rows = await inBeta<Array<{ shop: string; email: string | null }>>(
      () => db.$queryRaw`SELECT "shop", "email" FROM "Customer"`,
    );
    expect(rows.map((r) => r.shop)).toEqual([BETA]);
  });

  it("raw SQL inside shop A cannot delete shop B's rows", async () => {
    await seed(ALPHA);
    await seed(BETA);
    await inBeta(() => db.$executeRaw`DELETE FROM "Customer"`);
    const alphaStill = await inAlpha(() => db.customer.count());
    expect(alphaStill).toBe(1);
  });
});

describe("async boundaries", () => {
  it("does not leak a scope into a detached microtask", async () => {
    let seen: string | undefined = "unset";
    await inAlpha(async () => {
      queueMicrotask(() => {
        seen = shopScope.get();
      });
      await new Promise((r) => setTimeout(r, 5));
    });
    // Inside the scope this is ALPHA — that is correct, ALS propagates.
    expect(seen).toBe(ALPHA);
  });

  it("keeps two shops apart under interleaved Promise.all", async () => {
    await inAlpha(() => db.shop.create({ data: { ...tenant(), name: "A" } }));
    await inBeta(() => db.shop.create({ data: { ...tenant(), name: "B" } }));

    const [a, b] = await Promise.all([
      inAlpha(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return db.shop.findMany();
      }),
      inBeta(async () => {
        await new Promise((r) => setTimeout(r, 1));
        return db.shop.findMany();
      }),
    ]);
    expect(a.map((r) => r.shop)).toEqual([ALPHA]);
    expect(b.map((r) => r.shop)).toEqual([BETA]);
  });

  it("a promise started inside a scope and awaited outside is still scoped", async () => {
    await inAlpha(() => db.shop.create({ data: { ...tenant(), name: "A" } }));
    await inBeta(() => db.shop.create({ data: { ...tenant(), name: "B" } }));

    const escaped = shopScope.run(ALPHA, () => db.shop.findMany());
    const rows = await escaped;
    expect(rows.map((r) => r.shop)).toEqual([ALPHA]);
  });
});

describe("withoutShopScope", () => {
  it("does not let tenant() write a bogus '__unscoped__' shop", async () => {
    const created = await withoutShopScope("probe", () =>
      db.shop.create({ data: { ...tenant(), name: "ghost" } }),
    );
    expect(created.shop).not.toBe("__unscoped__");
  });

  it("bypass does not survive into an inner shopScope.run", async () => {
    await seed(ALPHA);
    await seed(BETA);
    const rows = await withoutShopScope("probe", () => inBeta(() => db.shop.findMany()));
    expect(rows.map((r) => r.shop)).toEqual([BETA]);
  });
});

describe("transactions", () => {
  it("array-form $transaction is scoped", async () => {
    await seed(ALPHA);
    await seed(BETA);
    const [customers, orders] = await inBeta(() =>
      db.$transaction([db.customer.findMany(), db.order.findMany()]),
    );
    expect(customers.map((c) => c.shop)).toEqual([BETA]);
    expect(orders.map((o) => o.shop)).toEqual([BETA]);
  });

  // NOT a defect, recorded so the boundary is written down: the extension
  // trusts whatever `shopScope.run` was called with most recently, including
  // inside another shop's open transaction. The only control is who is allowed
  // to call `shopScope.run` and with what — see finding N7.
  it("an interactive $transaction CAN be re-scoped mid-flight", async () => {
    await seed(ALPHA);
    await seed(BETA);
    const seen = await inBeta(() =>
      db.$transaction(async (tx) =>
        shopScope.run(ALPHA, () => tx.customer.findMany()),
      ),
    );
    expect(seen.map((c) => c.shop)).toEqual([ALPHA]);
  });
});

describe("more raw-SQL surface", () => {
  it("$queryRawUnsafe is also outside the guard", async () => {
    await seed(ALPHA);
    const rows = await db.$queryRawUnsafe<Array<{ shop: string }>>(
      'SELECT "shop" FROM "Customer"',
    );
    expect(rows).toEqual([]); // no scope at all — should have thrown
  });
});

describe("foreign keys are not tenant-checked", () => {
  it("refuses a child row whose parent belongs to another shop", async () => {
    const alpha = await seed(ALPHA);
    await seed(BETA);

    await expect(
      inBeta(() =>
        db.orderLine.create({
          data: {
            ...tenant(),
            orderId: alpha.order.id,
            lineItemId: "gid://shopify/LineItem/fk",
            title: "planted by beta",
            quantity: 1,
            discounts: [],
          },
        }),
      ),
    ).rejects.toBeTruthy();
  });

  it("refuses a buyer pointed at another shop's customer group", async () => {
    const alpha = await seed(ALPHA);
    const beta = await seed(BETA);

    await expect(
      inBeta(() =>
        db.customer.update({
          where: { id: beta.customer.id },
          data: { groupId: alpha.group.id },
        }),
      ),
    ).rejects.toBeTruthy();
  });

  it("does not hand a shop another shop's group through include", async () => {
    const alpha = await seed(ALPHA);
    const beta = await seed(BETA);
    await inBeta(() =>
      db.customer.update({
        where: { id: beta.customer.id },
        data: { groupId: alpha.group.id },
      }),
    );

    const leaked = await inBeta(() =>
      db.customer.findUnique({ where: { id: beta.customer.id }, include: { group: true } }),
    );
    expect(leaked?.group?.shop ?? BETA).toBe(BETA);
  });
});
