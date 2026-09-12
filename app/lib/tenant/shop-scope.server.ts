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

/**
 * For each model, which of its relation fields point at which model.
 *
 * Needed because a nested write (`{ lines: { create: [...] } }`) names a
 * *relation*, not a model, and the extension is only told the parent's name.
 * Read once from the generated DMMF, like `scopedModelNames`.
 */
function relationTargets(): Map<string, Map<string, string>> {
  const byModel = new Map<string, Map<string, string>>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const relations = new Map<string, string>();
    for (const field of model.fields) {
      if (field.kind === "object" && typeof field.type === "string") {
        relations.set(field.name, field.type);
      }
    }
    byModel.set(model.name, relations);
  }
  return byModel;
}

/** Nested-write keys that create rows, and so need stamping. */
const NESTED_CREATE_KEYS = new Set(["create", "createMany", "connectOrCreate", "upsert"]);

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

/**
 * Stamp `shop` on a create payload, including the rows nested inside it.
 *
 * Prisma lets one `create` write a whole tree — `{ lines: { create: [...] } }`,
 * `connectOrCreate`, a nested `upsert`. The first version of this recursed into
 * *arrays* (which is what `createMany` needs) and never into relation writes,
 * so a nested row carried whatever `shop` the caller put in it. From one shop's
 * scope you could write an `OrderLine` stamped for another, and their analytics
 * would count it as their revenue.
 *
 * Each nested payload is stamped for the *relation's own* model, which is why
 * this needs the DMMF: a relation to an unscoped model (`Session`) has no
 * `shop` column and stamping one would be a Prisma error.
 */
function scopeCreateData(
  data: unknown,
  shop: string,
  model: string,
  operation: string,
  scoped: Set<string>,
  relations: Map<string, Map<string, string>>,
): unknown {
  if (Array.isArray(data)) {
    return data.map((row) =>
      scopeCreateData(row, shop, model, operation, scoped, relations),
    );
  }
  if (!data || typeof data !== "object") return data;

  const row = data as Record<string, unknown>;
  assertNoConflict(row.shop, shop, model, operation);

  const out: Record<string, unknown> = { ...row };
  if (scoped.has(model)) out.shop = shop;

  const fields = relations.get(model);
  if (!fields) return out;

  for (const [key, value] of Object.entries(row)) {
    const target = fields.get(key);
    if (!target || !value || typeof value !== "object") continue;

    const write = value as Record<string, unknown>;
    const nested: Record<string, unknown> = { ...write };
    let touched = false;

    for (const verb of Object.keys(write)) {
      if (!NESTED_CREATE_KEYS.has(verb)) continue;
      touched = true;
      // `connectOrCreate` and a nested `upsert` wrap the row one level deeper.
      if (verb === "connectOrCreate" || verb === "upsert") {
        const wrap = write[verb];
        const stampInner = (one: unknown) => {
          if (!one || typeof one !== "object") return one;
          const inner = one as Record<string, unknown>;
          const copy: Record<string, unknown> = { ...inner };
          for (const part of ["create", "update"]) {
            if (part in copy) {
              copy[part] = scopeCreateData(
                copy[part],
                shop,
                target,
                operation,
                scoped,
                relations,
              );
            }
          }
          return copy;
        };
        nested[verb] = Array.isArray(wrap) ? wrap.map(stampInner) : stampInner(wrap);
        continue;
      }
      nested[verb] = scopeCreateData(
        write[verb],
        shop,
        target,
        operation,
        scoped,
        relations,
      );
    }

    if (touched) out[key] = nested;
  }

  return out;
}

/**
 * Refuse an update that would move a row into another tenant.
 *
 * `assertNoConflict` guarded `where.shop` and `create.data.shop` and never
 * update `data`, so `update({ where: { id }, data: { shop: other } })` resolved
 * — and the row, with the buyer's name, address and credit limit on it, became
 * somebody else's. A row never legitimately changes shop: there is no feature
 * anywhere in this app that moves data between merchants.
 */
function assertNoRetenant(
  data: unknown,
  shop: string,
  model: string,
  operation: string,
): void {
  if (!data || typeof data !== "object") return;
  const row = data as Record<string, unknown>;
  if (!("shop" in row)) return;

  // Prisma also allows `{ shop: { set: "…" } }` on an update.
  const supplied =
    row.shop && typeof row.shop === "object" && "set" in (row.shop as object)
      ? (row.shop as { set: unknown }).set
      : row.shop;

  assertNoConflict(supplied, shop, model, operation);
}

