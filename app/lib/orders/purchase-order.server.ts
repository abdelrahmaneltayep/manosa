import {
  formatMoney,
  money,
  multiplyMoney,
  parseMoney,
  subtractMoney,
  type Money,
} from "@mannon/pricing-engine";

import type { PoLine } from "~/lib/ai/prompts/purchase-order.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { activeEngineRules } from "~/lib/pricing/rules.server";
import {
  searchVariantsResult,
  VARIANT_SEARCH_LIMIT,
  type VariantMatch,
} from "~/lib/quotes/admin-graphql.server";
import { priceLine, type BuyerForPricing } from "~/lib/quotes/pricing.server";

/**
 * Matching a purchase order's lines to this catalogue, and pricing them.
 *
 * Two rules from the checklist, both load-bearing:
 *
 * - **"Totals always recomputed from Mannon rules — never trust the PO's own
 *   prices."** The price on every line comes from `priceLine`, which is the
 *   engine. The document's own figure is carried only to show the difference,
 *   and is never charged.
 * - **"Unmatched lines listed, never dropped silently."** A line that matches
 *   nothing, or matches two things, comes back as its own row for the merchant
 *   to resolve. Nothing is quietly left out of the order.
 */

/** A line's match, and how sure the catalogue is about it. */
export type MatchConfidence = "exact" | "likely" | "ambiguous" | "none" | "unchecked";

export interface MatchedPoLine {
  /** Position in the document, so the screen can point back at it. */
  index: number;
  requested: PoLine;
  confidence: MatchConfidence;
  /** The chosen variant. Null for ambiguous and unmatched lines. */
  variant: VariantMatch | null;
  /** What the merchant picks between, for an ambiguous line. */
  candidates: VariantMatch[];
  /** The contract price, from the engine. Null when nothing is matched. */
  unitPrice: Money | null;
  lineTotal: Money | null;
  /** What the document claimed, when it claimed anything. */
  statedPrice: Money | null;
  /** contract − stated. Positive means the PO is under-priced. */
  priceDelta: Money | null;
  ruleSummary: string | null;
}

export interface MatchedPo {
  lines: MatchedPoLine[];
  /** Sum of every line the engine could price. */
  subtotal: Money;
  currencyCode: string;
  /** Lines needing the merchant before this can become an order. */
  needsAttention: number;
}

/**
 * An exact SKU match, case-insensitively.
 *
 * Shopify's search is a prefix/substring search, so "MUG" also returns
 * "MUG-BLUE-L". An exact SKU is not a guess and must not be treated as one.
 */
function exactSku(sku: string, matches: readonly VariantMatch[]): VariantMatch | null {
  const wanted = sku.trim().toLowerCase();
  const hits = matches.filter(
    (match) => (match.sku ?? "").trim().toLowerCase() === wanted,
  );
  return hits.length === 1 ? hits[0]! : null;
}

export interface MatchOptions {
  buyer: BuyerForPricing;
  currencyCode: string;
  now: Date;
  /**
   * The merchant's answers to ambiguous lines: line index → variant id.
   *
   * Applied here, not in the view. Applying it only to what was rendered meant
   * a line the merchant had resolved was shown as an exact match and then left
   * off the order — the screen said one thing and the draft order did another.
   */
  chosen?: Readonly<Record<string, string>>;
}

/**
 * Match and price every line.
 *
 * One catalogue search per line. A PO is tens of lines, not thousands — and the
 * alternative, one search for everything, cannot tell which result belongs to
 * which line, which is exactly the mistake that puts the wrong product on an
 * order.
 */
