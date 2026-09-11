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
/**
 * How old a signed proxy request may be.
 *
 * Shopify signs `timestamp` along with everything else, and until this was
 * checked a signature never expired. That URL carries
 * `logged_in_customer_id`: anyone who came by one — a shared link, a referrer
 * header, a proxy log — could replay it forever. It used to buy a price list.
 * Since the Buyer Agent it buys order history and a credit limit.
 *
 * Generous, because a buyer's clock and ours will disagree and a storefront
 * request can sit in a queue.
 */
export const MAX_SIGNATURE_AGE_MS = 90 * 60_000;

export function proxyContext(
  request: Request,
  options: { now?: Date } = {},
): ProxyContext {
  const params = new URL(request.url).searchParams;

  if (!isValidProxySignature(params)) {
    throw new Response("Invalid signature", { status: 401 });
  }

  // Signed, so this is Shopify's timestamp rather than the caller's claim.
  const seconds = Number(params.get("timestamp"));
  if (!Number.isFinite(seconds)) {
    throw new Response("Missing timestamp", { status: 401 });
  }
  const age = (options.now ?? new Date()).getTime() - seconds * 1000;
  if (Math.abs(age) > MAX_SIGNATURE_AGE_MS) {
    throw new Response("Signature expired", { status: 401 });
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

    // Settings: "A visitor who is not signed in sees no price and no
    // add-to-cart, rather than a retail price they would never pay." Enforced
    // here rather than in the theme, because a block that hides a price it was
    // already sent is a block whose HTML still carries it.
    if (record.hidePricesFromGuests && !context.customerId) {
      throw new Response("Sign in to see prices", { status: 403 });
    }

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

    try {
      return await handler(context);
    } catch (error) {
      // A `Response` is a decision this app made — a 404, a 402, a 401 — and
      // it goes out as written.
      if (error instanceof Response) throw error;

      // Anything else is Shopify's Admin API, or a bug. Either way a buyer
      // standing on the merchant's storefront gets a sentence rather than a
      // stack trace, and the operator gets the detail in the log. Without this
      // a throw mid-handler was a bare 500 on every block, and could leave a
      // half-written row behind with nothing said about it.
      console.error(
        `[mannon] proxy handler failed for ${context.shop}: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }`,
      );
      throw new Response("Something went wrong", { status: 502 });
    }
  });
}
