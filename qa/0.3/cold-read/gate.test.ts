/**
 * Cold read of 0.3 — failing tests that demonstrate the findings.
 *
 * Run: TEST_DATABASE_URL=... npx vitest run --config qa/0.3/cold-read/vitest.config.ts
 *
 * Each `it` is named for the behaviour a merchant is entitled to. A failure
 * here is the bug, not the test.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db.server";
import { loadEntitlements } from "~/lib/billing/entitlements.server";
import { assertFeature, FeatureLockedError } from "~/lib/billing/gate.server";
import { syncSubscription } from "~/lib/billing/subscription.server";
import { usageFor } from "~/lib/billing/usage.server";
import { createForm } from "~/lib/forms/forms.server";
import { DEFAULT_APPEARANCE } from "~/lib/forms/appearance";
import { DEFAULT_PUBLISH } from "~/lib/forms/appearance";
import type { FormDefinition } from "~/lib/forms/schema";
import type { EmailTemplates } from "~/lib/forms/merge-tags";
import { runImport } from "~/lib/pricing/csv/import.server";
import { parseCsv } from "~/lib/pricing/csv/parse";
import { planImport } from "~/lib/pricing/csv/plan";
import { detectTemplate } from "~/lib/pricing/csv/templates";
import { activeEngineRules } from "~/lib/pricing/rules.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { prismaBase, resetDatabase } from "../../../tests/support/db";
import { signedWebhookRequest } from "../../../tests/support/webhook-request";

const ALPHA = "alpha.myshopify.com";
const inAlpha = <T>(fn: () => Promise<T>) => shopScope.run(ALPHA, fn);
const actor = { type: "STAFF" as const, id: "staff-1" };

const HEADER =
  "rule_name,type,value,applies_to,skus,customer_tags,status,priority,combinable,starts_at,ends_at";

function fakeAdmin(): AdminGraphql {
  return {
    graphql: vi.fn(async (query: string) => {
      const data = query.includes("MannonVariantsBySku")
        ? { productVariants: { nodes: [] } }
        : query.includes("MannonDiscountFunction")
          ? { shopifyFunctions: { nodes: [{ id: "gid://fn/1", title: "Mannon" }] } }
          : query.includes("MannonCreateDiscount")
            ? {
                discountAutomaticAppCreate: {
                  automaticAppDiscount: { discountId: "gid://discount/1" },
                  userErrors: [],
                },
              }
            : { metafieldsSet: { metafields: [{ id: "gid://mf/1" }], userErrors: [] } };
      return { json: async () => ({ data }) };
    }),
  } as unknown as AdminGraphql;
}

async function installShop(
  shop: string,
  data: Record<string, unknown> = { planKey: "free", billingStatus: "NONE" },
) {
  await shopScope.run(shop, () =>
    db.shop.create({ data: { ...tenant(), currencyCode: "USD", ...data } }),
  );
}

function planFor(csv: string) {
  const doc = parseCsv(csv);
  return planImport(doc, detectTemplate(doc.headers)!, {
    currencyCode: "USD",
    skuToVariantId: new Map<string, string>(),
    existingNames: new Set<string>(),
    now: new Date("2026-06-15T12:00:00Z"),
  });
}

const formInput = (overrides: Record<string, unknown> = {}) => ({
  name: "Wholesale application",
  definition: {
    v: 1,
    fields: [
      { key: "first_name", kind: "text", label: "First name", required: true, showWhen: null },
      { key: "email", kind: "email", label: "Email", required: true, showWhen: null },
      { key: "company", kind: "company", label: "Company", required: true, showWhen: null },
      { key: "privacy", kind: "privacy", label: "Privacy", required: true, showWhen: null },
    ],
  } as FormDefinition,
  appearance: { ...DEFAULT_APPEARANCE },
  emails: {
    confirmation: { subject: "Got it", body: "Hi" },
    approved: { subject: "Welcome", body: "You are in" },
    rejected: { subject: "Sorry", body: "Not this time" },
    needs_info: { subject: "One more thing", body: "We need {{reason}}" },
  } as EmailTemplates,
  publish: { ...DEFAULT_PUBLISH },
  ...overrides,
});

beforeEach(resetDatabase);
afterAll(async () => {
  await prismaBase.$disconnect();
});

/* ── F1 ─────────────────────────────────────────────────────────────────── */