export async function matchPurchaseOrder(
  admin: AdminGraphql,
  poLines: readonly PoLine[],
  options: MatchOptions,
): Promise<MatchedPo> {
  const { rules } = await activeEngineRules();
  const lines: MatchedPoLine[] = [];
  let subtotal = 0;

  for (const [index, requested] of poLines.entries()) {
    const term = requested.sku ?? requested.description ?? "";

    // A throttle or an outage answers with the same empty list as "nothing
    // matched", and printing "nothing in your catalogue matched this line"
    // would be a claim about the merchant's catalogue we have no basis for.
    const search = await searchVariantsResult(admin, term, VARIANT_SEARCH_LIMIT);
    const matches = search.matches;

    if (!search.ok) {
      lines.push({
        index,
        requested,
        confidence: "unchecked",
        variant: null,
        candidates: [],
        unitPrice: null,
        lineTotal: null,
        statedPrice: readStated(requested.statedPrice, options.currencyCode),
        priceDelta: null,
        ruleSummary: null,
      });
      continue;
    }

    // What the merchant picked wins over anything the catalogue guessed.
    const picked = options.chosen?.[String(index)]
      ? (matches.find((match) => match.id === options.chosen?.[String(index)]) ?? null)
      : null;

    const exact = requested.sku ? exactSku(requested.sku, matches) : null;
    const only = matches.length === 1 ? matches[0]! : null;
    const chosen = picked ?? exact ?? only;

    const confidence: MatchConfidence = picked
      ? "exact"
      : exact
        ? "exact"
        : only
          ? "likely"
          : matches.length > 1
            ? "ambiguous"
            : "none";

    const stated = readStated(requested.statedPrice, options.currencyCode);

    if (!chosen) {
      lines.push({
        index,
        requested,
        confidence,
        variant: null,
        candidates: matches,
        unitPrice: null,
        lineTotal: null,
        statedPrice: stated,
        priceDelta: null,
        ruleSummary: null,
      });
      continue;
    }

    const listPrice = readStated(chosen.price, options.currencyCode);
    if (!listPrice) {
      // A variant whose price we cannot read is not one we can put a number
      // against. Listed, not dropped.
      lines.push({
        index,
        requested,
        confidence: "none",
        variant: chosen,
        candidates: matches,
        unitPrice: null,
        lineTotal: null,
        statedPrice: stated,
        priceDelta: null,
        ruleSummary: null,
      });
      continue;
    }

    const priced = priceLine(
      {
        variantId: chosen.id,
        productId: chosen.productId,
        title: chosen.title,
        sku: chosen.sku,
        quantity: requested.quantity,
        listPrice,
        // Carried on the match, from the same metafield checkout reads: a PO
        // priced without it puts a number on the draft order that the buyer
        // will not be charged.
        collectionIds: chosen.collectionIds,
      },
      options.buyer,
      rules,
      { now: options.now, currencyCode: options.currencyCode },
    );

    // Through the engine, which refuses a fractional or unsafe quantity — the
    // guard that a hand-built `{ amount, currencyCode }` walks straight past.
    const lineTotal = multiplyMoney(priced.unitPrice, requested.quantity);
    subtotal += lineTotal.amount;

    lines.push({
      index,
      requested,
      confidence,
      variant: chosen,
      candidates: matches,
      unitPrice: priced.unitPrice,
      lineTotal,
      statedPrice: stated,
      // Shown, never applied. "PO says $4.00, contract price is $4.10".
      priceDelta: stated ? subtractMoney(priced.unitPrice, stated) : null,
      ruleSummary: priced.ruleSummary,
    });
  }

  return {
    lines,
    subtotal: money(subtotal, options.currencyCode),
    currencyCode: options.currencyCode,
    needsAttention: lines.filter((line) => line.confidence !== "exact").length,
  };
}

function readStated(value: string | null, currencyCode: string): Money | null {
  if (!value) return null;
  try {
    return parseMoney(value, currencyCode);
  } catch {
    return null;
  }
}

/** The lines that can go on a draft order: matched, priced, nothing pending. */
export function orderableLines(matched: MatchedPo) {
  return matched.lines.flatMap((line) =>
    line.variant && line.unitPrice
      ? [
          {
            variantId: line.variant.id,
            quantity: line.requested.quantity,
            unitPrice: line.unitPrice.amount,
            currencyCode: line.unitPrice.currencyCode,
            unitPriceDecimal: formatMoney(line.unitPrice),
          },
        ]
      : [],
  );
}
