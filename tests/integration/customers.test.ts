import { parseMoney } from "@mannon/pricing-engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { FeatureLockedError } from "~/lib/billing/gate.server";
import {
  AT_RISK_DAYS,
  changeGroup,
  existingTags,
  getCustomer,
  listCustomers,
  setInternalNote,
  setTags,
  setTaxExempt,
  VatRequiredError,
} from "~/lib/customers/customers.server";
import {
  createGroup,
  createStarterGroups,
  deleteGroup,
  DuplicateGroupHandleError,
  GROUP_TEMPLATES,
  GroupHasMembersError,
  getGroup,
  listGroups,
  toHandle,
} from "~/lib/customers/groups.server";
import {
  factsFromNode,
  factsFromWebhook,
  markCustomerDeleted,
  upsertCustomer,
} from "~/lib/customers/sync.server";
import {
  createTagRule,
  previewTagRules,
  runTagSweep,
  TagRuleValidationError,
} from "~/lib/customers/tag-rules.server";
import { backfillCustomers } from "~/lib/jobs/handlers/backfill-customers.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { handleCustomersDelete } from "~/lib/webhooks/handlers/customers-delete.server";
import { handleCustomersUpsert } from "~/lib/webhooks/handlers/customers-upsert.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../support/db";

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const actor = { type: "STAFF" as const, id: "staff-1" };
const NOW = new Date("2026-06-01T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

interface AdminCall {
  query: string;
  variables: Record<string, unknown>;
}

function fakeAdmin(
  pages: { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null }[] = [],
) {
  const calls: AdminCall[] = [];
  let pageIndex = 0;

  const admin: AdminGraphql & { calls: AdminCall[] } = {
    calls,
    graphql: vi.fn(
      async (query: string, options?: { variables?: Record<string, unknown> }) => {
        calls.push({ query, variables: options?.variables ?? {} });

        if (query.includes("MannonCustomersPage")) {
          const page = pages[pageIndex++] ?? {
            nodes: [],
            hasNextPage: false,
            endCursor: null,
          };
          return {
            json: async () => ({
              data: {
                customers: {
                  nodes: page.nodes,
                  pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
                },
              },
            }),
          };
        }

        const data = query.includes("MannonCustomerTagsAdd")
          ? { tagsAdd: { userErrors: [] } }
          : query.includes("MannonCustomerTagsRemove")
            ? { tagsRemove: { userErrors: [] } }
            : query.includes("MannonCustomerTaxExempt")
              ? {
                  customerUpdate: {
                    customer: { id: "x", taxExempt: true },
                    userErrors: [],
                  },
                }
              : { metafieldsSet: { metafields: [{ id: "gid://mf/1" }], userErrors: [] } };

        return { json: async () => ({ data }) };
      },
    ),
  };

  return admin;
}

const queried = (admin: { calls: AdminCall[] }, name: string) =>
  admin.calls.filter((call) => call.query.includes(name));

async function installShop(shop: string, planKey = "pro") {
  await shopScope.run(shop, () =>
    db.shop.create({
      data: {
        ...tenant(),
        planKey,
        billingStatus: "ACTIVE",
        currencyCode: "USD",
        customersBackfilledAt: NOW,
      },
    }),
  );
}

const node = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Customer/1",
  email: "buyer@acme.test",
  firstName: "Sam",
  lastName: "Reed",
  phone: null,
  state: "ENABLED",
  taxExempt: false,
  tags: ["wholesale"],
  numberOfOrders: "4",
  amountSpent: { amount: "1200.50", currencyCode: "USD" },
  lastOrder: { createdAt: daysAgo(10).toISOString() },
  defaultAddress: { company: "Acme Ltd", countryCodeV2: "SA", provinceCode: null },
  ...overrides,
});

