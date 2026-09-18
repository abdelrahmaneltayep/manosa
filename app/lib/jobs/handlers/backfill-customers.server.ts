import { db } from "~/db.server";
import { recordAudit, SYSTEM_ACTOR } from "~/lib/audit/record.server";
import {
  CUSTOMER_PAGE_SIZE,
  fetchCustomerPage,
} from "~/lib/customers/admin-graphql.server";
import { factsFromNode, upsertCustomer } from "~/lib/customers/sync.server";
import { enqueueJob } from "~/lib/jobs/queue.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { activeEngineRules } from "~/lib/pricing/rules.server";
import { publishBuyerTerms } from "~/lib/terms/ledger.server";
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

/**
 * The tags a buyer can carry that make them worth publishing to checkout.
 *
 * The shop's configured wholesale tag, plus every tag named by an active
 * tag-targeted rule. A rule targeting `gold` means a buyer tagged `gold` is
 * priced by it at checkout — which cannot happen unless their facts are
 * published, which is what this decides.
 *
 * Lower-cased once, here, because Shopify's tags are merchant-entered and the
 * engine matches them case-insensitively.
 */
async function targetedTags(wholesaleTag: string): Promise<Set<string>> {
  const tags = new Set([wholesaleTag.trim().toLowerCase()]);

  const { rules } = await activeEngineRules();
  for (const rule of rules) {
    if (rule.audience.mode !== "tags") continue;
    for (const tag of rule.audience.tags ?? []) tags.add(tag.trim().toLowerCase());
  }

  tags.delete("");
  return tags;
}

export async function backfillCustomers(adminFor: AdminForShop = offlineAdmin) {
  const shop = shopScope.require("backfillCustomers");
  const record = await db.shop.findUnique({ where: { shop } });

  if (!record) return { skipped: "no install record" as const };
  if (record.uninstalledAt) return { skipped: "uninstalled" as const };

  const admin = await adminFor(shop);
  const page = await fetchCustomerPage(admin, record.customersBackfillCursor);

  // Every tag any active rule actually targets, not just the one configured
  // wholesale tag. The builder defaults `audienceMode` to `"tags"` and
  // encourages a rule like `tags: ["gold"]`, and a buyer tagged `gold` was not
  // "wholesale" by the old test — so their `$app:mannon.buyer` metafield was
  // never written at install, and their admin price was right while checkout
  // charged them retail until somebody happened to edit them in Shopify.
  const targeted = await targetedTags(record.wholesaleTag);

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
      saved.tags.some((tag) => targeted.has(tag.trim().toLowerCase()));

    if (isWholesale) {
      await publishBuyerTerms(admin, {
        ...saved,
        group: saved.groupId
          ? await db.customerGroup.findUnique({ where: { id: saved.groupId } })
          : null,
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
