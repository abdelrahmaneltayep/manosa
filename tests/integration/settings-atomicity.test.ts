import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as AuditModule from "~/lib/audit/record.server";

import { db } from "~/db.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { resetDatabase } from "../support/db";

/**
 * A setting and the entry that says who changed it are one write.
 *
 * They were two awaits: `shop.update`, then `recordAudit`. Everything about
 * this page is a decision a merchant can be asked about later — which tag is
 * the wholesale tag, whether Mannon's prices combine with a discount code,
 * what a buyer is told when an order is too small — and a change with no entry
 * beside it is indistinguishable from a change nobody made. That is invariant
 * 5 on the page that decides what the app does.
 *
 * The audit write is made to fail here, because that is the half that the old
 * order left exposed: the setting had already landed.
 */

vi.mock("~/lib/audit/record.server", async (importOriginal) => {
  const actual = await importOriginal<typeof AuditModule>();
  return {
    ...actual,
    recordAudit: vi.fn(async (...args: Parameters<typeof actual.recordAudit>) => {
      if (refuseAudit) throw new Error("the audit table is unavailable");
      return actual.recordAudit(...args);
    }),
  };
});

/** Flipped per test rather than per mock, so one file covers both directions. */
let refuseAudit = false;

const ALPHA = "alpha.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const ACTOR = { type: "STAFF" as const, id: "staff-1" };

const fields = (over: Record<string, string> = {}) => {
  const form = new FormData();
  form.set("wholesaleTag", "trade");
  form.set("wholesaleOrderTag", "wholesale-order");
  for (const [key, value] of Object.entries(over)) form.set(key, value);
  return form;
};

beforeEach(async () => {
  await resetDatabase();
  refuseAudit = false;
  await inAlpha(() =>
    db.shop.create({ data: { ...tenant(), wholesaleTag: "wholesale" } }),
  );
});

describe("saving a setting", () => {
  it("writes the change and its audit entry together", async () => {
    const { saveSettings } = await import("~/lib/settings/settings.server");

    await inAlpha(() => saveSettings("wholesale", fields(), { actor: ACTOR }));

    expect((await inAlpha(() => db.shop.findFirst()))?.wholesaleTag).toBe("trade");
    expect(await inAlpha(() => db.auditLog.count())).toBe(1);
  });

  it("leaves the setting alone when the entry cannot be written", async () => {
    const { saveSettings } = await import("~/lib/settings/settings.server");
    refuseAudit = true;

    await expect(
      inAlpha(() => saveSettings("wholesale", fields(), { actor: ACTOR })),
    ).rejects.toThrow("the audit table is unavailable");

    // Before this was one transaction, the tag was already "trade" here, with
    // nothing in the log to say who had done it or when.
    expect((await inAlpha(() => db.shop.findFirst()))?.wholesaleTag).toBe("wholesale");
    expect(await inAlpha(() => db.auditLog.count())).toBe(0);
  });
});

describe("pausing the app", () => {
  /** The pause path publishes; this one only needs the flag half of it. */
  const fakeAdmin = () => ({
    graphql: vi.fn(async () => ({
      json: async () => ({
        data: { metafieldsSet: { metafields: [{ id: "gid://x/M/1" }], userErrors: [] } },
      }),
    })),
  });

  it("does not pause a shop it cannot record having paused", async () => {
    const { pauseApp } = await import("~/lib/settings/pause.server");
    refuseAudit = true;

    await expect(
      inAlpha(() =>
        pauseApp({
          admin: fakeAdmin() as unknown as Parameters<typeof pauseApp>[0]["admin"],
          actor: ACTOR,
        }),
      ),
    ).rejects.toThrow("the audit table is unavailable");

    // A paused app with no entry saying who paused it is the single most
    // consequential control on the page, silently flipped.
    expect((await inAlpha(() => db.shop.findFirst()))?.pausedAt).toBeNull();
    expect(await inAlpha(() => db.auditLog.count())).toBe(0);
  });
});
