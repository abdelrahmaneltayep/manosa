import { PrismaClient } from "@prisma/client";

import { withShopScope } from "~/lib/tenant/shop-scope.server";

declare global {
  var __mannonPrisma: PrismaClient | undefined;
}

/**
 * Raw client. Only the session-storage adapter and the tenant guard itself
 * should ever see this — everything else uses `db`.
 */
export const prismaBase =
  global.__mannonPrisma ??
  new PrismaClient({
    // Tests deliberately provoke P2025 (cross-tenant update/delete), so the
    // expected-error noise is silenced there rather than in the assertions.
    log:
      process.env.NODE_ENV === "test"
        ? []
        : process.env.NODE_ENV === "development"
          ? ["warn", "error"]
          : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  // Vite reloads modules on every change; without this the dev server opens a
  // new connection pool per edit and exhausts Postgres.
  global.__mannonPrisma = prismaBase;
}

/**
 * The client every feature uses. Refuses to run outside a shop context and
 * filters every query by the active tenant.
 */
export const db = withShopScope(prismaBase);

export type Db = typeof db;
