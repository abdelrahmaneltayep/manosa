import { Prisma, type PrismaClient } from "@prisma/client";

import { MissingShopContextError, shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Models that intentionally have a `shop` column but must NOT be auto-scoped.
 * Every entry needs a reason — an unscoped table is a tenant-isolation hole,
 * so this list is reviewed like a security change.
 */
const UNSCOPED_MODELS = new Set<string>([
  // OAuth session lookup happens *before* a shop context exists (the whole
  // point of the callback is to learn which shop this is). The Shopify session
  // storage library keys every query by session id or shop already.
  "Session",
]);

/** Operations whose `where` we filter. */
const WHERE_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
]);

/** Operations whose `data` we stamp. */
const CREATE_OPERATIONS = new Set(["create", "createMany", "createManyAndReturn"]);

export class CrossTenantError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
    readonly requested: string,
    readonly active: string,
  ) {
    super(
      `Cross-tenant ${operation} on ${model}: query asked for shop "${requested}" ` +
        `while the active tenant is "${active}".`,
    );
    this.name = "CrossTenantError";
  }
}

/** Models carrying a scalar `shop` field, read once from the generated DMMF. */
function scopedModelNames(): Set<string> {
  const names = new Set<string>();
  for (const model of Prisma.dmmf.datamodel.models) {
    if (UNSCOPED_MODELS.has(model.name)) continue;
    const hasShop = model.fields.some(
      (field) => field.name === "shop" && field.kind === "scalar",
    );
    if (hasShop) names.add(model.name);
  }
  return names;
}

function assertNoConflict(
  supplied: unknown,
  shop: string,
  model: string,
  operation: string,
) {
  if (supplied === undefined || supplied === null) return;
  if (typeof supplied === "string") {
    if (supplied !== shop) {
      throw new CrossTenantError(model, operation, supplied, shop);
    }
    return;
  }
  // A filter object such as { in: [...] } / { not: ... } could widen the scope
  // past the active tenant, so refuse rather than try to intersect it.
  throw new CrossTenantError(model, operation, JSON.stringify(supplied), shop);
}

function scopeWhere(
  where: Record<string, unknown> | undefined,
  shop: string,
  model: string,
  operation: string,
): Record<string, unknown> {
  assertNoConflict(where?.shop, shop, model, operation);
  return { ...(where ?? {}), shop };
}

function scopeCreateData(
  data: unknown,
  shop: string,
  model: string,
  operation: string,
): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => scopeCreateData(row, shop, model, operation));
  }
  if (data && typeof data === "object") {
    const row = data as Record<string, unknown>;
    assertNoConflict(row.shop, shop, model, operation);
    return { ...row, shop };
  }
  return data;
}

/**
 * Fail-closed multi-tenancy.
 *
 * Every query against a shop-scoped model gets `shop = <active tenant>` merged
 * into its `where`, and every create gets `shop` stamped onto its `data`.
 * Outside a shop context the query throws instead of running unfiltered.
 *
 * Reading another shop's row by id therefore returns null (find) or raises
 * P2025 "record not found" (update/delete) — which is what the route layer
 * turns into a 404.
 */
export function withShopScope<T extends PrismaClient>(client: T) {
  const scopedModels = scopedModelNames();

  return client.$extends({
    name: "mannon-shop-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !scopedModels.has(model)) {
            return query(args);
          }

          const store = shopScope.peek();
          if (!store) {
            throw new MissingShopContextError(`${model}.${operation}`);
          }
          if (store.bypass) {
            return query(args);
          }

          const shop = store.shop;
          const next = (args ?? {}) as Record<string, unknown>;

          if (WHERE_OPERATIONS.has(operation)) {
            return query({
              ...next,
              where: scopeWhere(
                next.where as Record<string, unknown> | undefined,
                shop,
                model,
                operation,
              ),
            } as typeof args);
          }

          if (CREATE_OPERATIONS.has(operation)) {
            return query({
              ...next,
              data: scopeCreateData(next.data, shop, model, operation),
            } as typeof args);
          }

          if (operation === "upsert") {
            return query({
              ...next,
              where: scopeWhere(
                next.where as Record<string, unknown> | undefined,
                shop,
                model,
                operation,
              ),
              create: scopeCreateData(next.create, shop, model, operation),
            } as typeof args);
          }

          // An operation we do not recognise could be a new Prisma feature that
          // reads data. Refuse rather than let it through unfiltered.
          throw new Error(
            `mannon-shop-scope: unhandled operation "${operation}" on ${model}. ` +
              `Add it to WHERE_OPERATIONS/CREATE_OPERATIONS in shop-scope.server.ts ` +
              `after checking how it should be filtered.`,
          );
        },
      },
    },
  });
}

/** Exported for tests and for the tenant-isolation audit. */
export const __testing = { scopedModelNames, UNSCOPED_MODELS };
