import { describe, expect, it } from "vitest";

import { factsFromShopNode, knownTimezone } from "~/lib/shop/domains.server";

/**
 * Reading the shop's own facts.
 *
 * **These were never read at all.** `ensureShopRecord` created the row with
 * defaults and nothing ever filled them in, so `currencyCode` stayed null and
 * every module fell back to `"USD"` — a store selling in euros saw its own
 * revenue, its quotes and its ledger labelled in dollars, and §7's
 * "timezone = store timezone" footer had nothing to state.
 */

describe("the shop's facts, from Shopify", () => {
  const body = (shop: Record<string, unknown> | null) => ({ data: { shop } });

  it("reads what a normal store sends", () => {
    const facts = factsFromShopNode(
      body({
        id: "gid://shopify/Shop/1",
        name: "Acme Coffee",
        contactEmail: "hello@acme.test",
        ianaTimezone: "Europe/Berlin",
        currencyCode: "EUR",
        primaryDomain: { host: "acme.example" },
        shopAddress: { countryCodeV2: "DE" },
      }),
    );

    expect(facts).toEqual({
      shopGid: "gid://shopify/Shop/1",
      name: "Acme Coffee",
      email: "hello@acme.test",
      ianaTimezone: "Europe/Berlin",
      currencyCode: "EUR",
      primaryDomain: "acme.example",
      countryCode: "DE",
    });
  });

  it("uppercases a currency and a country, whatever case they arrive in", () => {
    const facts = factsFromShopNode(
      body({ currencyCode: "eur", shopAddress: { countryCodeV2: "de" } }),
    );

    expect(facts.currencyCode).toBe("EUR");
    expect(facts.countryCode).toBe("DE");
  });

  it("survives a response with nothing in it", () => {
    for (const value of [body(null), body({}), {}]) {
      expect(factsFromShopNode(value).currencyCode).toBeNull();
    }
  });

  it("treats blank strings as absent, so they never overwrite what we know", () => {
    const facts = factsFromShopNode(body({ name: "   ", currencyCode: "" }));

    expect(facts.name).toBeNull();
    expect(facts.currencyCode).toBeNull();
  });
});

describe("a timezone this runtime can actually use", () => {
  it("keeps a real IANA zone", () => {
    for (const zone of ["Europe/London", "Australia/Sydney", "Asia/Riyadh", "UTC"]) {
      expect(knownTimezone(zone)).toBe(zone);
    }
  });

  it("drops one it does not know rather than letting a chart throw", () => {
    // This value is fed to `Intl.DateTimeFormat`, which throws on an unknown
    // zone. A chart in UTC is wrong by hours; a chart that throws is a 500.
    expect(knownTimezone("Mars/Olympus_Mons")).toBeNull();
    expect(knownTimezone("not a zone")).toBeNull();
    expect(knownTimezone(null)).toBeNull();
    expect(knownTimezone("")).toBeNull();
  });
});
