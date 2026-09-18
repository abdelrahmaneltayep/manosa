import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "~/db.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { __testing } from "~/lib/tenant/shop-scope.server";
import { prismaBase, resetDatabase } from "../support/db";

/**
 * Crossing a tenant boundary through a relation.
 *
 * `tenant-isolation.test.ts` proved six things, all against `Shop` — the one
 * model in the schema with no relations, no nested writes and no foreign keys.
 * Its own comment said so: *"No relations exist yet; assert the shape that
 * keeps this honest as the schema grows."* Thirty-one models later nobody came
 * back, and that single deferral is why a nested create could write another
 * shop's row and a relation filter could read one for eighteen tasks without
 * anybody seeing it.
 *
 * So this is a **map, not a sample**: every scoped model that owns a relation
 * is probed, and the last test in this file fails the day somebody adds one
 * that is not. Reaching another shop's row by id must read as *not found* —
 * never as a leak, and never as an error that admits the row is there.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";

const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

interface Seeded {
  parentId: string;
  childId: string;
}

/**
 * One parent/child pair, and the seven ways out of a tenant it offers.
 *
 * Written as closures rather than a model name looked up on the client: a
 * dynamic index would need a cast to call, and a cast is exactly the thing
 * that would let this file compile while probing nothing.
 */
interface RelationProbe {
  /** `Parent.relation → Child`, which is also what a failure prints. */
  name: string;
  parent: string;
  child: string;
  /**
   * A parent and, unless `withChild` is false, one child — inside whichever
   * tenant is running. A bare parent is what the nested-write test needs:
   * some of these relations allow only one child per parent.
   */
  seed: (withChild?: boolean) => Promise<Seeded>;
  /** The parent by id, with its children pulled in. */
  readParentWithChildren: (parentId: string) => Promise<unknown>;
  /** The child by its own id. */
  readChild: (childId: string) => Promise<unknown>;
  /** Children reached by filtering on the parent relation. */
  readChildrenOfParent: (parentId: string) => Promise<unknown[]>;
  writeChild: (childId: string) => Promise<unknown>;
  deleteChild: (childId: string) => Promise<unknown>;
  /**
   * Attach a new child to that parent through the parent's nested write, in
   * the name of `shop` — which is not always the tenant running the query.
   */
  nestedCreate: (parentId: string, shop: string) => Promise<unknown>;
  /** The `shop` of every row of the child model, tenant or not. */
  childShops: () => Promise<string[]>;
}

const JSON_EMPTY = {} as Prisma.InputJsonValue;
const PAST = new Date("2026-01-01T00:00:00Z");