/**
 * Filter the relations an `include`/`select` reads back.
 *
 * An `include` is resolved by Prisma inside one statement and is never a
 * separate model operation, so the extension never sees it — which meant a
 * to-many relation handed back rows belonging to another shop whenever a child
 * row's foreign key pointed across the line. Adding `where: { shop }` to every
 * to-many relation read closes the half of that hole this layer can reach.
 *
 * A to-one relation takes no `where` in Prisma, so it cannot be filtered here;
 * that half is held by the composite foreign keys in the schema, which make a
 * cross-tenant parent impossible for the database to store.
 */
function scopeRelations(
  node: unknown,
  shop: string,
  model: string,
  scoped: Set<string>,
  relations: Map<string, Map<string, string>>,
): unknown {
  if (!node || typeof node !== "object") return node;

  const fields = relations.get(model);
  if (!fields) return node;

  const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  const list = Prisma.dmmf.datamodel.models.find((one) => one.name === model);

  for (const [key, value] of Object.entries(out)) {
    const target = fields.get(key);
    if (!target || !scoped.has(target)) continue;

    const isList = list?.fields.find((one) => one.name === key)?.isList === true;
    if (!isList) continue;

    const inner = value === true ? {} : { ...(value as Record<string, unknown>) };
    const where = (inner.where ?? {}) as Record<string, unknown>;
    inner.where = { ...where, shop };

    for (const nestedKey of ["include", "select"]) {
      if (inner[nestedKey]) {
        inner[nestedKey] = scopeRelations(
          inner[nestedKey],
          shop,
          target,
          scoped,
          relations,
        );
      }
    }

    out[key] = inner;
  }

  return out;
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
  const relations = relationTargets();

  /**
   * Raw SQL cannot be filtered, so it is made to fail closed instead.
   *
   * `$queryRaw` and friends carry no model, so the model hook below never sees
   * them — and the first version let them straight through, including **outside
   * any tenant scope at all**. `db.$queryRaw`SELECT … FROM "Customer"`` from one
   * shop returned every shop's buyers, and a `DELETE` deleted them.
   *
   * A filter cannot be injected into an opaque SQL string, so this does the one
   * thing it honestly can: refuses to run raw SQL with no tenant, which turns
   * "whose rows are these?" from an unasked question into a crash. Every raw
   * call site must still put `shop` in its own `WHERE` — there are five, all in
   * the deletion paths, and `tests/integration/tenant-isolation.test.ts` checks
   * each one carries it.
   */
  const rawGuard = async ({
    operation,
    args,
    query,
  }: {
    operation: string;
    args: unknown;
    query: (args: never) => Promise<unknown>;
  }) => {
    const store = shopScope.peek();
    if (!store) throw new MissingShopContextError(`raw SQL (${operation})`);
    return query(args as never);
  };

  return client.$extends({
    name: "mannon-shop-scope",
    query: {
      $queryRaw: rawGuard,
      $queryRawUnsafe: rawGuard,
      $executeRaw: rawGuard,
      $executeRawUnsafe: rawGuard,
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

          /** `include`/`select` on the way out, so a relation cannot read across. */
          const scopedReads = (of: Record<string, unknown>) => {
            const out = { ...of };
            for (const key of ["include", "select"] as const) {
              if (out[key]) {
                out[key] = scopeRelations(out[key], shop, model, scopedModels, relations);
              }
            }
            return out;
          };

          if (WHERE_OPERATIONS.has(operation)) {
            // A row never legitimately changes shop, and nothing in this app
            // moves data between merchants.
            assertNoRetenant(next.data, shop, model, operation);

            return query({
              ...scopedReads(next),
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
              ...scopedReads(next),
              data: scopeCreateData(
                next.data,
                shop,
                model,
                operation,
                scopedModels,
                relations,
              ),
            } as typeof args);
          }

          if (operation === "upsert") {
            assertNoRetenant(next.update, shop, model, operation);

            return query({
              ...scopedReads(next),
              where: scopeWhere(
                next.where as Record<string, unknown> | undefined,
                shop,
                model,
                operation,
              ),
              create: scopeCreateData(
                next.create,
                shop,
                model,
                operation,
                scopedModels,
                relations,
              ),
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
