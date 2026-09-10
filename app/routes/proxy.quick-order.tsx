import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { db } from "~/db.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { parsePasteList, wasTruncated } from "~/lib/storefront/paste-list";
import { withProxy } from "~/lib/storefront/proxy.server";
import { buyerFacts, priceQuickOrder } from "~/lib/storefront/quick-order.server";
import { unauthenticated } from "~/shopify.server";

/**
 * Pricing a pasted list, for the storefront quick-order block.
 *
 * Reached at `/apps/mannon/quick-order` on the merchant's own domain, through
 * Shopify's App Proxy. Three things make it safe to answer:
 *
 * - the request is signed, so `logged_in_customer_id` is Shopify's word, not
 *   the browser's;
 * - the tenant scope is opened from the signed shop before any query runs;
 * - prices come from `packages/pricing-engine`, the same module the checkout
 *   Function runs, so nothing here can quote a price checkout will not honour.
 */

/** A paste longer than this is not read at all. */
const MAX_BYTES = 64 * 1024;

export const action = ({ request }: ActionFunctionArgs) =>
  withProxy(request, async (context) => {
    if (request.method !== "POST") {
      throw new Response("Method not allowed", { status: 405 });
    }

    const entitlements = await loadEntitlements();
    if (!hasFeature(entitlements, "quick_order")) {
      // The block is on the merchant's theme; the plan says whether it works.
      // A buyer sees the fallback link rather than an error.
      return json({ ok: false as const, reason: "not_available" }, { status: 402 });
    }

    const form = await request.formData();
    const text = (form.get("list") ?? "").toString();

    if (text.length > MAX_BYTES) {
      return json({ ok: false as const, reason: "too_long" }, { status: 413 });
    }

    const defaultQuantity = Number(form.get("defaultQuantity") ?? 1) || 1;
    const parsed = parsePasteList(text, { defaultQuantity });

    if (parsed.lines.length === 0) {
      return json({
        ok: true as const,
        lines: [],
        unresolved: [],
        issues: parsed.issues,
        truncated: wasTruncated(text),
        subtotal: "",
        subtotalAmount: 0,
        currencyCode: "",
      });
    }

    const record = await db.shop.findUnique({ where: { shop: context.shop } });
    const { admin } = await unauthenticated.admin(context.shop);

    const priced = await priceQuickOrder(
      admin,
      parsed.lines,
      await buyerFacts(context.customerId),
      {
        now: new Date(),
        currencyCode: record?.currencyCode ?? "USD",
        locale: context.locale ?? undefined,
      },
    );

    return json({
      ok: true as const,
      ...priced,
      issues: parsed.issues,
      truncated: wasTruncated(text),
    });
  });

/** A GET here is a mistake, not a price request. Said plainly. */
export const loader = () => {
  throw new Response("Post a list to this address", { status: 405 });
};
