import type { Customer, CustomerGroup, Prisma } from "@prisma/client";

import { db } from "~/db.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import { assertFeature } from "~/lib/billing/gate.server";
import {
  applyTagChange,
  setTaxExempt as setTaxExemptInShopify,
} from "~/lib/customers/admin-graphql.server";
import { normalizeTags } from "~/lib/customers/tagging";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { publishBuyerTerms } from "~/lib/terms/ledger.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/** The checklist's pagination threshold for this list. */
export const CUSTOMERS_PAGE_SIZE = 50;

/**
 * A buyer who has ordered before but not lately.
 *
 * Deliberately a plain number rather than a per-customer cadence model: the
 * merchant has to be able to read "at risk" on a row and know exactly what it
 * claims. A real prediction arrives with the AI layer, and will say so.
 */
export const AT_RISK_DAYS = 60;

export class VatRequiredError extends Error {
  constructor(readonly customerId: string) {
    super(
      "This store requires a VAT id before a buyer can be marked tax-exempt. " +
        "Add the VAT id first.",
    );
    this.name = "VatRequiredError";
  }
}

export interface CustomerFilters {
  search?: string;
  /** A group id, or "none" for buyers with no group. */
  groupId?: string;
  /** "net" = has payment terms, "prepaid" = does not. */
  terms?: "net" | "prepaid";
  taxExempt?: boolean;
  atRisk?: boolean;
  status?: "PENDING" | "APPROVED" | "REJECTED";
  /** Only buyers Mannon considers wholesale. On by default. */
  wholesaleOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface CustomerListPage {
  rows: (Customer & { group: CustomerGroup | null })[];
  total: number;
  page: number;
  pageSize: number;
  /** Buyers in this shop before filters — tells "empty" from "no results". */
  totalUnfiltered: number;
}

/**
 * What makes someone a wholesale buyer.
 *
 * Being in a group, or carrying the store's own wholesale tag. Not "has ever
 * ordered a lot": a merchant decides who is wholesale, and this app reports
 * that decision rather than inventing one.
 */
function wholesaleWhere(wholesaleTag: string): Prisma.CustomerWhereInput {
  return { OR: [{ groupId: { not: null } }, { tags: { has: wholesaleTag } }] };
}

function searchWhere(search: string): Prisma.CustomerWhereInput {
  const term = search.trim();
  const contains = { contains: term, mode: "insensitive" as const };

  return {
    OR: [
      { email: contains },
      { firstName: contains },
      { lastName: contains },
      { company: contains },
      // Tags are matched whole: "gold" should not surface "goldsmith".
      { tags: { has: term } },
    ],
  };
}

export async function shopSettings() {
  const shop = shopScope.require("customers");
  const record = await db.shop.findUnique({ where: { shop } });
  return {
    wholesaleTag: record?.wholesaleTag ?? "wholesale",
    requireVatForTaxExempt: record?.requireVatForTaxExempt ?? false,
    customersBackfilledAt: record?.customersBackfilledAt ?? null,
    currencyCode: record?.currencyCode ?? "USD",
  };
}

export async function listCustomers(
  filters: CustomerFilters = {},
  now: Date = new Date(),
): Promise<CustomerListPage> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize ?? CUSTOMERS_PAGE_SIZE;
  const { wholesaleTag } = await shopSettings();
  const wholesaleOnly = filters.wholesaleOnly ?? true;

  const scope: Prisma.CustomerWhereInput = wholesaleOnly
    ? wholesaleWhere(wholesaleTag)
    : {};

  const conditions: Prisma.CustomerWhereInput[] = [scope];

  if (filters.search) conditions.push(searchWhere(filters.search));
  if (filters.groupId === "none") conditions.push({ groupId: null });
  else if (filters.groupId) conditions.push({ groupId: filters.groupId });
  if (filters.terms === "net")
    conditions.push({ group: { netTermsDays: { not: null } } });
  if (filters.terms === "prepaid") {
    conditions.push({ OR: [{ groupId: null }, { group: { netTermsDays: null } }] });
  }
  if (filters.taxExempt !== undefined) conditions.push({ taxExempt: filters.taxExempt });
  if (filters.status) conditions.push({ status: filters.status });
  if (filters.atRisk) {
    conditions.push({
      lastOrderAt: { not: null, lt: new Date(now.getTime() - AT_RISK_DAYS * 86_400_000) },
    });
  }

