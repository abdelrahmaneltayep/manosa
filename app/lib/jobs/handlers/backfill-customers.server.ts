import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import {
  CUSTOMER_PAGE_SIZE,
  fetchCustomerPage,
} from "~/lib/customers/admin-graphql.server";
import { factsFromNode, upsertCustomer } from "~/lib/customers/sync.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { publishBuyerFacts } from "~/lib/pricing/buyer-facts.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { unauthenticated } from "~/shopify.server";

/**
 * Copy an existing customer base into the mirror, one page at a time.
 *
 * Webhooks only tell us about customers who change. A store installing Mannon
 * with four thousand existing wholesale buyers would otherwise show an empty
 * Customers page until each of them happened to be edited, so the install
 * schedules this once.
 *
 * One page per run, then it re-queues itself with the cursor. That keeps every
 * run short — a request-triggered runner has a timeout, and a job that tries to
 * page through forty thousand customers in one go never finishes any of them.
 */
export type AdminForShop = (shop: string) => Promise<AdminGraphql>;

const offlineAdmin: AdminForShop = async (shop) => {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
};

export async function backfillCustomers(adminFor: AdminForShop = offlineAdmin) {
  const shop = shopScope.require("backfillCustomers");
  const record = await db.shop.findUnique({ where: { shop } });

  if (!record) return { skipped: "no install record" as const };
  if (record.uninstalledAt) return { skipped: "uninstalled" as const };

  const admin = await adminFor(shop);
  const page = await fetchCustomerPage(admin, record.customersBackfillCursor);

  let wholesale = 0;

  for (const node of page.nodes) {
    const facts = factsFromNode(node);
    const saved = await upsertCustomer(facts);

    // Publishing the checkout metafield for every retail customer would be
    // thousands of writes for buyers no wholesale rule will ever match. Only
    // the ones a rule could apply to are published here; anyone tagged later
    // is published by the customers/update webhook.
    const isWholesale =
      saved.groupId !== null ||
      saved.tags.some((tag) => tag.toLowerCase() === record.wholesaleTag.toLowerCase());

    if (isWholesale) {
      await publishBuyerFacts(admin, saved.customerId, {
        tags: saved.tags,
        groupIds: saved.groupId ? [saved.groupId] : [],
      });
      wholesale += 1;
    }
  }

  const customerCount = await db.customer.count();

  if (page.hasNextPage && page.endCursor) {
    await db.shop.update({
      where: { shop },
      data: { customersBackfillCursor: page.endCursor, customerCount },
    });
    // Immediately: the next page is due now, not on some interval.
    await enqueueJob({ kind: "customers.backfill", runAt: new Date() });
    return { synced: page.nodes.length, wholesale, done: false };
  }

  await db.shop.update({
    where: { shop },
    data: {
      customersBackfillCursor: null,
      customersBackfilledAt: new Date(),
      customerCount,
    },
  });

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "customer.backfill_finished",
    summary: `Imported ${customerCount} existing customers from Shopify.`,
    subject: { type: "Shop", id: shop },
    metadata: { customerCount },
  });

  return { synced: page.nodes.length, wholesale, done: true, customerCount };
}

/** How many customers one run reads. Exported for the tests to assert on. */
export const BACKFILL_PAGE_SIZE = CUSTOMER_PAGE_SIZE;