const seedCustomer = (overrides: Record<string, unknown> = {}) =>
  db.customer.create({
    data: {
      ...tenant(),
      customerId: "gid://shopify/Customer/1",
      email: "buyer@acme.test",
      company: "Acme Ltd",
      tags: ["wholesale"],
      countryCode: "SA",
      lifetimeSpend: 120050,
      currencyCode: "USD",
      orderCount: 4,
      lastOrderAt: daysAgo(10),
      ...overrides,
    },
  });

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

/* -------------------------------------------------------------------------- */

describe("reading Shopify's customer", () => {
  it("narrows a GraphQL node to money in minor units", () => {
    const facts = factsFromNode(node() as never);
    expect(facts.lifetimeSpend).toEqual(parseMoney("1200.50", "USD"));
    expect(facts.orderCount).toBe(4);
    expect(facts.company).toBe("Acme Ltd");
    expect(facts.countryCode).toBe("SA");
    expect(facts.state).toBe("enabled");
  });

  it("narrows a webhook payload to the same shape", () => {
    const facts = factsFromWebhook({
      id: 7,
      email: " buyer@acme.test ",
      first_name: "Sam",
      tags: " wholesale, gold ,wholesale ",
      orders_count: 4,
      total_spent: "1200.50",
      currency: "USD",
      tax_exempt: true,
      default_address: { company: "Acme Ltd", country_code: "sa" },
    });

    expect(facts?.customerId).toBe("gid://shopify/Customer/7");
    expect(facts?.tags).toEqual(["gold", "wholesale"]);
    expect(facts?.email).toBe("buyer@acme.test");
    expect(facts?.countryCode).toBe("SA");
    expect(facts?.taxExempt).toBe(true);
    expect(facts?.lifetimeSpend).toEqual(parseMoney("1200.50", "USD"));
  });

  it("does not lose a customer over a malformed total", () => {
    // A row we refuse to store is a buyer who silently pays retail.
    const facts = factsFromWebhook({ id: 7, total_spent: "not a number" });
    expect(facts?.lifetimeSpend.amount).toBe(0);
  });

  it("returns null when the payload has no id at all", () => {
    expect(factsFromWebhook({ email: "nobody@acme.test" })).toBeNull();
  });
});

describe("mirroring customers", () => {
  it("is idempotent: the same delivery twice makes one row", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await upsertCustomer(factsFromNode(node() as never));
      await upsertCustomer(factsFromNode(node() as never));
      expect(await db.customer.count()).toBe(1);
    });
  });

  it("survives a webhook and the backfill writing the same buyer at once", async () => {
    // Not hypothetical: the backfill pages through the whole store while
    // webhooks keep arriving, and both write the same row. A unique-constraint
    // crash here would fail the job and retry the whole page.
    await installShop(ALPHA);
    await inAlpha(async () => {
      await Promise.all([
        upsertCustomer(factsFromNode(node() as never)),
        upsertCustomer(
          factsFromWebhook({ id: 1, total_spent: "5.00", currency: "USD" })!,
        ),
        upsertCustomer(factsFromNode(node() as never)),
      ]);

      expect(await db.customer.count()).toBe(1);
    });
  });

  it("keeps a last-order date a later webhook does not know", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await upsertCustomer(factsFromNode(node() as never));
      // The customer webhook carries no last-order date; overwriting with null
      // would make an active buyer look like they never ordered.
      await upsertCustomer(factsFromWebhook({ id: 1, total_spent: "1300.00" })!);
      const row = await db.customer.findFirst();
      expect(row?.lastOrderAt).not.toBeNull();
      expect(row?.lifetimeSpend).toBe(130000);
    });
  });

  it("clears the deleted flag when Shopify sends the customer again", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await upsertCustomer(factsFromNode(node() as never));
      await markCustomerDeleted("gid://shopify/Customer/1");
      expect((await db.customer.findFirst())?.deletedInShopifyAt).not.toBeNull();

      await upsertCustomer(factsFromNode(node() as never));
      expect((await db.customer.findFirst())?.deletedInShopifyAt).toBeNull();
    });
  });

  it("keeps the row when Shopify deletes the customer", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await seedCustomer();
      await handleCustomersDelete({
        shop: ALPHA,
        topic: "customers/delete",
        webhookId: "wh_1",
        payload: { id: 1 },
      });

      const row = await db.customer.findFirst();
      expect(row).not.toBeNull();
      expect(row?.deletedInShopifyAt).not.toBeNull();
    });
  });

  it("publishes the buyer metafield on every create and update", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await handleCustomersUpsert(
        {
          shop: ALPHA,
          topic: "customers/update",
          webhookId: "wh_1",
          payload: { id: 1, tags: "wholesale", total_spent: "10.00", currency: "USD" },
        },
        async () => admin,
      );
    });

    const published = queried(admin, "MannonSetBuyerFacts");
    expect(published).toHaveLength(1);
    expect(published[0]!.variables).toMatchObject({
      metafields: [expect.objectContaining({ ownerId: "gid://shopify/Customer/1" })],
    });
  });
});

