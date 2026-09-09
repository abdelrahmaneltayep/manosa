import { parseMoney, type Money } from "@mannon/pricing-engine";
import type { Prisma } from "@prisma/client";

import { db } from "~/db.server";
import type { CustomerNode } from "~/lib/customers/admin-graphql.server";
import { normalizeTags } from "~/lib/customers/tagging";
import { tenant } from "~/lib/tenant/shop-context.server";

/**
 * Mirroring Shopify's customers into our own table.
 *
 * Two doors lead in here — a webhook payload (REST-shaped, snake_case) and a
 * GraphQL node from the backfill — and they carry different fields under
 * different names. Both are narrowed to one shape here, so the rest of the app
 * never has to know which door a row came through.
 */

export interface CustomerFacts {
  customerId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  phone: string | null;
  countryCode: string | null;
  province: string | null;
  tags: string[];
  state: string;
  taxExempt: boolean;
  lifetimeSpend: Money;
  orderCount: number;
  /** Null when unknown, which is not the same as "never ordered". */
  lastOrderAt: Date | null;
}

/** Money on the wire is a decimal string; a bad one must not lose the row. */
function readSpend(amount: unknown, currencyCode: string): Money {
  const text = typeof amount === "string" ? amount : String(amount ?? "0");
  try {
    return parseMoney(text.trim() || "0", currencyCode);
  } catch {
    return parseMoney("0", currencyCode);
  }
}

function readCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const trimmed = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
};

export function factsFromNode(node: CustomerNode): CustomerFacts {
  const currencyCode = node.amountSpent?.currencyCode ?? "USD";

  return {
    customerId: node.id,
    email: trimmed(node.email),
    firstName: trimmed(node.firstName),
    lastName: trimmed(node.lastName),
    company: trimmed(node.defaultAddress?.company),
    phone: trimmed(node.phone),
    countryCode: trimmed(node.defaultAddress?.countryCodeV2)?.toUpperCase() ?? null,
    province: trimmed(node.defaultAddress?.provinceCode),
    tags: normalizeTags(node.tags ?? []),
    state: (trimmed(node.state) ?? "enabled").toLowerCase(),
    taxExempt: node.taxExempt === true,
    lifetimeSpend: readSpend(node.amountSpent?.amount, currencyCode),
    orderCount: readCount(node.numberOfOrders),
    lastOrderAt: readDate(node.lastOrder?.createdAt),
  };
}

interface WebhookCustomer {
  id?: number | string;
  admin_graphql_api_id?: string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  state?: string | null;
  tax_exempt?: boolean | null;
  tags?: string | string[] | null;
  orders_count?: number | null;
  total_spent?: string | null;
  currency?: string | null;
  default_address?: {
    company?: string | null;
    country_code?: string | null;
    province_code?: string | null;
  } | null;
}

/** The GID for a webhook payload, or null when it carries no id at all. */
export function customerIdFromPayload(payload: unknown): string | null {
  const customer = payload as WebhookCustomer;
  if (customer.admin_graphql_api_id) return customer.admin_graphql_api_id;
  if (customer.id !== undefined && customer.id !== null) {
    return `gid://shopify/Customer/${customer.id}`;
  }
  return null;
}

export function factsFromWebhook(
  payload: unknown,
  fallbackCurrency = "USD",
): CustomerFacts | null {
  const customer = payload as WebhookCustomer;
  const customerId = customerIdFromPayload(payload);
  if (!customerId) return null;

  const currencyCode = trimmed(customer.currency) ?? fallbackCurrency;
  const tags =
    typeof customer.tags === "string"
      ? customer.tags.split(",")
      : Array.isArray(customer.tags)
        ? customer.tags
        : [];

  return {
    customerId,
    email: trimmed(customer.email),
    firstName: trimmed(customer.first_name),
    lastName: trimmed(customer.last_name),
    company: trimmed(customer.default_address?.company),
    phone: trimmed(customer.phone),
    countryCode: trimmed(customer.default_address?.country_code)?.toUpperCase() ?? null,
    province: trimmed(customer.default_address?.province_code),
    tags: normalizeTags(tags),
    state: (trimmed(customer.state) ?? "enabled").toLowerCase(),
    taxExempt: customer.tax_exempt === true,
    lifetimeSpend: readSpend(customer.total_spent, currencyCode),
    orderCount: readCount(customer.orders_count),
    // The customer webhook carries the last order's name but not its date, so
    // an existing value is kept rather than overwritten with null.
    lastOrderAt: null,
  };
}

function rowData(facts: CustomerFacts): Prisma.CustomerUncheckedCreateInput {
  return {
    ...tenant(),
    customerId: facts.customerId,
    email: facts.email,
    firstName: facts.firstName,
    lastName: facts.lastName,
    company: facts.company,
    phone: facts.phone,
    countryCode: facts.countryCode,
    province: facts.province,
    tags: facts.tags,
    state: facts.state,
    taxExempt: facts.taxExempt,
    lifetimeSpend: facts.lifetimeSpend.amount,
    currencyCode: facts.lifetimeSpend.currencyCode,
    orderCount: facts.orderCount,
    syncedAt: new Date(),
  };
}

/**
 * Write one customer into the mirror.
 *
 * Idempotent, because webhooks are delivered at least once and the backfill
 * can overlap them. `deletedInShopifyAt` is cleared: a customer arriving again
 * means Shopify has them, whatever a stale delete told us.
 */
export async function upsertCustomer(facts: CustomerFacts) {
  const data = rowData(facts);
  const { shop: _shop, customerId: _customerId, ...updatable } = data;

  return db.customer.upsert({
    where: { shop_customerId: { shop: data.shop, customerId: facts.customerId } },
    create: {
      ...data,
      ...(facts.lastOrderAt ? { lastOrderAt: facts.lastOrderAt } : {}),
    },
    update: {
      ...updatable,
      // Only overwrite the last-order date when this source actually knows it.
      ...(facts.lastOrderAt ? { lastOrderAt: facts.lastOrderAt } : {}),
      deletedInShopifyAt: null,
    },
  });
}

/**
 * Mark a customer gone.
 *
 * The row stays: an open buyers list must not lose a row mid-scroll, group
 * membership counts must not silently change under the merchant, and "deleted
 * in Shopify" is information worth showing. The retention job (7.2) removes
 * these rows for good.
 */
export async function markCustomerDeleted(customerId: string) {
  const { count } = await db.customer.updateMany({
    where: { customerId },
    data: { deletedInShopifyAt: new Date(), syncedAt: new Date() },
  });
  return count;
}
