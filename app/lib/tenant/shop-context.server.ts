import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped tenant context.
 *
 * Everything that touches merchant data runs inside `shopScope.run(shop, fn)`.
 * The Prisma extension (shop-scope.server.ts) reads this store on every query
 * and refuses to run without it, so "forgot to filter by shop" becomes a
 * crash in development instead of a data leak in production.
 *
 * We deliberately use `run()` rather than `enterWith()`: with HTTP keep-alive,
 * `enterWith()` can bleed a store into later requests on the same socket.
 */

interface ShopStore {
  shop: string;
  /** Set by withoutShopScope() for the rare genuinely cross-tenant query. */
  bypass: boolean;
  /** Why the bypass was granted. Logged, so it can never be silent. */
  bypassReason?: string;
}

const storage = new AsyncLocalStorage<ShopStore>();

/**
 * Keep the store alive across a lazily-executed thenable.
 *
 * A `PrismaPromise` does no work until something calls `.then()` on it. If the
 * caller writes `shopScope.run(shop, () => db.shop.findMany())` the query is
 * built inside the scope but *executed* wherever the await happens — outside,
 * with no tenant, which the extension then rejects. Resolving here calls
 * `.then()` while the store is still active, so the ergonomic spelling is also
 * the correct one.
 */
function settleInScope<T>(result: T): T {
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    typeof (result as { then?: unknown }).then === "function"
  ) {
    return Promise.resolve(result) as T;
  }
  return result;
}

export class MissingShopContextError extends Error {
  constructor(detail: string) {
    super(
      `No shop context: ${detail}. Wrap this work in shopScope.run(shop, ...) — ` +
        `usually by using withAdmin()/withWebhook() from ~/shopify.server — or, ` +
        `if the query is genuinely cross-tenant, withoutShopScope("reason", ...).`,
    );
    this.name = "MissingShopContextError";
  }
}

export const shopScope = {
  /** Run `fn` with `shop` as the active tenant. */
  run<T>(shop: string, fn: () => T): T {
    if (!shop) {
      throw new MissingShopContextError("shopScope.run() called with an empty shop");
    }
    return storage.run({ shop, bypass: false }, () => settleInScope(fn()));
  },

  /** The active shop, or undefined outside any scope. */
  get(): string | undefined {
    return storage.getStore()?.shop;
  },

  /** The active shop, or throw. Use where a missing tenant is a bug. */
  require(detail = "operation requires a tenant"): string {
    const store = storage.getStore();
    if (!store?.shop) throw new MissingShopContextError(detail);
    return store.shop;
  },

  /** Internal: the raw store, for the Prisma extension. */
  peek(): ShopStore | undefined {
    return storage.getStore();
  },
};

/**
 * Spread into a create so the tenant column is explicit at the call site:
 *
 *   db.pricingRule.create({ data: { ...tenant(), name } })
 *
 * Prisma keeps `shop` required in its generated input types, which is a
 * feature here: the compiler makes you say which tenant you are writing for,
 * and the scope extension rejects it if the answer is not the active one. You
 * cannot forget it, and you cannot lie about it.
 */
export function tenant(): { shop: string } {
  return { shop: shopScope.require("tenant()") };
}

/**
 * Escape hatch for queries that must span tenants — webhook dispatch before
 * the shop is known, uninstall cleanup jobs, platform-wide cron.
 *
 * It is deliberately noisy: a reason is required and every use is greppable.
 * If you reach for this inside a route loader/action, that is almost always
 * the wrong call.
 */
export function withoutShopScope<T>(reason: string, fn: () => T): T {
  if (!reason?.trim()) {
    throw new Error("withoutShopScope() requires a reason");
  }
  const current = storage.getStore();
  return storage.run(
    { shop: current?.shop ?? "__unscoped__", bypass: true, bypassReason: reason },
    () => settleInScope(fn()),
  );
}
