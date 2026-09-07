import "@shopify/shopify-app-remix/adapters/node";

import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
  type AdminApiContext,
  type Session,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

import { prismaBase } from "~/db.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET ?? "",
  apiVersion: ApiVersion.July25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL ?? "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prismaBase),
  distribution: AppDistribution.AppStore,
  future: {
    // Token exchange instead of the legacy OAuth redirect dance. Requires
    // Shopify-managed installation, which shopify.app.toml declares.
    unstable_newEmbeddedAuthStrategy: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

export interface AdminContext {
  session: Session;
  admin: AdminApiContext;
}

/**
 * The only sanctioned way for an admin route to reach the database.
 *
 * Authenticates the embedded request, then runs the handler inside the tenant
 * scope so every Prisma query is filtered by this shop. Loaders and actions
 * should never call `authenticate.admin` and touch `db` separately — that pair
 * is exactly the mistake the scope exists to prevent.
 */
export async function withAdmin<T>(
  request: Request,
  handler: (ctx: AdminContext) => Promise<T>,
): Promise<T> {
  const { session, admin } = await authenticate.admin(request);
  return shopScope.run(session.shop, () => handler({ session, admin }));
}
