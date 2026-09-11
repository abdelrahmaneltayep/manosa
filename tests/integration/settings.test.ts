import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { activeEngineRules } from "~/lib/pricing/rules.server";
import { pauseApp, resumeApp } from "~/lib/settings/pause.server";
import { saveSettings, SettingsInvalid } from "~/lib/settings/settings.server";
import { settingsView } from "~/lib/settings/view-model.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * Settings against a real database.
 *
 * The two questions worth asking of this page: does a setting a merchant
 * changes actually reach the thing it names, and does "pause" stop what it
 * says it stops.
 */

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const inBeta = <T>(fn: () => Promise<T>) => shopScope.run(BETA, fn);

const ACTOR = { type: "STAFF" as const, id: "staff-1" };
const t = ((key: string) => key) as unknown as Parameters<typeof settingsView>[0]["t"];

/** A stand-in admin client. The publish path is asserted by call, not by wire. */
const fakeAdmin = () => {
  const calls: string[] = [];
  return {
    calls,
    admin: {
      graphql: vi.fn(async (query: string) => {
        calls.push(query);
        return {
          json: async () => ({
            data: {
              metafieldsSet: { metafields: [{ id: "gid://x/M/1" }], userErrors: [] },
              discountAutomaticAppCreate: {
                automaticAppDiscount: { discountId: "gid://shopify/Discount/1" },
                userErrors: [],
              },
              discountAutomaticAppUpdate: {
                automaticAppDiscount: { discountId: "gid://shopify/Discount/1" },
                userErrors: [],
              },
              shop: { id: "gid://shopify/Shop/1" },
            },
          }),
        };
      }),
    },
  };
};

async function installShop(shop: string) {
  await shopScope.run(shop, async () => {
    await db.shop.create({
      data: { ...tenant(), planKey: "growth", discountId: "gid://shopify/Discount/1" },
    });
  });
}

async function rule(name: string, combinable = false) {
  await db.pricingRule.create({
    data: {
      ...tenant(),
      name,
      status: "ACTIVE",
      kind: "PERCENTAGE",
      priority: 1,
      combinable,
      value: { percentage: 20 },
      targets: { kind: "all" },
      audience: { kind: "everyone" },
      markets: { kind: "all" },
    },
  });
}