describe("F1 — CSV import is a Pro capability", () => {
  it("refuses to run an import for a shop on Free", async () => {
    await installShop(ALPHA);

    // The gate itself agrees the capability is locked on Free…
    await expect(inAlpha(() => assertFeature("csv_import"))).rejects.toBeInstanceOf(
      FeatureLockedError,
    );

    // …but nothing on the import path ever asks it.
    const result = await inAlpha(() =>
      runImport(planFor(`${HEADER}\nA,percentage,10,all,,wholesale,draft,100,no,,\n`), {
        fileName: "prices.csv",
        admin: fakeAdmin(),
        actor,
      }),
    ).catch((error) => error);

    expect(result, "a Free shop imported rules from a CSV").toBeInstanceOf(
      FeatureLockedError,
    );
  });
});

/* ── F2 ─────────────────────────────────────────────────────────────────── */

describe("F2 — usage meters count what exists", () => {
  it("reports the pricing rules and forms actually in use", async () => {
    await installShop(ALPHA, { planKey: "growth", billingStatus: "ACTIVE" });

    await inAlpha(async () => {
      await runImport(
        planFor(
          `${HEADER}\nA,percentage,10,all,,wholesale,active,100,no,,\n` +
            `B,percentage,20,all,,wholesale,active,100,no,,\n` +
            `C,percentage,30,all,,wholesale,active,100,no,,\n`,
        ),
        { fileName: "prices.csv", admin: fakeAdmin(), actor },
      );
      await createForm(formInput(), actor);
    });

    expect(await inAlpha(() => usageFor("pricingRules"))).toBe(3);
    expect(await inAlpha(() => usageFor("forms"))).toBe(1);
  });
});

/* ── F3 ─────────────────────────────────────────────────────────────────── */

describe("F3 — over-quota rules pause when the plan lapses", () => {
  it("stops publishing rules beyond what the effective plan allows", async () => {
    await installShop(ALPHA, { planKey: "growth", billingStatus: "ACTIVE" });

    await inAlpha(() =>
      runImport(
        planFor(
          `${HEADER}\nA,percentage,10,all,,wholesale,active,100,no,,\n` +
            `B,percentage,11,all,,wholesale,active,101,no,,\n` +
            `C,percentage,12,all,,wholesale,active,102,no,,\n` +
            `D,percentage,13,all,,wholesale,active,103,no,,\n` +
            `E,percentage,14,all,,wholesale,active,104,no,,\n`,
        ),
        { fileName: "prices.csv", admin: fakeAdmin(), actor },
      ),
    );

    // The subscription is cancelled. effectivePlan is Free, which allows one rule.
    await inAlpha(() =>
      db.shop.update({ where: { shop: ALPHA }, data: { billingStatus: "CANCELLED" } }),
    );

    const entitlements = await inAlpha(() => loadEntitlements());
    expect(entitlements.effectivePlan).toBe("free");
    expect(entitlements.limits.pricingRules).toBe(1);

    // What still reaches checkout.
    const published = await inAlpha(() => activeEngineRules());
    expect(
      published.rules.length,
      "all five rules still apply at checkout on a lapsed subscription",
    ).toBeLessThanOrEqual(1);
  });
});

/* ── F4 ─────────────────────────────────────────────────────────────────── */

describe("F4 — the subscription webhook survives out-of-order delivery", () => {
  it("ignores a cancellation for a subscription that was already replaced", async () => {
    await installShop(ALPHA);

    const post = async (request: Request) => {
      const { action } = await import("~/routes/webhooks.$");
      return action({ request, params: {}, context: {} as never });
    };

    const deliver = (body: Record<string, unknown>, id: string) =>
      post(
        signedWebhookRequest({
          shop: ALPHA,
          topic: "app_subscriptions/update",
          webhookId: id,
          payload: body as Record<string, unknown>,
        }),
      );

    // 1. The merchant upgrades: Shopify creates subscription 2 (growth) …
    await deliver(
      {
        app_subscription: {
          admin_graphql_api_id: "gid://shopify/AppSubscription/2",
          name: "growth-monthly",
          status: "ACTIVE",
          created_at: "2026-06-15T12:00:05Z",
          test: false,
        },
      },
      "wh-upgrade",
    );

    // 2. … and cancels the pro subscription it replaced. Webhooks are not
    //    ordered, so this one can land second.
    await deliver(
      {
        app_subscription: {
          admin_graphql_api_id: "gid://shopify/AppSubscription/1",
          name: "pro-monthly",
          status: "CANCELLED",
          created_at: "2026-06-01T12:00:00Z",
          test: false,
        },
      },
      "wh-replaced",
    );

    const entitlements = await inAlpha(() => loadEntitlements());
    expect(
      entitlements.effectivePlan,
      "a paying merchant was dropped to Free by the cancellation of the subscription they upgraded away from",
    ).toBe("growth");
  });
});

