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

/**
 * Shopify's own GID for this shop.
 *
 * A shop metafield needs an owner id, and the only one Shopify accepts is
 * `gid://shopify/Shop/<numeric>` — not the myshopify domain, and certainly not
 * our own row id. It never changes, so it is read once and cached.
 */
const SHOP_ID = `#graphql
  query MannonShopId {
    shop {
      id
    }
  }`;

export async function shopGid(admin: AdminGraphql): Promise<string> {
  const shop = shopScope.require("shopGid");
  const record = await db.shop.findUnique({ where: { shop } });
  if (record?.shopGid) return record.shopGid;

  const response = await admin.graphql(SHOP_ID);
  const body = (await response.json()) as {
    data?: { shop?: { id?: string | null } | null };
    errors?: { message: string }[];
  };

  const gid = body.data?.shop?.id?.trim();
  if (!gid) {
    // No sensible fallback: writing a metafield to a made-up owner would
    // succeed at nothing while looking like it worked.
    throw new Error(
      `Could not read the shop id for ${shop}` +
        (body.errors?.length ? `: ${body.errors.map((e) => e.message).join("; ")}` : ""),
    );
  }

  await db.shop.update({ where: { shop }, data: { shopGid: gid } });
  return gid;
}

/* -------------------------------------------------------------------------- */

/**
 * The shop's own facts: its currency, its timezone, its name.
 *
 * **These were never read.** `ensureShopRecord` created the row with defaults
 * and nothing ever filled them in, so `currencyCode` stayed null and every
 * module in this app fell back to `"USD"` — which meant a store selling in
 * euros saw its own revenue, its quotes and its ledger all labelled in
 * dollars. Analytics (§7) then asks for the timezone and currency to be stated
 * in a footer, which is not a sentence this app could honestly write.
 *
 * Read once on install and refreshed by `shop/update`, because a merchant does
 * change their currency and their timezone, and a cached answer that is wrong
 * is worse than the fallback.
 */
const SHOP_FACTS = `#graphql
  query MannonShopFacts {
    shop {
      id
      name
      contactEmail
      ianaTimezone
      currencyCode
      primaryDomain {
        host
      }
      shopAddress {
        countryCodeV2
      }
    }
  }`;

export interface ShopFacts {
  shopGid: string | null;
  name: string | null;
  email: string | null;
  ianaTimezone: string | null;
  currencyCode: string | null;
  primaryDomain: string | null;
  countryCode: string | null;
}

interface ShopFactsBody {
  data?: {
    shop?: {
      id?: string | null;
      name?: string | null;
      contactEmail?: string | null;
      ianaTimezone?: string | null;
      currencyCode?: string | null;
      primaryDomain?: { host?: string | null } | null;
      shopAddress?: { countryCodeV2?: string | null } | null;
    } | null;
  };
}

const clean = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
};

export function factsFromShopNode(body: ShopFactsBody): ShopFacts {
  const node = body.data?.shop;

  return {
    shopGid: clean(node?.id),
    name: clean(node?.name),
    email: clean(node?.contactEmail),
    // Validated rather than trusted: this value is fed to `Intl` to bucket
    // every chart by local day, and an unknown zone throws there.
    ianaTimezone: knownTimezone(clean(node?.ianaTimezone)),
    currencyCode: clean(node?.currencyCode)?.toUpperCase() ?? null,
    primaryDomain: clean(node?.primaryDomain?.host),
    countryCode: clean(node?.shopAddress?.countryCodeV2)?.toUpperCase() ?? null,
  };
}

/**
 * A timezone this runtime actually knows.
 *
 * Shopify sends IANA names, but the value ends up in `Intl.DateTimeFormat`,
 * which throws on one it does not recognise — and a chart that throws is worse
 * than a chart in UTC. An unknown zone is dropped, and the footer then says UTC,
 * which is true.
 */
export function knownTimezone(zone: string | null): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/**
 * Read them, and write the ones Shopify gave us.
 *
 * Only fields that came back are written: a partial response must not blank a
 * currency we already knew. Failure is logged and swallowed for the same reason
 * as the domain sync — a page must not 500 because a fact about the shop could
 * not be refreshed.
 */
export async function syncShopFacts(admin: AdminGraphql): Promise<ShopFacts | null> {
  const shop = shopScope.require("syncShopFacts");

  try {
    const response = await admin.graphql(SHOP_FACTS);
    const facts = factsFromShopNode((await response.json()) as ShopFactsBody);

    await db.shop.update({
      where: { shop },
      data: {
        ...(facts.shopGid ? { shopGid: facts.shopGid } : {}),
        ...(facts.name ? { name: facts.name } : {}),
        ...(facts.email ? { email: facts.email } : {}),
        ...(facts.ianaTimezone ? { ianaTimezone: facts.ianaTimezone } : {}),
        ...(facts.currencyCode ? { currencyCode: facts.currencyCode } : {}),
        ...(facts.primaryDomain ? { primaryDomain: facts.primaryDomain } : {}),
        ...(facts.countryCode ? { countryCode: facts.countryCode } : {}),
        shopFactsSyncedAt: new Date(),
      },
    });

    return facts;
  } catch (error) {
    console.warn(
      `[mannon] could not read the shop facts for ${shop}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
