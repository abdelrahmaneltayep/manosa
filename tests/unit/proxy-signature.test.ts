import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isValidProxySignature,
  proxyContext,
  ProxySignatureError,
  signablePayload,
} from "~/lib/storefront/proxy.server";

/**
 * The App Proxy signature is the whole security model for wholesale prices.
 *
 * Without it, anyone could ask the app for any buyer's contract prices by
 * putting a customer id in a query string. These cases are the ways that could
 * go wrong.
 */

const SECRET = "test-api-secret";

/** Sign a set of params the way Shopify does, timestamp and all. */
function signed(params: Record<string, string | string[]>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((entry) => search.append(key, entry));
    else search.set(key, value);
  }
  // Shopify signs one, and the app refuses a request without one — a signed URL
  // that never expires carries `logged_in_customer_id` forever.
  if (!search.has("timestamp")) {
    search.set("timestamp", String(Math.floor(Date.now() / 1000)));
  }
  search.set(
    "signature",
    createHmac("sha256", SECRET).update(signablePayload(search)).digest("hex"),
  );
  return search;
}

const requestFor = (params: URLSearchParams) =>
  new Request(`https://mannon.test/proxy/quick-order?${params.toString()}`);

beforeEach(() => {
  process.env.SHOPIFY_API_SECRET = SECRET;
});

afterEach(() => {
  process.env.SHOPIFY_API_SECRET = SECRET;
});

describe("the signable payload", () => {
  it("sorts by name and joins with nothing between pairs", () => {
    const params = new URLSearchParams("shop=b.myshopify.com&path_prefix=/apps/mannon");
    expect(signablePayload(params)).toBe("path_prefix=/apps/mannonshop=b.myshopify.com");
  });

  it("joins a repeated parameter with commas, as Shopify does", () => {
    const params = new URLSearchParams("ids=1&ids=2&shop=b.myshopify.com");
    expect(signablePayload(params)).toBe("ids=1,2shop=b.myshopify.com");
  });

  it("never includes the signature itself", () => {
    const params = new URLSearchParams("shop=b.myshopify.com&signature=deadbeef");
    expect(signablePayload(params)).toBe("shop=b.myshopify.com");
  });
});

describe("verification", () => {
  it("accepts a request Shopify signed", () => {
    expect(isValidProxySignature(signed({ shop: "alpha.myshopify.com" }))).toBe(true);
  });

  it("refuses one with no signature at all", () => {
    expect(isValidProxySignature(new URLSearchParams("shop=alpha.myshopify.com"))).toBe(
      false,
    );
  });

  it("refuses a tampered parameter", () => {
    const params = signed({
      shop: "alpha.myshopify.com",
      logged_in_customer_id: "77",
    });
    // The attack this exists to stop: ask for somebody else's prices.
    params.set("logged_in_customer_id", "78");
    expect(isValidProxySignature(params)).toBe(false);
  });

  it("refuses an added parameter", () => {
    const params = signed({ shop: "alpha.myshopify.com" });
    params.set("logged_in_customer_id", "77");
    expect(isValidProxySignature(params)).toBe(false);
  });

  it("refuses a removed parameter", () => {
    const params = signed({ shop: "alpha.myshopify.com", logged_in_customer_id: "77" });
    params.delete("logged_in_customer_id");
    expect(isValidProxySignature(params)).toBe(false);
  });

  it("refuses a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on a length mismatch; a signature's length is not
    // a secret, so it is checked first.
    const params = signed({ shop: "alpha.myshopify.com" });
    params.set("signature", "abc");
    expect(() => isValidProxySignature(params)).not.toThrow();
    expect(isValidProxySignature(params)).toBe(false);
  });

  it("refuses a signature signed with a different secret", () => {
    const params = signed({ shop: "alpha.myshopify.com" });
    process.env.SHOPIFY_API_SECRET = "someone-elses-secret";
    expect(isValidProxySignature(params)).toBe(false);
  });

  it("refuses everything when the secret is not set, rather than defaulting", () => {
    const params = signed({ shop: "alpha.myshopify.com" });
    delete process.env.SHOPIFY_API_SECRET;
    // Never invented, never defaulted: "we cannot check this" means no.
    expect(() => isValidProxySignature(params)).toThrow(ProxySignatureError);
  });
});

describe("the context it produces", () => {
  it("reads the shop and turns the customer id into a GID", () => {
    const context = proxyContext(
      requestFor(signed({ shop: "Alpha.myshopify.com", logged_in_customer_id: "77" })),
    );

    expect(context.shop).toBe("alpha.myshopify.com");
    expect(context.customerId).toBe("gid://shopify/Customer/77");
  });

  it("calls a signed-out visitor a guest rather than guessing", () => {
    const context = proxyContext(requestFor(signed({ shop: "alpha.myshopify.com" })));
    expect(context.customerId).toBeNull();
  });

  it("throws a 401 Response for a bad signature, not an error", () => {
    const params = signed({ shop: "alpha.myshopify.com" });
    params.set("shop", "beta.myshopify.com");

    try {
      proxyContext(requestFor(params));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(401);
    }
  });

  it("throws a 400 when the signature is good but the shop is missing", () => {
    try {
      proxyContext(requestFor(signed({ locale: "en" })));
      expect.unreachable();
    } catch (error) {
      expect((error as Response).status).toBe(400);
    }
  });

  it("carries the storefront locale through when the theme sent one", () => {
    const context = proxyContext(
      requestFor(signed({ shop: "alpha.myshopify.com", locale: "ar" })),
    );
    expect(context.locale).toBe("ar");
  });
});

describe("how old a signature may be", () => {
  it("refuses one signed hours ago", () => {
    const stale = signed({
      shop: "alpha.myshopify.com",
      timestamp: String(Math.floor((Date.now() - 4 * 60 * 60_000) / 1000)),
    });

    expect(() => proxyContext(requestFor(stale))).toThrow();
    try {
      proxyContext(requestFor(stale));
    } catch (error) {
      expect(error).toMatchObject({ status: 401 });
    }
  });

  it("refuses one with no timestamp at all", () => {
    const search = new URLSearchParams({ shop: "alpha.myshopify.com" });
    search.set(
      "signature",
      createHmac("sha256", SECRET).update(signablePayload(search)).digest("hex"),
    );

    try {
      proxyContext(requestFor(search));
      throw new Error("should have refused");
    } catch (error) {
      expect(error).toMatchObject({ status: 401 });
    }
  });

  it("allows a clock that is a little ahead of ours", () => {
    // A buyer's device and ours will disagree, and a storefront request can
    // sit in a queue. Refusing on a minute of skew would be refusing traffic.
    const skewed = signed({
      shop: "alpha.myshopify.com",
      timestamp: String(Math.floor((Date.now() + 60_000) / 1000)),
    });

    expect(proxyContext(requestFor(skewed)).shop).toBe("alpha.myshopify.com");
  });
});