/* ── F5 ─────────────────────────────────────────────────────────────────── */

describe("F5 — an empty billing response does not cancel a live subscription", () => {
  it("keeps the cached plan when Shopify returns no subscriptions", async () => {
    await installShop(ALPHA, {
      planKey: "growth",
      billingStatus: "PAST_DUE",
      billingInterval: "monthly",
      graceEndsAt: new Date("2026-06-20T12:00:00Z"),
    });

    // Shopify's `billing.check` filters by name and by the test flag. A frozen
    // subscription, a renamed plan id or a flipped SHOPIFY_BILLING_TEST_MODE
    // all produce the same thing: an empty list.
    const billing = { check: vi.fn(async () => ({ appSubscriptions: [] })) };
    await inAlpha(() => syncSubscription(billing, new Date("2026-06-16T12:00:00Z")));

    const row = await inAlpha(() =>
      db.shop.findUniqueOrThrow({ where: { shop: ALPHA } }),
    );
    expect(
      row.graceEndsAt,
      "the 7-day grace period was erased by one page load of /app/plans",
    ).not.toBeNull();
    expect(row.planKey).toBe("growth");
  });
});

/* ── F6 ─────────────────────────────────────────────────────────────────── */

describe("F6 — the quota cannot be crossed by two concurrent creates", () => {
  it("allows exactly one form on Free when two requests arrive together", async () => {
    // The race window is between the `count()` in createForm and the insert.
    // It is narrow, so this tries ten times and reports the worst outcome —
    // a quota that can be crossed at all is a quota that will be crossed.
    const counts: number[] = [];

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await resetDatabase();
      await installShop(ALPHA);
      await inAlpha(() =>
        Promise.allSettled([
          createForm(formInput({ slug: `a${attempt}` }), actor),
          createForm(formInput({ slug: `b${attempt}` }), actor),
        ]),
      );
      counts.push(await inAlpha(() => db.registrationForm.count()));
    }

    expect(
      Math.max(...counts),
      `two concurrent creates both passed the same count check (per-attempt totals: ${counts.join(", ")})`,
    ).toBe(1);
  });
});

/* ── F10 (expected to PASS — evidence tenancy holds) ─────────────────────── */

describe("F10 — one shop cannot read or change another's entitlements", () => {
  it("answers for the tenant making the request, and refuses a foreign id", async () => {
    const BETA = "beta.myshopify.com";
    await installShop(ALPHA);
    await installShop(BETA, { planKey: "agentic", billingStatus: "ACTIVE" });

    const seen = await inAlpha(() => loadEntitlements());
    expect(seen.effectivePlan).toBe("free");

    await expect(
      inAlpha(() => db.shop.findUniqueOrThrow({ where: { shop: BETA } })),
    ).rejects.toThrow(/Cross-tenant/);

    await expect(
      inAlpha(() =>
        db.shop.update({ where: { shop: BETA }, data: { planKey: "free" } }),
      ),
    ).rejects.toThrow(/Cross-tenant/);
  });
});

/* ── F11 ─────────────────────────────────────────────────────────────────── */

describe("F11 — the cached plan is reconciled against Shopify", () => {
  it("has a caller for the staleness check the ADR describes", async () => {
    const { execSync } = await import("node:child_process");
    const callers = execSync(
      "grep -rln 'syncSubscriptionIfStale' app --include=*.ts --include=*.tsx " +
        "| grep -v 'lib/billing/subscription.server.ts' || true",
      { encoding: "utf8" },
    ).trim();

    expect(
      callers,
      "ADR 0005 lists a one-hour staleness check on ordinary page loads as one of " +
        "three freshness mechanisms; nothing calls it, so a missed webhook is never repaired",
    ).not.toBe("");
  });
});