  const where: Prisma.CustomerWhereInput = { AND: conditions };

  const [rows, total, totalUnfiltered] = await Promise.all([
    db.customer.findMany({
      where,
      include: { group: true },
      // Newest buyers first is the wrong default here: a merchant opens this
      // list to act on who is quiet, so recency of ordering leads.
      orderBy: [{ lastOrderAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.customer.count({ where }),
    db.customer.count({ where: scope }),
  ]);

  return { rows, total, page, pageSize, totalUnfiltered };
}

export async function getCustomer(id: string) {
  return db.customer.findUnique({ where: { id }, include: { group: true } });
}

/** Every tag in use, for the tag editor's autocomplete. */
export async function existingTags(limit = 200): Promise<string[]> {
  const rows = await db.customer.findMany({ select: { tags: true }, take: 2000 });
  const seen = new Set<string>();

  for (const row of rows) {
    for (const tag of row.tags) seen.add(tag);
  }

  return normalizeTags([...seen]).slice(0, limit);
}

/**
 * Republish the metafield checkout reads for this buyer.
 *
 * Goes through `publishBuyerTerms` rather than writing the facts directly, so
 * a group change cannot silently withdraw the credit that group grants.
 */
async function republishBuyer(
  admin: AdminGraphql,
  customer: { id: string; customerId: string },
) {
  const buyer = await db.customer.findUnique({
    where: { id: customer.id },
    include: { group: true },
  });
  if (!buyer) return;
  await publishBuyerTerms(admin, buyer);
}

export interface CustomerContext {
  admin: AdminGraphql;
  actor: AuditActor;
}

/**
 * Move a buyer between tiers.
 *
 * The group's tag goes on in Shopify and the old group's comes off, because
 * pricing rules target tags and a group that only exists in our database would
 * price correctly in the admin and wrongly at checkout.
 */
export async function changeGroup(
  id: string,
  groupId: string | null,
  { admin, actor }: CustomerContext,
) {
  const customer = await db.customer.findUnique({
    where: { id },
    include: { group: true },
  });
  if (!customer) throw new Response("Customer not found", { status: 404 });

  const target = groupId
    ? await db.customerGroup.findUnique({ where: { id: groupId } })
    : null;
  if (groupId && !target) throw new Response("Group not found", { status: 404 });

  const remove =
    customer.group && customer.group.id !== groupId ? [customer.group.tag] : [];
  const add =
    target && !customer.tags.some((tag) => tag.toLowerCase() === target.tag.toLowerCase())
      ? [target.tag]
      : [];

  await applyTagChange(admin, customer.customerId, { add, remove });

  const tags = normalizeTags([
    ...customer.tags.filter(
      (tag) => !remove.some((gone) => gone.toLowerCase() === tag.toLowerCase()),
    ),
    ...add,
  ]);

  const updated = await db.customer.update({
    where: { id },
    data: { groupId: target?.id ?? null, tags },
  });

  await republishBuyer(admin, updated);

  await recordAudit({
    actor,
    action: "customer.group_changed",
    summary: target
      ? `Moved ${describe(customer)} to the “${target.name}” group.`
      : `Removed ${describe(customer)} from ${customer.group ? `the “${customer.group.name}” group` : "their group"}.`,
    subject: { type: "Customer", id },
    metadata: { from: customer.groupId, to: target?.id ?? null, add, remove },
  });

  return updated;
}

/** Set a buyer's tags outright, from the tag editor. */
export async function setTags(
  id: string,
  nextTags: string[],
  { admin, actor }: CustomerContext,
) {
  const customer = await db.customer.findUnique({ where: { id } });
  if (!customer) throw new Response("Customer not found", { status: 404 });

  const wanted = normalizeTags(nextTags);
  const current = normalizeTags(customer.tags);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  const add = wanted.filter((tag) => !current.some((have) => same(have, tag)));
  const remove = current.filter((tag) => !wanted.some((want) => same(want, tag)));

  if (add.length === 0 && remove.length === 0) return customer;

  await applyTagChange(admin, customer.customerId, { add, remove });

  const updated = await db.customer.update({ where: { id }, data: { tags: wanted } });
  await republishBuyer(admin, updated);

  await recordAudit({
    actor,
    action: "customer.tags_changed",
    summary: `Changed the tags on ${describe(customer)}.`,
    subject: { type: "Customer", id },
    metadata: { add, remove },
  });

  return updated;
}

/** Staff-only note. Never leaves the admin. */
export async function setInternalNote(id: string, note: string, actor: AuditActor) {
  const customer = await db.customer.findUnique({ where: { id } });
  if (!customer) throw new Response("Customer not found", { status: 404 });

  const updated = await db.customer.update({
    where: { id },
    data: { internalNote: note.trim() ? note.trim() : null },
  });

  await recordAudit({
    actor,
    action: "customer.note_changed",
    // The note itself is not copied into the log: it is staff-only, and an
    // audit entry is a wider audience than the field it describes.
    summary: `${note.trim() ? "Updated" : "Removed"} the internal note on ${describe(customer)}.`,
    subject: { type: "Customer", id },
  });

  return updated;
}

export async function setTaxExempt(
  id: string,
  taxExempt: boolean,
  { admin, actor }: CustomerContext,
) {
  const customer = await db.customer.findUnique({ where: { id } });
  if (!customer) throw new Response("Customer not found", { status: 404 });

  const { requireVatForTaxExempt } = await shopSettings();
  if (taxExempt && requireVatForTaxExempt && !customer.vatNumber) {
    throw new VatRequiredError(id);
  }

  await setTaxExemptInShopify(admin, customer.customerId, taxExempt);
  const updated = await db.customer.update({ where: { id }, data: { taxExempt } });

  await recordAudit({
    actor,
    action: taxExempt ? "customer.tax_exempted" : "customer.tax_exemption_removed",
    summary: taxExempt
      ? `Marked ${describe(customer)} tax-exempt.`
      : `Removed tax exemption from ${describe(customer)}.`,
    subject: { type: "Customer", id },
    metadata: { vatNumber: customer.vatNumber ?? null },
  });

  return updated;
}

/** How a customer is named in an audit entry. */
function describe(
  customer: Pick<Customer, "company" | "email" | "firstName" | "lastName">,
) {
  const person = [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim();
  // `??` would be wrong here: an empty name joins to "", not null, and the log
  // would read "Moved  to the Gold group".
  return customer.company || person || customer.email || "a customer";
}

/**
 * Set one buyer's own payment terms.
 *
 * These replace their group's rather than merging with them — the rule lives in
 * `@mannon/net-terms` — and republishing is what carries the change to
 * checkout. Nothing here touches an invoice that already exists: an order keeps
 * the terms it was raised under, which is what the buyer was told.
 */
export async function setTerms(
  id: string,
  input: { netTermsDays: number | null; creditLimit: number | null },
  { admin, actor }: CustomerContext,
) {
  await assertFeature("net_terms");

  const customer = await db.customer.findUnique({ where: { id } });
  if (!customer) throw new Response("Customer not found", { status: 404 });

  const updated = await db.customer.update({
    where: { id },
    data: { netTermsDays: input.netTermsDays, creditLimit: input.creditLimit },
  });

  await recordAudit({
    actor,
    action: "customer.terms_changed",
    summary:
      input.netTermsDays === null
        ? `Removed ${updated.company ?? updated.email ?? "a buyer"}'s own payment terms. Their group's terms apply again.`
        : `Set ${updated.company ?? updated.email ?? "a buyer"} to Net ${input.netTermsDays}. This applies to new orders only.`,
    subject: { type: "Customer", id },
    metadata: { ...input, currencyCode: customer.currencyCode },
  });

  await republishBuyer(admin, updated);
  return updated;
}
