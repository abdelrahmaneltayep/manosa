import { describe, expect, it } from "vitest";

import {
  MissingShopContextError,
  shopScope,
  tenant,
  withoutShopScope,
} from "~/lib/tenant/shop-context.server";

describe("shopScope", () => {
  it("has no tenant outside a scope", () => {
    expect(shopScope.get()).toBeUndefined();
    expect(() => shopScope.require("test")).toThrow(MissingShopContextError);
  });

  it("exposes the active tenant inside run()", () => {
    shopScope.run("alpha.myshopify.com", () => {
      expect(shopScope.get()).toBe("alpha.myshopify.com");
      expect(shopScope.require()).toBe("alpha.myshopify.com");
    });
  });

  it("does not leak the tenant after run() resolves", async () => {
    await shopScope.run("alpha.myshopify.com", async () => {
      await Promise.resolve();
    });
    expect(shopScope.get()).toBeUndefined();
  });

  it("survives await boundaries inside the scope", async () => {
    await shopScope.run("alpha.myshopify.com", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(shopScope.get()).toBe("alpha.myshopify.com");
    });
  });

  it("keeps concurrent scopes isolated from each other", async () => {
    const seen: string[] = [];

    const task = (shop: string, delay: number) =>
      shopScope.run(shop, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        seen.push(`${shop}:${shopScope.require()}`);
      });

    // Interleave deliberately: beta finishes first, alpha last.
    await Promise.all([task("alpha.myshopify.com", 20), task("beta.myshopify.com", 1)]);

    expect(seen.sort()).toEqual([
      "alpha.myshopify.com:alpha.myshopify.com",
      "beta.myshopify.com:beta.myshopify.com",
    ]);
  });

  /**
   * Regression: Prisma promises do no work until awaited. Returning one
   * straight out of run() used to execute it after the scope had closed, which
   * made every scoped query fail as if it had no tenant.
   */
  it("keeps the tenant for a thenable that only runs when awaited", async () => {
    const lazy = {
      then(resolve: (value: string) => void) {
        const seen = shopScope.get() ?? "NONE";
        return Promise.resolve().then(() => resolve(seen));
      },
    };

    const seenAtExecution = await shopScope.run("alpha.myshopify.com", () => lazy);
    expect(seenAtExecution).toBe("alpha.myshopify.com");
  });

  it("nests, with the inner scope winning", () => {
    shopScope.run("alpha.myshopify.com", () => {
      shopScope.run("beta.myshopify.com", () => {
        expect(shopScope.require()).toBe("beta.myshopify.com");
      });
      expect(shopScope.require()).toBe("alpha.myshopify.com");
    });
  });

  it("refuses an empty shop", () => {
    expect(() => shopScope.run("", () => null)).toThrow(MissingShopContextError);
  });

  it("marks the bypass and requires a reason", () => {
    expect(() => withoutShopScope("", () => null)).toThrow(/requires a reason/);
    withoutShopScope("cross-tenant cleanup job", () => {
      expect(shopScope.peek()?.bypass).toBe(true);
      expect(shopScope.peek()?.bypassReason).toBe("cross-tenant cleanup job");
    });
  });

  it("tenant() yields the active shop, and refuses outside a scope", () => {
    expect(() => tenant()).toThrow(MissingShopContextError);
    shopScope.run("alpha.myshopify.com", () => {
      expect(tenant()).toEqual({ shop: "alpha.myshopify.com" });
    });
  });

  it("restores the outer scope after a bypass", () => {
    shopScope.run("alpha.myshopify.com", () => {
      withoutShopScope("audit sweep", () => {
        expect(shopScope.peek()?.bypass).toBe(true);
      });
      expect(shopScope.peek()?.bypass).toBe(false);
      expect(shopScope.require()).toBe("alpha.myshopify.com");
    });
  });
});
