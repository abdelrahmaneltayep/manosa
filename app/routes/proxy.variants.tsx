import { money } from "@mannon/pricing-engine";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { db } from "~/db.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { formatCurrency } from "~/lib/money";
import {
  fetchProductCollections,
  ruleUsesCollections,
} from "~/lib/pricing/product-collections.server";
import { activeEngineRules } from "~/lib/pricing/rules.server";
import { priceLine } from "~/lib/quotes/pricing.server";
import { withProxy } from "~/lib/storefront/proxy.server";
import { buyerFacts } from "~/lib/storefront/quick-order.server";
import { unauthenticated } from "~/shopify.server";

/**
 * Wholesale prices for the variants already on a product page.
 *
 * The theme knows its own variants and their list prices — it rendered them.
 * What it cannot know is what *this* buyer pays, because that comes from the
 * pricing engine. So the block sends the variant ids and their list prices and
 * gets back the buyer's price for each, plus the next volume break.
 *
 * List prices come from the theme rather than being looked up here on purpose:
 * it saves an Admin API call on a page a buyer is waiting for, and a price the
 * theme is already showing is not a secret. The buyer's price is computed here,
 * where the rules are.
 */

/** As many variants as a product page reasonably has. */
const MAX_VARIANTS = 100;

interface Requested {
  variantId: string;
  productId: string | null;
  /**
   * The list price in integer minor units.
   *
   * Liquid's `variant.price` is already in the currency's subunit, so it
   * arrives that way and needs no decimal round-trip — which would be wrong in
   * every three-decimal currency.
   */
  priceMinor: number;
}

function readVariants(raw: string | null): Requested[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .slice(0, MAX_VARIANTS)
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => typeof entry.variantId === "string")
      .map((entry) => {
        const price = Number(entry.priceMinor);
        return {
          variantId: entry.variantId as string,
          productId: typeof entry.productId === "string" ? entry.productId : null,
          // A price we cannot read becomes zero, which shows as a wrong number
          // rather than a silently mis-scaled one.
          priceMinor: Number.isSafeInteger(price) && price >= 0 ? price : 0,
        };
      });
  } catch {
    // A malformed payload gets an empty answer, not a 500: the block falls
    // back to the theme's own prices, which is what a buyer already sees.
    return [];
  }
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  withProxy(request, async (context) => {
    const entitlements = await loadEntitlements();
    if (!hasFeature(entitlements, "quick_order")) {
      return json({ ok: false as const, reason: "not_available" }, { status: 402 });
    }

    const url = new URL(request.url);
    const requested = readVariants(url.searchParams.get("variants"));
    if (requested.length === 0) return json({ ok: true as const, variants: [] });

    const record = await db.shop.findUnique({ where: { shop: context.shop } });
    const currencyCode = record?.currencyCode ?? "USD";
    const quantity = Math.max(1, Number(url.searchParams.get("quantity") ?? 1) || 1);
    const locale = context.locale ?? undefined;

    const [buyer, { rules }] = await Promise.all([
      buyerFacts(context.customerId),
      activeEngineRules(),
    ]);

    // The theme sends ids and list prices; it cannot send collection
    // membership as checkout sees it, and Liquid's own `product.collections`
    // would be a *second* answer that disagrees with the Function the moment
    // one of them lags. One batched read of the same metafield the Function
    // reads — usually one product — so the block and checkout cannot differ.
    // Only when a rule actually turns on collections: a store with none pays
    // nothing for this.
    const needsCollections = rules.some(ruleUsesCollections);
    const collections = needsCollections
      ? await fetchProductCollections(
          (await unauthenticated.admin(context.shop)).admin,
          requested.map((entry) => entry.productId ?? ""),
        )
      : new Map<string, string[]>();

    const variants = requested.map((entry) => {
      const listPrice = money(entry.priceMinor, currencyCode);

      const priced = priceLine(
        {
          variantId: entry.variantId,
          productId: entry.productId,
          title: "",
          quantity,
          listPrice,
          collectionIds: collections.get(entry.productId ?? "") ?? [],
        },
        buyer,
        rules,
        { now: new Date(), currencyCode },
      );

      return {
        variantId: entry.variantId,
        unitPrice: formatCurrency(priced.unitPrice, locale),
        // Only when it differs — a "was" price equal to the "now" price is
        // a strikethrough that says nothing — and only when the merchant
        // wants it shown at all. Settings offers "Off if your trade buyers
        // should never see the retail price", and this block used to send it
        // regardless, so that setting promised something it never did.
        wasPrice:
          !record?.showCompareAt || priced.unitPrice.amount === listPrice.amount
            ? null
            : formatCurrency(listPrice, locale),
        // Which rule did it. A price a buyer cannot account for is one they
        // will email about.
        ruleSummary: priced.ruleSummary,
      };
    });

    return json(
      {
        ok: true as const,
        variants,
        quantity,
        // Settings → "Show prices as". Display only: Shopify still decides
        // what is charged. Sent here because a setting about what a buyer
        // reads has to reach the thing the buyer reads.
        taxDisplay: record?.taxDisplay === "incl" ? ("incl" as const) : ("excl" as const),
      },
      {
        // A buyer's own prices, so never a shared cache. Briefly private-cached
        // so paging through variants does not re-ask on every keystroke.
        headers: { "Cache-Control": "private, max-age=30" },
      },
    );
  });