describe("backfill", () => {
  it("pages through Shopify and queues itself for the next page", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin([
      { nodes: [node()], hasNextPage: true, endCursor: "cursor-1" },
      {
        nodes: [node({ id: "gid://shopify/Customer/2", tags: [] })],
        hasNextPage: false,
        endCursor: null,
      },
    ]);

    await inAlpha(async () => {
      const first = await backfillCustomers(async () => admin);
      expect(first).toMatchObject({ synced: 1, done: false });

      const shop = await db.shop.findFirst();
      expect(shop?.customersBackfillCursor).toBe("cursor-1");
      expect(await db.scheduledJob.count({ where: { kind: "customers.backfill" } })).toBe(
        1,
      );

      const second = await backfillCustomers(async () => admin);
      expect(second).toMatchObject({ done: true, customerCount: 2 });

      const finished = await db.shop.findFirst();
      expect(finished?.customersBackfillCursor).toBeNull();
      expect(finished?.customersBackfilledAt).not.toBeNull();
    });

    // Resumed from where it stopped rather than starting again.
    const pages = queried(admin, "MannonCustomersPage");
    expect(pages.map((call) => call.variables.after)).toEqual([null, "cursor-1"]);
  });

  it("publishes the checkout metafield only for wholesale buyers", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin([
      {
        nodes: [node(), node({ id: "gid://shopify/Customer/2", tags: ["retail"] })],
        hasNextPage: false,
        endCursor: null,
      },
    ]);

    await inAlpha(() => backfillCustomers(async () => admin));

    // Publishing for a retail customer would be thousands of writes for buyers
    // no wholesale rule can match.
    expect(queried(admin, "MannonSetBuyerFacts")).toHaveLength(1);
  });

  it("does nothing for an uninstalled shop", async () => {
    await installShop(ALPHA);
    await inAlpha(() => db.shop.updateMany({ data: { uninstalledAt: new Date() } }));
    const admin = fakeAdmin();

    const result = await inAlpha(() => backfillCustomers(async () => admin));
    expect(result).toEqual({ skipped: "uninstalled" });
    expect(admin.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */

describe("customer groups", () => {
  it("creates the two starter tiers, and only the missing ones", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const first = await createStarterGroups(actor, (template) => template.key);
      expect(first).toHaveLength(GROUP_TEMPLATES.length);

      const second = await createStarterGroups(actor, (template) => template.key);
      expect(second).toEqual([]);
      expect(await db.customerGroup.count()).toBe(GROUP_TEMPLATES.length);
    });
  });

  it("refuses two groups with the same handle", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await createGroup({ name: "Gold tier" }, actor);
      await expect(createGroup({ name: "gold  tier" }, actor)).rejects.toThrow(
        DuplicateGroupHandleError,
      );
    });
  });

  it("derives a safe handle from any name", () => {
    expect(toHandle("  Gold Tier — KSA ")).toBe("gold-tier-ksa");
    expect(toHandle("!!!")).toBe("group");
    expect(toHandle("مجموعة")).toBe("group");
  });

  it("will not delete a group with members until a destination is chosen", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const gold = await createGroup({ name: "Gold" }, actor);
      await seedCustomer({ groupId: gold.id });

      await expect(deleteGroup(gold.id, null, actor)).rejects.toThrow(
        GroupHasMembersError,
      );
      // Nothing was removed by the refused attempt.
      expect(await db.customerGroup.count()).toBe(1);
    });
  });

  it("moves members to the destination group", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const gold = await createGroup({ name: "Gold" }, actor);
      const silver = await createGroup({ name: "Silver" }, actor);
      await seedCustomer({ groupId: gold.id });

      await deleteGroup(gold.id, { kind: "group", id: silver.id }, actor);

      const moved = await db.customer.findFirst();
      expect(moved?.groupId).toBe(silver.id);
      expect(await db.customerGroup.count()).toBe(1);
    });
  });

  it("lets the merchant choose no group, and records what that means", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const gold = await createGroup({ name: "Gold" }, actor);
      await seedCustomer({ groupId: gold.id });

      await deleteGroup(gold.id, { kind: "none" }, actor);

      expect((await db.customer.findFirst())?.groupId).toBeNull();
      const entry = await db.auditLog.findFirst({
        where: { action: "customer_group.deleted" },
      });
      expect(entry?.summary).toContain("priced by their tags alone");
    });
  });

  it("deletes an empty group without asking", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const gold = await createGroup({ name: "Gold" }, actor);
      await deleteGroup(gold.id, null, actor);
      expect(await db.customerGroup.count()).toBe(0);
    });
  });

  it("counts members live rather than from a cached column", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const gold = await createGroup({ name: "Gold" }, actor);
      await seedCustomer({ groupId: gold.id });
      await seedCustomer({ customerId: "gid://shopify/Customer/2", groupId: gold.id });

      const [listed] = await listGroups();
      expect(listed?.memberCount).toBe(2);
      expect((await getGroup(gold.id))?.memberCount).toBe(2);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("the buyers list", () => {
  it("counts only wholesale buyers by default", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await seedCustomer();
      await seedCustomer({ customerId: "gid://shopify/Customer/2", tags: ["retail"] });

      const wholesale = await listCustomers({}, NOW);
      expect(wholesale.total).toBe(1);

      const everyone = await listCustomers({ wholesaleOnly: false }, NOW);
      expect(everyone.total).toBe(2);
    });
  });

  it("counts a group member as wholesale even without the tag", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const gold = await createGroup({ name: "Gold" }, actor);
      await seedCustomer({ tags: [], groupId: gold.id });
      expect((await listCustomers({}, NOW)).total).toBe(1);
    });
  });

  it("searches name, email and company as substrings", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await seedCustomer({ company: "Acme Ltd" });
      await seedCustomer({
        customerId: "gid://shopify/Customer/2",
        company: "Goldsmith & Co",
        email: "hi@goldsmith.test",
      });

      expect((await listCustomers({ search: "acme" }, NOW)).total).toBe(1);
      expect((await listCustomers({ search: "GOLDS" }, NOW)).total).toBe(1);
    });
  });

  it("matches a tag whole, not as a substring", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await seedCustomer({ company: "Acme Ltd", tags: ["wholesale", "gold"] });
      await seedCustomer({
        customerId: "gid://shopify/Customer/2",
        company: "Bright Supply",
        tags: ["wholesale", "goldsmith-only"],
      });

      // Searching a tier name must not drag in every tag that starts with it,
      // or "gold" returns the whole customer base of a jeweller.
      const byTag = await listCustomers({ search: "gold" }, NOW);
      expect(byTag.rows.map((row) => row.company)).toEqual(["Acme Ltd"]);
    });
  });

  it("filters by group, terms, tax exemption and risk", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const gold = await createGroup({ name: "Gold", netTermsDays: 30 }, actor);
      await seedCustomer({ groupId: gold.id, taxExempt: true });
      await seedCustomer({
        customerId: "gid://shopify/Customer/2",
        lastOrderAt: daysAgo(AT_RISK_DAYS + 5),
      });

      expect((await listCustomers({ groupId: gold.id }, NOW)).total).toBe(1);
      expect((await listCustomers({ groupId: "none" }, NOW)).total).toBe(1);
      expect((await listCustomers({ terms: "net" }, NOW)).total).toBe(1);
      expect((await listCustomers({ terms: "prepaid" }, NOW)).total).toBe(1);
      expect((await listCustomers({ taxExempt: true }, NOW)).total).toBe(1);
      expect((await listCustomers({ atRisk: true }, NOW)).total).toBe(1);
    });
  });

  it("paginates and reports the unfiltered total separately", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      for (let index = 0; index < 7; index += 1) {
        await seedCustomer({ customerId: `gid://shopify/Customer/${index}` });
      }

      const page = await listCustomers({ pageSize: 3, page: 2 }, NOW);
      expect(page.rows).toHaveLength(3);
      expect(page.total).toBe(7);
      expect(page.totalUnfiltered).toBe(7);

      const filtered = await listCustomers({ search: "nobody", pageSize: 3 }, NOW);
      expect(filtered.total).toBe(0);
      // The empty state and the no-results state are different screens.
      expect(filtered.totalUnfiltered).toBe(7);
    });
  });
});

