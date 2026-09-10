import { createHash } from "node:crypto";

import {
  DEFAULT_MESSAGES,
  serializeLimits,
  validateLimit,
  type LimitIssue,
  type MessageTemplates,
  type OrderLimit as EngineLimit,
} from "@mannon/order-limits";
import { money } from "@mannon/pricing-engine";
import type { OrderLimit as LimitRow } from "@prisma/client";

import { db } from "~/db.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import { assertFeature } from "~/lib/billing/gate.server";
import { runMutation, type AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { MANNON_NAMESPACE } from "~/lib/pricing/ruleset.server";
import { shopGid } from "~/lib/shop/domains.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";

/**
 * Storing order limits, and getting them to the cart.
 *
 * The same shape as the pricing ruleset (`docs/adr/0007`): a Function cannot
 * call our API, so the limits travel to checkout as a shop metafield, written
 * whenever one changes. Nothing here decides anything — the deciding is
 * `@mannon/order-limits`, which the admin's preview asks too.
 */

export const LIMITS_KEY = "limits";

const SET_METAFIELDS = `#graphql
  mutation MannonSetLimits($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

export class LimitValidationError extends Error {
  constructor(readonly issues: LimitIssue[]) {
    super(`Limit is not valid: ${issues.map((issue) => issue.code).join(", ")}`);
    this.name = "LimitValidationError";
  }
}

/** A stored row as the engine sees it. */
export function toEngineLimit(row: LimitRow, currencyCode: string): EngineLimit {
  return {
    id: row.id,
    enabled: row.enabled,
    groupId: row.groupId,
    minSubtotal: row.minSubtotal === null ? null : money(row.minSubtotal, currencyCode),
    maxSubtotal: row.maxSubtotal === null ? null : money(row.maxSubtotal, currencyCode),
    minQuantity: row.minQuantity,
    maxQuantity: row.maxQuantity,
    quantityIncrement: row.quantityIncrement,
    countries: row.countries,
  };
}

export interface LimitInput {
  groupId: string | null;
  enabled?: boolean;
  /** Minor units. Null clears the bound. */
  minSubtotal: number | null;
  maxSubtotal: number | null;
  minQuantity: number | null;
  maxQuantity: number | null;
  quantityIncrement: number | null;
  countries: string[];
}

/** The store's own currency, which every limit is written in. */
export async function shopCurrency(): Promise<string> {
  const shop = shopScope.require("orderLimits");
  const record = await db.shop.findUnique({ where: { shop } });
  return record?.currencyCode ?? "USD";
}

export async function listLimits(): Promise<LimitRow[]> {
  return db.orderLimit.findMany({
    // The store-wide fallback last: it is the one that applies when none of the
    // tiers above it did, and reading it in that order is how it works.
    orderBy: [{ groupId: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
}

export function issuesFor(input: LimitInput, currencyCode: string): LimitIssue[] {
  return validateLimit({
    id: "draft",
    enabled: input.enabled ?? true,
    groupId: input.groupId,
    minSubtotal:
      input.minSubtotal === null ? null : money(input.minSubtotal, currencyCode),
    maxSubtotal:
      input.maxSubtotal === null ? null : money(input.maxSubtotal, currencyCode),
    minQuantity: input.minQuantity,
    maxQuantity: input.maxQuantity,
    quantityIncrement: input.quantityIncrement,
    countries: input.countries,
  });
}

function rowData(input: LimitInput) {
  return {
    groupId: input.groupId,
    enabled: input.enabled ?? true,
    minSubtotal: input.minSubtotal,
    maxSubtotal: input.maxSubtotal,
    minQuantity: input.minQuantity,
    maxQuantity: input.maxQuantity,
    // An increment of one constrains nothing; storing it as null says that
    // rather than pretending there is a case pack.
    quantityIncrement:
      input.quantityIncrement !== null && input.quantityIncrement > 1
        ? input.quantityIncrement
        : null,
    countries: input.countries.map((code) => code.trim().toUpperCase()).filter(Boolean),
  };
}

export async function saveLimit(
  input: LimitInput,
  { admin, actor }: { admin: AdminGraphql; actor: AuditActor },
): Promise<LimitRow> {
  // Order limits are a paid capability.
  await assertFeature("order_limits");

  const currencyCode = await shopCurrency();
  const issues = issuesFor(input, currencyCode);
  if (issues.length > 0) throw new LimitValidationError(issues);

  // One limit per group, and one store-wide. Upserting rather than adding a
  // second means a merchant editing a tier's limit cannot end up with two that
  // disagree.
  const existing = await db.orderLimit.findFirst({ where: { groupId: input.groupId } });

  const saved = existing
    ? await db.orderLimit.update({ where: { id: existing.id }, data: rowData(input) })
    : await db.orderLimit.create({
        data: { ...tenant(), ...rowData(input), createdBy: actor.id ?? null },
      });

  await recordAudit({
    actor,
    action: existing ? "order_limit.updated" : "order_limit.created",
    summary: input.groupId
      ? `Set the order limit for one customer group.`
      : `Set the store-wide order limit for wholesale buyers.`,
    subject: { type: "OrderLimit", id: saved.id },
    metadata: rowData(input),
  });

  await publishLimits(admin);
  return saved;
}

export async function deleteLimit(
  id: string,
  { admin, actor }: { admin: AdminGraphql; actor: AuditActor },
) {
  const existing = await db.orderLimit.findUnique({ where: { id } });
  if (!existing) throw new Response("Limit not found", { status: 404 });

  await db.orderLimit.delete({ where: { id } });

  await recordAudit({
    actor,
    action: "order_limit.deleted",
    summary: existing.groupId
      ? `Removed the order limit on one customer group. Their carts are no longer restricted.`
      : `Removed the store-wide order limit. Wholesale carts are no longer restricted.`,
    subject: { type: "OrderLimit", id },
  });

  await publishLimits(admin);
}

/* -------------------------------------------------------------------------- */
/* Getting them to checkout                                                    */
/* -------------------------------------------------------------------------- */

export async function messageTemplates(): Promise<MessageTemplates> {
  // Editing the wording is Settings → Limit display (phase 6.2). Until then
  // the defaults ship, and they already carry the numbers.
  return { ...DEFAULT_MESSAGES };
}

/**
 * Push the current limits to Shopify.
 *
 * Called after every change. Nothing else keeps the cart in step with the
 * admin: a limit that is not published simply does not apply, which is a
 * merchant believing they set a minimum that nobody is held to.
 */
export async function publishLimits(admin: AdminGraphql) {
  const shop = shopScope.require("publishLimits");
  const record = await db.shop.findUnique({ where: { shop } });
  const currencyCode = record?.currencyCode ?? "USD";

  const rows = await listLimits();
  const payload = serializeLimits(
    rows.map((row) => toEngineLimit(row, currencyCode)),
    await messageTemplates(),
    record?.posBypassesLimits ?? true,
  );

  const value = JSON.stringify(payload);
  const hash = createHash("sha256").update(value).digest("hex");

  // An unchanged set is not re-pushed: Shopify counts every mutation against a
  // rate limit shared with pricing, and a no-op write is a real cost.
  if (record?.limitsHash === hash) return { published: false, limitCount: rows.length };

  const ownerId = await shopGid(admin);

  await runMutation<void>(
    admin,
    "metafieldsSet(limits)",
    SET_METAFIELDS,
    {
      metafields: [
        {
          ownerId,
          namespace: MANNON_NAMESPACE,
          key: LIMITS_KEY,
          type: "json",
          value,
        },
      ],
    },
    (data) => {
      const payload = data.metafieldsSet as { userErrors: { message: string }[] };
      return { result: undefined, userErrors: payload.userErrors };
    },
  );

  await db.shop.update({
    where: { shop },
    data: { limitsHash: hash, limitsPublishedAt: new Date() },
  });

  return { published: true, limitCount: rows.length };
}