const body = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
};

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe("saving a section", () => {
  it("writes only its own section's fields", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await saveSettings(
        "wholesale",
        body({ wholesaleTag: "trade", wholesaleOrderTag: "trade-order" }),
        { actor: ACTOR },
      );

      const shop = await db.shop.findUniqueOrThrow({ where: { shop: ALPHA } });
      expect(shop.wholesaleTag).toBe("trade");
      expect(shop.wholesaleOrderTag).toBe("trade-order");
      // Untouched: a section posts its own fields and nothing else, so one
      // section's save cannot quietly reset another's.
      expect(shop.quoteExpiryDays).toBe(14);
      expect(shop.taxDisplay).toBe("excl");
    });
  });

  it("refuses a tag with a comma, because Shopify would split it in two", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await expect(
        saveSettings(
          "wholesale",
          body({ wholesaleTag: "trade,vip", wholesaleOrderTag: "x" }),
          {
            actor: ACTOR,
          },
        ),
      ).rejects.toBeInstanceOf(SettingsInvalid);

      // Nothing written at all — a partial save of a two-field form would
      // leave the merchant with half of what they typed.
      const shop = await db.shop.findUniqueOrThrow({ where: { shop: ALPHA } });
      expect(shop.wholesaleTag).toBe("wholesale");
      expect(shop.wholesaleOrderTag).toBe("wholesale");
    });
  });

  it("refuses a reminder that lands after the quote has expired", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const failed = await saveSettings(
        "orders",
        body({ quoteExpiryDays: "7", quoteReminderDays: "9", posBypassesLimits: "on" }),
        { actor: ACTOR },
      ).catch((error: unknown) => error);

      expect(failed).toBeInstanceOf(SettingsInvalid);
      if (failed instanceof SettingsInvalid) {
        expect(failed.issues.map((issue) => issue.code)).toContain("afterExpiry");
      }
    });
  });

  it("un-verifies the sender when the address changes", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await db.shop.update({
        where: { shop: ALPHA },
        data: {
          senderEmail: "old@shop.com",
          senderDomain: "shop.com",
          senderVerifiedAt: new Date("2026-01-01T00:00:00Z"),
          senderCheckedAt: new Date("2026-01-01T00:00:00Z"),
        },
      });

      await saveSettings("notifications", body({ senderEmail: "new@other.com" }), {
        actor: ACTOR,
      });

      const shop = await db.shop.findUniqueOrThrow({ where: { shop: ALPHA } });
      // A domain verified for one address is not proof of another, and
      // carrying the tick across would be the page claiming a check that
      // never ran for this address.
      expect(shop.senderVerifiedAt).toBeNull();
      expect(shop.senderCheckedAt).toBeNull();
      expect(shop.senderDomain).toBe("other.com");
    });
  });

  it("records who changed what, and nothing when nothing changed", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await saveSettings("discounts", body({ allowShopifyDiscounts: "on" }), {
        actor: ACTOR,
      });
      expect(
        await db.auditLog.count({ where: { action: "settings.discounts_updated" } }),
      ).toBe(1);

      // Saving the same value again is not a change, and a log full of
      // "changed nothing" entries is a log nobody reads.
      await saveSettings("discounts", body({ allowShopifyDiscounts: "on" }), {
        actor: ACTOR,
      });
      expect(
        await db.auditLog.count({ where: { action: "settings.discounts_updated" } }),
      ).toBe(1);
    });
  });

  it("writes one shop's settings and never another's", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inAlpha(async () => {
      await saveSettings(
        "wholesale",
        body({ wholesaleTag: "alpha-trade", wholesaleOrderTag: "alpha-order" }),
        { actor: ACTOR },
      );
    });

    await inBeta(async () => {
      const shop = await db.shop.findUniqueOrThrow({ where: { shop: BETA } });
      expect(shop.wholesaleTag).toBe("wholesale");
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("pausing", () => {
  it("stops every rule from pricing, and deletes nothing", async () => {
    await installShop(ALPHA);
    const { admin } = fakeAdmin();

    await inAlpha(async () => {
      await rule("Wholesale 20%");
      await rule("Café trade price");

      const before = await activeEngineRules();
      expect(before.rules).toHaveLength(2);

      await pauseApp({ admin, actor: ACTOR, now: new Date("2026-09-01T10:00:00Z") });

      // `activeEngineRules` is the single read behind quotes, PO-to-order,
      // quick order, the Buyer Agent and the ruleset publish. Nothing prices.
      const during = await activeEngineRules();
      expect(during.rules).toHaveLength(0);

      // Nothing deleted: the rules are still there, untouched.
      expect(await db.pricingRule.count({ where: { status: "ACTIVE" } })).toBe(2);

      await resumeApp({ admin, actor: ACTOR });
      const after = await activeEngineRules();
      expect(after.rules).toHaveLength(2);
      expect(await db.shop.findUniqueOrThrow({ where: { shop: ALPHA } })).toMatchObject({
        pausedAt: null,
      });
    });
  });

  it("publishes an empty ruleset, because the Function cannot call us", async () => {
    await installShop(ALPHA);
    const { admin, calls } = fakeAdmin();

    await inAlpha(async () => {
      await rule("Wholesale 20%");
      await pauseApp({ admin, actor: ACTOR });

      // Shopify evaluates the published metafield without asking this app, so
      // the flag alone would leave wholesale prices live at checkout.
      expect(calls.some((query) => query.includes("metafieldsSet"))).toBe(true);
      const shop = await db.shop.findUniqueOrThrow({ where: { shop: ALPHA } });
      expect(shop.rulesetRuleCount).toBe(0);
    });
  });

  it("cannot be un-paused by saving a rule while paused", async () => {
    await installShop(ALPHA);
    const { admin } = fakeAdmin();

    await inAlpha(async () => {
      await rule("Wholesale 20%");
      await pauseApp({ admin, actor: ACTOR });

      // Whatever republishes next reads the same function, so a rule saved
      // during a pause cannot quietly put a live ruleset back.
      await rule("Added while paused");
      expect((await activeEngineRules()).rules).toHaveLength(0);
    });
  });

  it("pauses one shop and leaves the other pricing", async () => {
    await installShop(ALPHA);
    await installShop(BETA);
    const { admin } = fakeAdmin();

    await inBeta(async () => {
      await rule("Beta rule");
    });
    await inAlpha(async () => {
      await rule("Alpha rule");
      await pauseApp({ admin, actor: ACTOR });
    });

    await inBeta(async () => {
      expect((await activeEngineRules()).rules).toHaveLength(1);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("the view", () => {
  it("counts what each risky change affects", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await rule("Combines A", true);
      await rule("Combines B", true);
      await rule("Does not combine");

      const view = await settingsView({ locale: "en", t });
      expect(view.discounts.combinableRules).toBe(2);
      expect(view.danger.ruleCount).toBe(3);
      // The count is only half of it: the rules have to be reachable.
      expect(view.discounts.combinableHref).toContain("/app/pricing");
    });
  });

  it("counts the buyers on the tag that is actually in use", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      await db.shop.update({ where: { shop: ALPHA }, data: { wholesaleTag: "trade" } });
      await db.customer.create({
        data: { ...tenant(), customerId: "gid://c/1", tags: ["trade"] },
      });
      await db.customer.create({
        data: { ...tenant(), customerId: "gid://c/2", tags: ["wholesale"] },
      });

      // Renaming the tag does not re-tag anyone, so the count has to follow
      // the tag the shop is on today rather than the default.
      const view = await settingsView({ locale: "en", t });
      expect(view.wholesale.taggedBuyers).toBe(1);
    });
  });

  it("says the sender was never checked rather than that it failed", async () => {
    await installShop(ALPHA);

    await inAlpha(async () => {
      const none = await settingsView({ locale: "en", t });
      expect(none.sender.status).toBe("none");

      await db.shop.update({
        where: { shop: ALPHA },
        data: { senderEmail: "orders@shop.com", senderDomain: "shop.com" },
      });
      const unchecked = await settingsView({ locale: "en", t });
      // Not "unverified": this app has not looked, which is a different claim
      // from having looked and found the records missing.
      expect(unchecked.sender.status).toBe("unchecked");

      await db.shop.update({
        where: { shop: ALPHA },
        data: { senderCheckedAt: new Date(), senderCheckError: "No TXT record found." },
      });
      expect((await settingsView({ locale: "en", t })).sender.status).toBe("failed");

      await db.shop.update({
        where: { shop: ALPHA },
        data: { senderVerifiedAt: new Date() },
      });
      expect((await settingsView({ locale: "en", t })).sender.status).toBe("verified");
    });
  });

  it("reads one shop's settings and never another's", async () => {
    await installShop(ALPHA);
    await installShop(BETA);

    await inBeta(async () => {
      await rule("Beta combines", true);
      await db.shop.update({ where: { shop: BETA }, data: { wholesaleTag: "beta-tag" } });
    });

    await inAlpha(async () => {
      const view = await settingsView({ locale: "en", t });
      expect(view.discounts.combinableRules).toBe(0);
      expect(view.wholesale.wholesaleTag).toBe("wholesale");
    });
  });
});
