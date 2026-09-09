import { db } from "~/db.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * The storefront a merchant's buyers actually visit.
 *
 * Needed for exactly one thing: a registration form embedded in the theme is
 * framed by the storefront, so the form's `frame-ancestors` has to name that
 * origin. Allowing every origin instead would let anyone frame a merchant's
 * application form on their own site.
 *
 * Most stores have a custom domain, so `<shop>.myshopify.com` is not enough.
 */
const SHOP_DOMAIN = `#graphql
  query MannonShopDomain {
    shop {
      primaryDomain {
        host
      }
    }
  }`;

export async function syncShopDomain(admin: AdminGraphql): Promise<string | null> {
  const shop = shopScope.require("syncShopDomain");

  try {
    const response = await admin.graphql(SHOP_DOMAIN);
    const body = (await response.json()) as {
      data?: { shop?: { primaryDomain?: { host?: string | null } | null } | null };
    };

    const host = body.data?.shop?.primaryDomain?.host?.trim() || null;
    if (!host) return null;

    await db.shop.update({ where: { shop }, data: { primaryDomain: host } });
    return host;
  } catch (error) {
    // Publishing a form must not fail because we could not read a domain. The
    // myshopify host still works; a custom domain simply will not frame until
    // the next publish.
    console.warn(
      `[mannon] could not read the primary domain for ${shop}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * The `frame-ancestors` for a public form page.
 *
 * The merchant's own storefront, and nobody else. `'none'` when we do not know
 * the shop at all — a form nobody can frame beats a form anybody can.
 */
export function frameAncestorsFor(shop: string, primaryDomain: string | null): string {
  const origins = [`https://${shop}`];
  if (primaryDomain && primaryDomain !== shop) origins.push(`https://${primaryDomain}`);
  return `frame-ancestors ${origins.join(" ")}`;
}