const PROBES: RelationProbe[] = [
  {
    name: "CustomerGroup.members → Customer",
    parent: "CustomerGroup",
    child: "Customer",
    seed: async (withChild = true) => {
      const group = await db.customerGroup.create({
        data: { ...tenant(), name: "Trade", handle: "trade", tag: "trade" },
      });
      if (!withChild) return { parentId: group.id, childId: "" };

      const member = await db.customer.create({
        data: { ...tenant(), customerId: "gid://shopify/Customer/1", groupId: group.id },
      });
      return { parentId: group.id, childId: member.id };
    },
    readParentWithChildren: (id) =>
      db.customerGroup.findUnique({ where: { id }, include: { members: true } }),
    readChild: (id) => db.customer.findUnique({ where: { id } }),
    readChildrenOfParent: (id) => db.customer.findMany({ where: { group: { id } } }),
    writeChild: (id) => db.customer.update({ where: { id }, data: { company: "taken" } }),
    deleteChild: (id) => db.customer.delete({ where: { id } }),
    nestedCreate: (id, shop) =>
      db.customerGroup.update({
        where: { id },
        data: {
          members: {
            create: { shop, customerId: "gid://shopify/Customer/999" },
          },
        },
      }),
    childShops: async () =>
      (await prismaBase.customer.findMany({ select: { shop: true } })).map(
        (row) => row.shop,
      ),
  },
  {
    name: "CustomerGroup.limits → OrderLimit",
    parent: "CustomerGroup",
    child: "OrderLimit",
    seed: async (withChild = true) => {
      const group = await db.customerGroup.create({
        data: { ...tenant(), name: "Trade", handle: "trade", tag: "trade" },
      });
      if (!withChild) return { parentId: group.id, childId: "" };

      const limit = await db.orderLimit.create({
        data: { ...tenant(), groupId: group.id },
      });
      return { parentId: group.id, childId: limit.id };
    },
    readParentWithChildren: (id) =>
      db.customerGroup.findUnique({ where: { id }, include: { limits: true } }),
    readChild: (id) => db.orderLimit.findUnique({ where: { id } }),
    readChildrenOfParent: (id) => db.orderLimit.findMany({ where: { group: { id } } }),
    writeChild: (id) =>
      db.orderLimit.update({ where: { id }, data: { minQuantity: 99 } }),
    deleteChild: (id) => db.orderLimit.delete({ where: { id } }),
    nestedCreate: (id, shop) =>
      db.customerGroup.update({
        where: { id },
        data: { limits: { create: { shop, minQuantity: 99 } } },
      }),
    childShops: async () =>
      (await prismaBase.orderLimit.findMany({ select: { shop: true } })).map(
        (row) => row.shop,
      ),
  },
  {
    name: "RegistrationForm.submissions → FormSubmission",
    parent: "RegistrationForm",
    child: "FormSubmission",
    seed: async (withChild = true) => {
      const form = await db.registrationForm.create({
        data: {
          ...tenant(),
          name: "Trade application",
          slug: "trade",
          fields: JSON_EMPTY,
          appearance: JSON_EMPTY,
          emails: JSON_EMPTY,
          publish: JSON_EMPTY,
        },
      });
      if (!withChild) return { parentId: form.id, childId: "" };

      const submission = await db.formSubmission.create({
        data: {
          ...tenant(),
          formId: form.id,
          email: "buyer@acme.test",
          answers: JSON_EMPTY,
        },
      });
      return { parentId: form.id, childId: submission.id };
    },
    readParentWithChildren: (id) =>
      db.registrationForm.findUnique({ where: { id }, include: { submissions: true } }),
    readChild: (id) => db.formSubmission.findUnique({ where: { id } }),
    readChildrenOfParent: (id) => db.formSubmission.findMany({ where: { form: { id } } }),
    writeChild: (id) =>
      db.formSubmission.update({ where: { id }, data: { email: "taken@evil.test" } }),
    deleteChild: (id) => db.formSubmission.delete({ where: { id } }),
    nestedCreate: (id, shop) =>
      db.registrationForm.update({
        where: { id },
        data: {
          submissions: {
            create: { shop, email: "planted@evil.test", answers: JSON_EMPTY },
          },
        },
      }),
    childShops: async () =>
      (await prismaBase.formSubmission.findMany({ select: { shop: true } })).map(
        (row) => row.shop,
      ),
  },
  {
    name: "RegistrationForm.events → FormEvent",
    parent: "RegistrationForm",
    child: "FormEvent",
    seed: async (withChild = true) => {
      const form = await db.registrationForm.create({
        data: {
          ...tenant(),
          name: "Trade application",
          slug: "trade",
          fields: JSON_EMPTY,
          appearance: JSON_EMPTY,
          emails: JSON_EMPTY,
          publish: JSON_EMPTY,
        },
      });
      if (!withChild) return { parentId: form.id, childId: "" };

      const event = await db.formEvent.create({
        data: { ...tenant(), formId: form.id, kind: "VIEW" },
      });
      return { parentId: form.id, childId: event.id };
    },
    readParentWithChildren: (id) =>
      db.registrationForm.findUnique({ where: { id }, include: { events: true } }),
    readChild: (id) => db.formEvent.findUnique({ where: { id } }),
    readChildrenOfParent: (id) => db.formEvent.findMany({ where: { form: { id } } }),
    writeChild: (id) => db.formEvent.update({ where: { id }, data: { kind: "SUBMIT" } }),
    deleteChild: (id) => db.formEvent.delete({ where: { id } }),
    nestedCreate: (id, shop) =>
      db.registrationForm.update({
        where: { id },
        data: { events: { create: { shop, kind: "SUBMIT" } } },
      }),
    childShops: async () =>
      (await prismaBase.formEvent.findMany({ select: { shop: true } })).map(
        (row) => row.shop,
      ),
  },
  {
    name: "FormSubmission.uploads → FormUpload",
    parent: "FormSubmission",
    child: "FormUpload",
    seed: async (withChild = true) => {
      const form = await db.registrationForm.create({
        data: {
          ...tenant(),
          name: "Trade application",
          slug: "trade",
          fields: JSON_EMPTY,
          appearance: JSON_EMPTY,
          emails: JSON_EMPTY,
          publish: JSON_EMPTY,
        },
      });
      const submission = await db.formSubmission.create({
        data: {
          ...tenant(),
          formId: form.id,
          email: "buyer@acme.test",
          answers: JSON_EMPTY,
        },
      });
      if (!withChild) return { parentId: submission.id, childId: "" };

      const upload = await db.formUpload.create({
        data: {
          ...tenant(),
          submissionId: submission.id,
          fieldKey: "licence",
          fileName: "licence.pdf",
          contentType: "application/pdf",
          byteSize: 3,
          content: Buffer.from("pdf"),
        },
      });
      return { parentId: submission.id, childId: upload.id };
    },
    readParentWithChildren: (id) =>
      db.formSubmission.findUnique({ where: { id }, include: { uploads: true } }),
    readChild: (id) => db.formUpload.findUnique({ where: { id } }),
    readChildrenOfParent: (id) =>
      db.formUpload.findMany({ where: { submission: { id } } }),
    writeChild: (id) =>
      db.formUpload.update({ where: { id }, data: { fileName: "taken.pdf" } }),
    deleteChild: (id) => db.formUpload.delete({ where: { id } }),
    nestedCreate: (id, shop) =>
      db.formSubmission.update({
        where: { id },
        data: {
          uploads: {
            create: {
              shop,
              fieldKey: "licence",
              fileName: "planted.pdf",
              contentType: "application/pdf",
              byteSize: 3,
              content: Buffer.from("pdf"),
            },
          },
        },
      }),
    childShops: async () =>
      (await prismaBase.formUpload.findMany({ select: { shop: true } })).map(
        (row) => row.shop,
      ),
  },
  {
    name: "Order.lines → OrderLine",
    parent: "Order",
    child: "OrderLine",
    seed: async (withChild = true) => {
      const order = await db.order.create({
        data: {
          ...tenant(),
          orderId: "gid://shopify/Order/1",
          name: "#1001",
          processedAt: PAST,
        },
      });
      if (!withChild) return { parentId: order.id, childId: "" };

      const orderLine = await db.orderLine.create({
        data: {
          ...tenant(),
          orderId: order.id,
          lineItemId: "gid://shopify/LineItem/1",
          currencyCode: "USD",
          title: "Beans",
          discounts: JSON_EMPTY,
        },
      });
      return { parentId: order.id, childId: orderLine.id };
    },
    readParentWithChildren: (id) =>
      db.order.findUnique({ where: { id }, include: { lines: true } }),
    readChild: (id) => db.orderLine.findUnique({ where: { id } }),
    readChildrenOfParent: (id) => db.orderLine.findMany({ where: { order: { id } } }),
    writeChild: (id) => db.orderLine.update({ where: { id }, data: { title: "taken" } }),
    deleteChild: (id) => db.orderLine.delete({ where: { id } }),
    nestedCreate: (id, shop) =>
      db.order.update({
        where: { id },
        data: {
          lines: {
            create: {
              shop,
              lineItemId: "gid://shopify/LineItem/999",
              currencyCode: "USD",
              title: "Planted",
              discounts: JSON_EMPTY,
            },
          },
        },
      }),
    childShops: async () =>
      (await prismaBase.orderLine.findMany({ select: { shop: true } })).map(
        (row) => row.shop,
      ),
  },
  {
    name: "Order.payments → Payment",
    parent: "Order",
    child: "Payment",
    seed: async (withChild = true) => {
      const order = await db.order.create({
        data: {
          ...tenant(),
          orderId: "gid://shopify/Order/1",
          name: "#1001",
          processedAt: PAST,
        },
      });
      if (!withChild) return { parentId: order.id, childId: "" };

      const payment = await db.payment.create({
        data: { ...tenant(), orderId: order.id, amount: 1000, receivedAt: PAST },
      });
      return { parentId: order.id, childId: payment.id };
    },
    readParentWithChildren: (id) =>
      db.order.findUnique({ where: { id }, include: { payments: true } }),
    readChild: (id) => db.payment.findUnique({ where: { id } }),
    readChildrenOfParent: (id) => db.payment.findMany({ where: { order: { id } } }),
    writeChild: (id) => db.payment.update({ where: { id }, data: { amount: 1 } }),
    deleteChild: (id) => db.payment.delete({ where: { id } }),
    nestedCreate: (id, shop) =>
      db.order.update({
        where: { id },
        data: {
          payments: { create: { shop, amount: 1, receivedAt: PAST } },
        },
      }),
    childShops: async () =>
      (await prismaBase.payment.findMany({ select: { shop: true } })).map(
        (row) => row.shop,
      ),
  },
  {
    name: "Quote.lines → QuoteLine",
    parent: "Quote",
    child: "QuoteLine",
    seed: async (withChild = true) => {
      const quote = await db.quote.create({
        data: { ...tenant(), publicId: "q-alpha", number: "Q-1" },
      });
      if (!withChild) return { parentId: quote.id, childId: "" };

      const quoteLine = await db.quoteLine.create({
        data: {
          ...tenant(),
          quoteId: quote.id,
          variantId: "gid://shopify/ProductVariant/1",
          title: "Beans",
          unitPrice: 650,
          listPrice: 1000,
        },
      });
      return { parentId: quote.id, childId: quoteLine.id };
    },
    readParentWithChildren: (id) =>
      db.quote.findUnique({ where: { id }, include: { lines: true } }),
    readChild: (id) => db.quoteLine.findUnique({ where: { id } }),
    readChildrenOfParent: (id) => db.quoteLine.findMany({ where: { quote: { id } } }),
    writeChild: (id) => db.quoteLine.update({ where: { id }, data: { unitPrice: 1 } }),
    deleteChild: (id) => db.quoteLine.delete({ where: { id } }),
    nestedCreate: (id, shop) =>
      db.quote.update({
        where: { id },
        data: {
          lines: {
            create: {
              shop,
              variantId: "gid://shopify/ProductVariant/999",
              title: "Planted",
              unitPrice: 1,
              listPrice: 1,
            },
          },
        },
      }),
    childShops: async () =>
      (await prismaBase.quoteLine.findMany({ select: { shop: true } })).map(
        (row) => row.shop,
      ),
  },
  {
    name: "AgentConversation.messages → AgentMessage",
    parent: "AgentConversation",
    child: "AgentMessage",
    seed: async (withChild = true) => {
      const conversation = await db.agentConversation.create({ data: { ...tenant() } });
      if (!withChild) return { parentId: conversation.id, childId: "" };

      const message = await db.agentMessage.create({
        data: {
          ...tenant(),
          conversationId: conversation.id,
          role: "BUYER",
          text: "What is my price?",
        },
      });
      return { parentId: conversation.id, childId: message.id };
    },
    readParentWithChildren: (id) =>
      db.agentConversation.findUnique({ where: { id }, include: { messages: true } }),
    readChild: (id) => db.agentMessage.findUnique({ where: { id } }),
    readChildrenOfParent: (id) =>
      db.agentMessage.findMany({ where: { conversation: { id } } }),
    writeChild: (id) =>
      db.agentMessage.update({ where: { id }, data: { text: "taken" } }),
    deleteChild: (id) => db.agentMessage.delete({ where: { id } }),
    nestedCreate: (id, shop) =>
      db.agentConversation.update({
        where: { id },
        data: {
          messages: { create: { shop, role: "BUYER", text: "planted" } },
        },
      }),
    childShops: async () =>
      (await prismaBase.agentMessage.findMany({ select: { shop: true } })).map(
        (row) => row.shop,
      ),
  },
];

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

