import { createHmac, timingSafeEqual } from "node:crypto";

import { db } from "~/db.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Verifying that a request really came through Shopify's App Proxy.
 *
 * The storefront blocks call the app at `/apps/mannon/...` on the merchant's
 * own domain, and Shopify forwards it here with the shop and — crucially —
 * `logged_in_customer_id`, signed. That signature is the whole security model:
 * without it, anyone could ask for any buyer's contract prices by guessing a
 * customer id.
 *
 * Note this is **not** the webhook HMAC scheme. Webhooks sign the raw body in
 * base64; proxy requests sign the sorted query string in hex. Using one for the
 * other fails closed, but for the wrong reason, so they are kept apart.
 */

export class ProxySignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxySignatureError";
  }
}

/**
 * The string Shopify signs: every query parameter except `signature`, sorted by
 * name, as `key=value` with no separator between pairs. Repeated parameters are
 * joined with commas.
 */
export function signablePayload(params: URLSearchParams): string {
  const grouped = new Map<string, string[]>();

  for (const [key, value] of params.entries()) {
    if (key === "signature") continue;
    const existing = grouped.get(key);
    if (existing) existing.push(value);
    else grouped.set(key, [value]);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, values]) => `${key}=${values.join(",")}`)
    .join("");
}

function secret(): string {
  const value = process.env.SHOPIFY_API_SECRET?.trim();
  if (!value) {
    // Never invented, never defaulted. A missing secret means every request is
    // refused, which is the only safe reading of "we cannot check this".
    throw new ProxySignatureError("SHOPIFY_API_SECRET is not set");
  }
  return value;
}

export function isValidProxySignature(params: URLSearchParams): boolean {
  const provided = params.get("signature");
  if (!provided) return false;

  const expected = createHmac("sha256", secret())
    .update(signablePayload(params))
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  // Length-checked first: timingSafeEqual throws on a mismatch, and the length
  // of a signature is not a secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface ProxyContext {
  shop: string;
  /** Shopify's customer GID, or null for a guest. Signed, so it is trustworthy. */
  customerId: string | null;
  /** The storefront locale, when the theme passed one on. */
  locale: string | null;
}

/**
 * Read and verify a proxy request, without touching the database.
 *
 * Throws a `Response` rather than an error, so a route can let it through
 * untouched: a bad signature is a 401 to whoever sent it, not a stack trace.
 */
export function proxyContext(request: Request): ProxyContext {
  const params = new URL(request.url).searchParams;

  if (!isValidProxySignature(params)) {
    throw new Response("Invalid signature", { status: 401 });
  }

  const shop = params.get("shop")?.trim().toLowerCase();
  if (!shop) throw new Response("Missing shop", { status: 400 });

  const customerId = params.get("logged_in_customer_id")?.trim();

  return {
    shop,
    customerId: customerId ? `gid://shopify/Customer/${customerId}` : null,
    locale: params.get("locale")?.trim() || null,
  };
}

/** How often the "your storefront called us" stamp is refreshed. */
export const STOREFRONT_SEEN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Verify, open the shop's scope, and run.
 *
 * Every proxy route goes through this. Opening the tenant scope before any
 * query is what keeps a storefront request from reaching another store's rows,
 * and doing it in one place means a new block cannot forget.
 */
export async function withProxy<T>(
  request: Request,
  handler: (context: ProxyContext) => Promise<T>,
): Promise<T> {
  const context = proxyContext(request);

  return shopScope.run(context.shop, async () => {
    // An uninstalled or unknown shop is refused before anything else runs.
    const record = await db.shop.findUnique({ where: { shop: context.shop } });
    if (!record || record.uninstalledAt) {
      throw new Response("Shop not found", { status: 404 });
    }
    // The app being paused is the merchant saying "stop applying my rules".
    // The blocks go quiet rather than pricing from a stale idea of them.
    if (record.pausedAt) throw new Response("App paused", { status: 503 });

    // A proxy request can only come from a theme that is rendering our blocks,
    // so this is the one honest signal that the app embed is live — no
    // `themes` scope, no guess. Stamped at most hourly: the home page wants to
    // know *whether*, not *how often*, and a write per storefront request is a
    // cost with no reader.
    const seen = record.storefrontSeenAt;
    if (!seen || Date.now() - seen.getTime() > STOREFRONT_SEEN_INTERVAL_MS) {
      await db.shop.update({
        where: { shop: context.shop },
        data: { storefrontSeenAt: new Date() },
      });
    }

    return handler(context);
  });
}