describe("row actions", () => {
  it("swaps the group tag in Shopify when a buyer moves tier", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const silver = await createGroup({ name: "Silver", tag: "silver" }, actor);
      const gold = await createGroup({ name: "Gold", tag: "gold" }, actor);
      const customer = await seedCustomer({
        groupId: silver.id,
        tags: ["wholesale", "silver"],
      });

      await changeGroup(customer.id, gold.id, { admin, actor });

      const moved = await db.customer.findFirst();
      expect(moved?.groupId).toBe(gold.id);
      expect(moved?.tags).toEqual(["gold", "wholesale"]);
    });

    expect(queried(admin, "MannonCustomerTagsAdd")[0]!.variables.tags).toEqual(["gold"]);
    expect(queried(admin, "MannonCustomerTagsRemove")[0]!.variables.tags).toEqual([
      "silver",
    ]);
    // Checkout has to be told, or the admin and the till disagree.
    expect(queried(admin, "MannonSetBuyerFacts")).toHaveLength(1);
  });

  it("adds and removes only what actually changed when tags are edited", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const customer = await seedCustomer({ tags: ["wholesale", "silver"] });
      await setTags(customer.id, ["wholesale", "gold"], { admin, actor });
    });

    expect(queried(admin, "MannonCustomerTagsAdd")[0]!.variables.tags).toEqual(["gold"]);
    expect(queried(admin, "MannonCustomerTagsRemove")[0]!.variables.tags).toEqual([
      "silver",
    ]);
  });

  it("writes nothing to Shopify when the tags did not change", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      const customer = await seedCustomer({ tags: ["wholesale"] });
      await setTags(customer.id, [" wholesale "], { admin, actor });
    });

    expect(admin.calls).toHaveLength(0);
  });

  it("refuses tax exemption without a VAT id when the store requires one", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await db.shop.updateMany({ data: { requireVatForTaxExempt: true } });
      const customer = await seedCustomer();

      await expect(setTaxExempt(customer.id, true, { admin, actor })).rejects.toThrow(
        VatRequiredError,
      );
      expect((await db.customer.findFirst())?.taxExempt).toBe(false);
      expect(admin.calls).toHaveLength(0);

      await db.customer.update({
        where: { id: customer.id },
        data: { vatNumber: "SA1234567890" },
      });
      await setTaxExempt(customer.id, true, { admin, actor });
      expect((await db.customer.findFirst())?.taxExempt).toBe(true);
    });
  });

  it("keeps the note out of the audit entry that records it", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      const customer = await seedCustomer();
      await setInternalNote(customer.id, "Slow payer, chase early", actor);

      const entry = await db.auditLog.findFirst({
        where: { action: "customer.note_changed" },
      });
      // The note is staff-only; the log is a wider audience than the field.
      expect(entry?.summary).not.toContain("Slow payer");
      expect((await db.customer.findFirst())?.internalNote).toBe(
        "Slow payer, chase early",
      );
    });
  });

  it("offers the tags already in use for autocomplete", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await seedCustomer({ tags: ["wholesale", "gold"] });
      await seedCustomer({ customerId: "gid://shopify/Customer/2", tags: ["gold"] });
      expect(await existingTags()).toEqual(["gold", "wholesale"]);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("auto-tagging", () => {
  const spendRule = {
    name: "Gold buyers",
    conditions: [
      {
        field: "lifetime_spend" as const,
        op: "gte" as const,
        amount: parseMoney("1000.00", "USD"),
      },
    ],
    addTags: ["gold"],
    removeTags: [],
  };

  it("is refused on a plan that does not include it", async () => {
    await installShop(ALPHA, "free");
    await inAlpha(async () => {
      await expect(createTagRule(spendRule, actor)).rejects.toThrow(FeatureLockedError);
      expect(await db.customerTagRule.count()).toBe(0);
    });
  });

  it("refuses a rule that would match nobody or tag nothing", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await expect(
        createTagRule({ ...spendRule, conditions: [] }, actor),
      ).rejects.toThrow(TagRuleValidationError);
      await expect(createTagRule({ ...spendRule, addTags: [] }, actor)).rejects.toThrow(
        TagRuleValidationError,
      );
    });
  });

  it("previews without writing anything", async () => {
    await installShop(ALPHA);
    await inAlpha(async () => {
      await createTagRule(spendRule, actor);
      await seedCustomer({ lifetimeSpend: 120050 });
      await seedCustomer({ customerId: "gid://shopify/Customer/2", lifetimeSpend: 500 });

      const { result, decisions } = await previewTagRules(NOW);
      expect(result.examined).toBe(2);
      expect(result.changed).toBe(1);
      expect(decisions[0]!.decision.add).toEqual(["gold"]);
      // Nothing written: the tags on both rows are untouched.
      const rows = await db.customer.findMany({ orderBy: { customerId: "asc" } });
      expect(rows.every((row) => !row.tags.includes("gold"))).toBe(true);
    });
  });

  it("applies the same decision the preview showed", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await createTagRule(spendRule, actor);
      await seedCustomer({ lifetimeSpend: 120050 });
      await seedCustomer({ customerId: "gid://shopify/Customer/2", lifetimeSpend: 500 });

      const preview = await previewTagRules(NOW);
      const run = await runTagSweep(admin, actor, NOW);

      expect(run.changed).toBe(preview.result.changed);
      expect(run.failed).toBe(0);

      const tagged = await db.customer.findMany({ where: { tags: { has: "gold" } } });
      expect(tagged).toHaveLength(1);

      const rule = await db.customerTagRule.findFirst();
      expect(rule?.lastMatchCount).toBe(1);
      expect(rule?.lastRunAt).toEqual(NOW);
    });
  });

  it("skips a buyer Shopify refuses and keeps going", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();
    let seen = 0;
    admin.graphql = vi.fn(async (query: string) => {
      if (query.includes("MannonCustomerTagsAdd")) {
        seen += 1;
        if (seen === 1) throw new Error("Shopify said no");
        return { json: async () => ({ data: { tagsAdd: { userErrors: [] } } }) };
      }
      return {
        json: async () => ({
          data: { metafieldsSet: { metafields: [], userErrors: [] } },
        }),
      };
    }) as never;

    await inAlpha(async () => {
      await createTagRule(spendRule, actor);
      await seedCustomer({ lifetimeSpend: 120050 });
      await seedCustomer({
        customerId: "gid://shopify/Customer/2",
        lifetimeSpend: 200000,
      });

      const run = await runTagSweep(admin, actor, NOW);
      // One customer Shopify refuses must not leave the rest untagged.
      expect(run.failed).toBe(1);
      expect(run.changed).toBe(1);
    });
  });

  it("does not tag a customer Shopify has deleted", async () => {
    await installShop(ALPHA);
    const admin = fakeAdmin();

    await inAlpha(async () => {
      await createTagRule(spendRule, actor);
      await seedCustomer({ lifetimeSpend: 120050, deletedInShopifyAt: NOW });

      const run = await runTagSweep(admin, actor, NOW);
      expect(run.examined).toBe(0);
      expect(admin.calls).toHaveLength(0);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("tenant isolation", () => {
  it("does not show one shop's buyers to another", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inAlpha(() => seedCustomer());
    await inBeta(() => seedCustomer({ customerId: "gid://shopify/Customer/9" }));

    expect((await inAlpha(() => listCustomers({}, NOW))).total).toBe(1);
    expect((await inBeta(() => listCustomers({}, NOW))).total).toBe(1);
  });

  it("reads another shop's customer as not found", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const mine = await inAlpha(() => seedCustomer());

    // Guessing an id from another store must be indistinguishable from
    // guessing one that does not exist.
    expect(await inBeta(() => getCustomer(mine.id))).toBeNull();
  });

  it("reads another shop's group as not found, and refuses to delete it", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const gold = await inAlpha(() => createGroup({ name: "Gold" }, actor));

    expect(await inBeta(() => getGroup(gold.id))).toBeNull();
    await expect(inBeta(() => deleteGroup(gold.id, null, actor))).rejects.toMatchObject({
      status: 404,
    });
    // Still there.
    expect(await inAlpha(() => getGroup(gold.id))).not.toBeNull();
  });

  it("will not move another shop's customer into one of my groups", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const theirs = await inAlpha(() => seedCustomer());
    const admin = fakeAdmin();

    await inBeta(async () => {
      const mine = await createGroup({ name: "Gold" }, actor);
      await expect(
        changeGroup(theirs.id, mine.id, { admin, actor }),
      ).rejects.toMatchObject({ status: 404 });
    });

    expect(admin.calls).toHaveLength(0);
  });

  it("keeps a delivery for the wrong shop out of my mirror", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const admin = fakeAdmin();

    await inBeta(() =>
      handleCustomersUpsert(
        {
          shop: BETA,
          topic: "customers/create",
          webhookId: "wh_1",
          payload: { id: 1, tags: "wholesale", total_spent: "10.00", currency: "USD" },
        },
        async () => admin,
      ),
    );

    expect(await inAlpha(() => db.customer.count())).toBe(0);
    expect(await inBeta(() => db.customer.count())).toBe(1);
  });

  it("sweeps only the shop it is scoped to", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const admin = fakeAdmin();

    await inAlpha(() => seedCustomer({ lifetimeSpend: 500000 }));
    await inBeta(() => seedCustomer({ lifetimeSpend: 500000 }));

    await inAlpha(async () => {
      await createTagRule(
        {
          name: "Gold",
          conditions: [
            { field: "lifetime_spend", op: "gte", amount: parseMoney("100.00", "USD") },
          ],
          addTags: ["gold"],
          removeTags: [],
        },
        actor,
      );
      const run = await runTagSweep(admin, actor, NOW);
      expect(run.examined).toBe(1);
    });

    expect((await inBeta(() => db.customer.findFirst()))?.tags).toEqual(["wholesale"]);
  });
});