describe.each(PROBES.map((probe) => [probe.name, probe] as const))(
  "%s",
  (_name, probe) => {
    it("does not hand Beta Alpha's parent, or the children under it", async () => {
      const seeded = await inAlpha(probe.seed);

      expect(
        await inBeta(() => probe.readParentWithChildren(seeded.parentId)),
      ).toBeNull();
      expect(await inBeta(() => probe.readChild(seeded.childId))).toBeNull();
    });

    it("does not let a relation filter walk into Alpha's rows", async () => {
      const seeded = await inAlpha(probe.seed);

      // The predicate the extension injects has to be an outer AND. Merged as
      // another branch of the caller's filter, this is the query that reads
      // another shop's children by naming their parent.
      expect(await inBeta(() => probe.readChildrenOfParent(seeded.parentId))).toEqual([]);
    });

    it("reads a write to Alpha's child as not found, not as a refusal", async () => {
      const seeded = await inAlpha(probe.seed);

      // `P2025` is Prisma's "no record matched". A leak would be a success; an
      // authorisation error would be an admission that the row is there.
      for (const attempt of [probe.writeChild, probe.deleteChild]) {
        await expect(inBeta(() => attempt(seeded.childId))).rejects.toMatchObject({
          code: "P2025",
        });
      }
    });

    it("cannot plant a child under Alpha's parent through a nested write", async () => {
      const seeded = await inAlpha(probe.seed);
      const before = await probe.childShops();

      await expect(
        inBeta(() => probe.nestedCreate(seeded.parentId, BETA)),
      ).rejects.toThrow();

      expect(await probe.childShops()).toEqual(before);
    });

    it("cannot write a child in another tenant's name from inside its own", async () => {
      // The extension checks `shop` at the top level of an update's `data`; it
      // does not walk into a nested create, so this one is held by the schema —
      // every one of these relations has a composite `(shop, parentId)` foreign
      // key, which makes a cross-tenant parent a thing the database will not
      // store. Asserted per relation rather than trusted, because the guard is
      // a column on a table and the next table has not been written yet.
      const seeded = await inAlpha(probe.seed);
      const before = await probe.childShops();

      await expect(
        inAlpha(() => probe.nestedCreate(seeded.parentId, BETA)),
      ).rejects.toThrow();

      expect(await probe.childShops()).toEqual(before);
    });

    it("writes a nested child for the tenant that owns the parent", async () => {
      // A bare parent: one of these relations allows a single child, and a
      // guard that only ever refuses is an outage rather than isolation.
      const seeded = await inAlpha(() => probe.seed(false));
      await inAlpha(() => probe.nestedCreate(seeded.parentId, ALPHA));

      expect(await probe.childShops()).toEqual([ALPHA]);
    });

    it("still works for the tenant that owns it", async () => {
      // The other half of every test above: a guard that refuses everybody is
      // not isolation, it is an outage.
      const seeded = await inAlpha(probe.seed);

      expect(
        await inAlpha(() => probe.readParentWithChildren(seeded.parentId)),
      ).not.toBeNull();
      expect(await inAlpha(() => probe.readChild(seeded.childId))).not.toBeNull();
      expect(
        await inAlpha(() => probe.readChildrenOfParent(seeded.parentId)),
      ).toHaveLength(1);
    });
  },
);

describe("the probe list is a map, not a sample", () => {
  const owningModels = () =>
    Prisma.dmmf.datamodel.models
      .filter((model) => __testing.scopedModelNames().has(model.name))
      .filter((model) => model.fields.some((f) => f.kind === "object" && f.isList))
      .map((model) => model.name);

  it("probes every scoped model that owns a relation", () => {
    const probed = new Set(PROBES.map((probe) => probe.parent));
    expect(owningModels().filter((name) => !probed.has(name))).toEqual([]);
  });

  it("probes every relation those models own", () => {
    const probed = new Set(PROBES.map((probe) => `${probe.parent}.${probe.child}`));
    const missing: string[] = [];

    for (const model of Prisma.dmmf.datamodel.models) {
      if (!__testing.scopedModelNames().has(model.name)) continue;
      for (const field of model.fields) {
        if (field.kind !== "object" || !field.isList) continue;
        if (!__testing.scopedModelNames().has(field.type)) continue;
        if (!probed.has(`${model.name}.${field.type}`)) {
          missing.push(`${model.name}.${field.name} → ${field.type}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
